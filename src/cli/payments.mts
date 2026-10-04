import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import { PHIS_SERVICE_INTERFACE_DIGESTS, PHIS_SERVICE_KINDS } from "@phis/contracts/addon";
import { listPhisServerInstances } from "../db/server-instances.mts";
import { PHIS_CORE_CAPABILITIES } from "../lib/addons/core-capabilities.ts";
import { readAddonDesiredState, loadInstalledAddonRuntime } from "./addons.mts";
import { digestPhisAddonManifest } from "../lib/addons/manifest.ts";
import { createPhisPaymentProvider } from "../lib/payments/provider.ts";
import { validatePhisPaymentProfileDraft, validatePhisPaymentProviderProbe, validatePhisPaymentMoney, PhisPaymentError } from "../lib/payments/validation.ts";
import { PhisPaymentEngine } from "../lib/payments/engine.ts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_RECOVERY_LIMIT, PHIS_PAYMENT_INSTANCE_STALE_SECONDS } from "../lib/constants/payments.ts";
import { PHIS_ADDON_FLAG_GLOBALLY_ENABLED, PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "../lib/constants/server-addons.ts";
import {
  listPhisPaymentProfiles, readPhisPaymentProfile, writePhisPaymentProfile, recordPhisPaymentProfileProbe,
  setPhisPaymentProfileEnabled, listPhisPaymentRecoveryCandidates, readPhisPayment,
} from "../db/payments.mts";
import type { PhisPaymentProfile } from "../lib/payments/types.ts";

type Flags = Map<string, string | boolean>;
type SecretReader = (reference: string) => Promise<string | null>;
function flag(flags: Flags, key: string) {
  const value = flags.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}.`);
  return value.trim();
}

async function site(pool: Pool, key: string) {
  const row = (await pool.query<{ id: number; key: string; public_base_url: string }>("SELECT id, key, public_base_url FROM phis.sites WHERE key = $1", [key])).rows[0];
  if (!row) throw new Error("Payment Site does not exist.");
  return row;
}

async function resolvePaymentProvider(root: string, pool: Pool, profile: PhisPaymentProfile, siteKey: string, readSecret: SecretReader) {
  const installed = readAddonDesiredState(root).addons.find(a => a.addonId === profile.providerAddonId);
  const descriptor = installed?.manifest.serviceProviders.find(p => p.serviceKind === PHIS_SERVICE_KINDS.payments && p.providerKey === profile.providerKey);
  if (!installed?.enabled || !descriptor || descriptor.interfaceDigest !== PHIS_SERVICE_INTERFACE_DIGESTS[PHIS_SERVICE_KINDS.payments]) throw new PhisPaymentError("profile_unavailable");
  const state = (await pool.query<{ flags: number; site_flags: number; configuration_status: string; manifest_digest: string; migration_version: number }>(
    `SELECT a.flags, a.manifest_digest, a.migration_version, s.flags AS site_flags, s.configuration_status
     FROM phis.server_addons a JOIN phis.site_server_addons s ON s.addon_id = a.addon_id
     WHERE a.addon_id = $1 AND s.site_id = $2`, [installed.addonId, profile.siteId])).rows[0];
  if (!state || !(state.flags & PHIS_ADDON_FLAG_GLOBALLY_ENABLED) || !(state.site_flags & PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED)
    || state.configuration_status !== "ready" || state.manifest_digest !== installed.manifestDigest
    || state.migration_version < installed.manifest.migrationVersion) throw new PhisPaymentError("profile_unavailable");
  const { runtime } = await loadInstalledAddonRuntime(root, installed.addonId);
  if (digestPhisAddonManifest(runtime.manifest as PhisAddonManifestV1) !== installed.manifestDigest) throw new PhisPaymentError("profile_unavailable");
  const factory = runtime.serviceFactories?.[descriptor.factoryExport];
  if (!factory) throw new PhisPaymentError("profile_unavailable");
  return createPhisPaymentProvider(factory, profile, siteKey, readSecret);
}

export async function runPhisPaymentProfileCommand(root: string, pool: Pool, command: string, flags: Flags, readSecret: SecretReader) {
  const selectedSite = await site(pool, flag(flags, "site").toLowerCase());
  if (command === "list") return { profiles: await listPhisPaymentProfiles(pool, selectedSite.id) };
  if (command === "add" || command === "set") {
    const draft: unknown = JSON.parse(readFileSync(path.resolve(root, flag(flags, "file")), "utf8"));
    const manifests = Object.fromEntries(readAddonDesiredState(root).addons.map(a => [a.addonId, a.manifest]));
    const providerKey = draft && typeof draft === "object" && "providerKey" in draft ? draft.providerKey : null;
    const provider = Object.values(manifests).find(m => m.serviceProviders.some(p => p.serviceKind === PHIS_SERVICE_KINDS.payments && p.providerKey === providerKey));
    if (!provider) throw new PhisPaymentError("profile_unavailable");
    const valid = validatePhisPaymentProfileDraft(draft, selectedSite.key, provider, manifests);
    const profile = await writePhisPaymentProfile(pool, selectedSite.id, provider.addonId, valid, command === "set");
    return { profile };
  }
  const key = flag(flags, "key");
  const profile = await readPhisPaymentProfile(pool, selectedSite.id, key);
  if (!profile) throw new PhisPaymentError("not_found");
  if (command === "retire") {
    await setPhisPaymentProfileEnabled(pool, profile, false, true);
    return { profile: await readPhisPaymentProfile(pool, selectedSite.id, key) };
  }
  if (command !== "probe" && command !== "enable") throw new Error("Use payment profile list, add, set, probe, enable or retire.");
  const adapter = await resolvePaymentProvider(root, pool, profile, selectedSite.key, readSecret);
  const currency = typeof flags.get("currency") === "string" ? flag(flags, "currency") : "CHF";
  validatePhisPaymentMoney({ currency, minor: "100" });
  const probe = validatePhisPaymentProviderProbe(await adapter.probe({ amount: { currency, minor: "100" }, captureMode: "automatic", checkoutKind: "redirect", signal: AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS) }), profile);
  if (probe.methods.length === 0) throw new PhisPaymentError("method_unavailable");
  await recordPhisPaymentProfileProbe(pool, profile, probe.merchantIdentity, probe.mode, probe.methods);
  if (command === "enable") {
    const instances = (await listPhisServerInstances(pool, PHIS_PAYMENT_INSTANCE_STALE_SECONDS)).filter(i => i.ready);
    const version = readAddonDesiredState(root).addons.find(a => a.addonId === profile.providerAddonId)!.packageVersion;
    const required = PHIS_CORE_CAPABILITIES.filter(c => ["@phis/server/payments:v1", "@phis/server/payment-notifications:v1"].includes(c.id));
    if (instances.length === 0 || instances.some(i => i.addonPackages[profile.providerAddonId] !== version
      || required.some(c => i.capabilityDigests[c.id] !== c.interfaceDigest))) throw new PhisPaymentError("profile_unavailable", "Payment Provider or Core is not ready on every serving instance.");
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, selectedSite.id, key))!, true);
  }
  return { profile: await readPhisPaymentProfile(pool, selectedSite.id, key), methods: probe.methods };
}

export async function recoverPhisPayments(root: string, pool: Pool, readSecret: SecretReader, dryRun: boolean) {
  const candidates = await listPhisPaymentRecoveryCandidates(pool, PHIS_PAYMENT_RECOVERY_LIMIT);
  if (dryRun) return { cleared: 0, detail: `${candidates.length} payment(s) selected for bounded reconciliation; no Provider calls made.` };
  let reconciled = 0; let unavailable = 0;
  for (const candidate of candidates) {
    try {
      const payment = (await readPhisPayment(pool, candidate.site_id, candidate.id))!;
      const profile = (await readPhisPaymentProfile(pool, candidate.site_id, payment.record.profileKey))!;
      if (!profile) throw new PhisPaymentError("profile_unavailable");
      const engine = new PhisPaymentEngine({ pool, scope: { siteId: candidate.site_id, siteKey: candidate.key, consumerAddonId: candidate.consumer_addon_id },
        signal: AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS), publicBaseUrl: async () => { throw new PhisPaymentError("forbidden"); },
        resolveProvider: profile => resolvePaymentProvider(root, pool, profile, candidate.key, readSecret), merchantAuthorized: async () => false });
      await engine.reconcile(payment, profile); reconciled += 1;
    } catch { unavailable += 1; }
  }
  return { cleared: reconciled, detail: `${reconciled} reconciled; ${unavailable} unavailable or concurrently claimed (limit ${PHIS_PAYMENT_RECOVERY_LIMIT}).` };
}
