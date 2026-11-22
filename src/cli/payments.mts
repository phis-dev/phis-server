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
import { validatePhisPaymentProfileDraft, validatePhisPaymentProviderProbe, requirePhisPaymentCurrency, PhisPaymentError } from "../lib/payments/validation.ts";
import { phisPaymentReachProbe } from "../lib/payments/reach.ts";
import { reconcilePhisPayments } from "../lib/payments/recovery.ts";
import { PHIS_PAYMENT_CALL_TIMEOUT_MS, PHIS_PAYMENT_INSTANCE_STALE_SECONDS } from "../lib/constants/payments.ts";
import { PHIS_ADDON_FLAG_GLOBALLY_ENABLED, PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "../lib/constants/server-addons.ts";
import {
  listActivePhisPaymentProfilesOfProvider, listPhisPaymentProfiles, readPhisPaymentProfile, writePhisPaymentProfile, recordPhisPaymentProfileProbe,
  setPhisPaymentProfileEnabled,
} from "../db/payments.mts";
import type { PhisPaymentProfile } from "../lib/payments/types.ts";

type Flags = Map<string, string | boolean>;
type SecretReader = (reference: string) => Promise<string | null>;
function flag(flags: Flags, key: string) {
  const value = flags.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}.`);
  return value.trim();
}

/**
 * The currencies `--currency` names, comma-separated (`CHF,EUR`): at least one, each once. There is no
 * default: a profile is recorded in the currencies it is asked in, and which those are is the operator's.
 */
function readCurrencies(flags: Flags) {
  const named = flag(flags, "currency").split(",").map(entry => entry.trim());
  for (const currency of named) {
    try { requirePhisPaymentCurrency(currency); }
    catch { throw new Error(`--currency names "${currency}", which is not an uppercase ISO currency a payment accepts.`); }
  }
  if (new Set(named).size !== named.length) throw new Error("--currency names a currency twice.");
  return named;
}

/** What the Provider answers in one currency when Core records the profile there (`phisPaymentReachProbe`). */
async function probeCurrency(adapter: Awaited<ReturnType<typeof resolvePaymentProvider>>, profile: PhisPaymentProfile, currency: string) {
  return validatePhisPaymentProviderProbe(await adapter.probe({ ...phisPaymentReachProbe(currency), signal: AbortSignal.timeout(PHIS_PAYMENT_CALL_TIMEOUT_MS) }), profile);
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
  const currencies = readCurrencies(flags);
  const adapter = await resolvePaymentProvider(root, pool, profile, selectedSite.key, readSecret);
  // Every currency is asked before any is recorded, so a refusal in one leaves the recording as it was.
  const probes: { currency: string; probe: Awaited<ReturnType<typeof probeCurrency>> }[] = [];
  for (const currency of currencies) {
    const probe = await probeCurrency(adapter, profile, currency);
    if (probe.methods.length === 0) throw new PhisPaymentError("method_unavailable", `The Payment Provider offers no method in ${currency}.`);
    if (probes.some(previous => previous.probe.merchantIdentity !== probe.merchantIdentity)) throw new PhisPaymentError("profile_unavailable", "The Payment Provider answered for another merchant.");
    probes.push({ currency, probe });
  }
  // Recorded beside what other currencies hold; a currency not named keeps its recording.
  for (const { currency, probe } of probes) await recordPhisPaymentProfileProbe(pool, profile, probe.merchantIdentity, probe.mode, currency, probe.methods);
  if (command === "enable") {
    const instances = (await listPhisServerInstances(pool, PHIS_PAYMENT_INSTANCE_STALE_SECONDS)).filter(i => i.ready);
    const version = readAddonDesiredState(root).addons.find(a => a.addonId === profile.providerAddonId)!.packageVersion;
    const required = PHIS_CORE_CAPABILITIES.filter(c => ["@phis/server/payments:v1", "@phis/server/payment-notifications:v1"].includes(c.id));
    if (instances.length === 0 || instances.some(i => i.addonPackages[profile.providerAddonId] !== version
      || required.some(c => i.capabilityDigests[c.id] !== c.interfaceDigest))) throw new PhisPaymentError("profile_unavailable", "Payment Provider or Core is not ready on every serving instance.");
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, selectedSite.id, key))!, true);
  }
  return { profile: await readPhisPaymentProfile(pool, selectedSite.id, key), methods: Object.fromEntries(probes.map(({ currency, probe }) => [currency, probe.methods])) };
}

function providesPayments(manifest: PhisAddonManifestV1) {
  return manifest.serviceProviders.some(p => p.serviceKind === PHIS_SERVICE_KINDS.payments);
}

/**
 * The manifest each installed payment Provider Add-on is registered with now. Read before a command that
 * may register another (`addon migrate`, `addon reconcile`), and handed to `reprobeUpgradedPhisPaymentProviders`
 * after it.
 */
export async function readPhisPaymentProviderRegistrations(root: string, pool: Pool): Promise<ReadonlyMap<string, string>> {
  const ids = readAddonDesiredState(root).addons.filter(addon => providesPayments(addon.manifest)).map(addon => addon.addonId);
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<{ addon_id: string; manifest_digest: string }>(
    "SELECT addon_id, manifest_digest FROM phis.server_addons WHERE addon_id = ANY($1::text[])", [ids]);
  return new Map(rows.map(row => [row.addon_id, row.manifest_digest]));
}

export type PhisPaymentReprobe = {
  reprobed: { site: string; profileKey: string; currency: string }[];
  warnings: { site: string; profileKey: string; currency: string | null; message: string }[];
};

/**
 * After a new release of a payment Provider Add-on was registered: every enabled profile it serves is
 * asked again in each currency it was last recorded in, so what a consumer reads of its reach is what the
 * release in place says. A profile or currency that cannot be asked keeps its recording and is reported;
 * nothing here undoes or stops the command that registered the release, which has already happened.
 *
 * `before` is what `readPhisPaymentProviderRegistrations` read ahead of that command. A Provider whose
 * registration did not change there is not asked, and neither is one registered for the first time,
 * which has no profile yet.
 */
export async function reprobeUpgradedPhisPaymentProviders(root: string, pool: Pool, before: ReadonlyMap<string, string>, readSecret: SecretReader): Promise<PhisPaymentReprobe> {
  const result: PhisPaymentReprobe = { reprobed: [], warnings: [] };
  const upgraded = readAddonDesiredState(root).addons
    .filter(addon => providesPayments(addon.manifest) && before.has(addon.addonId) && before.get(addon.addonId) !== addon.manifestDigest);
  if (upgraded.length === 0) return result;
  const now = await readPhisPaymentProviderRegistrations(root, pool);
  const failure = (error: unknown) => error instanceof PhisPaymentError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
  for (const addon of upgraded) {
    // Registered by this command, or not: one still at its previous release is asked after the command that registers it.
    if (now.get(addon.addonId) !== addon.manifestDigest) continue;
    for (const { siteKey, profile } of await listActivePhisPaymentProfilesOfProvider(pool, addon.addonId)) {
      let adapter;
      try { adapter = await resolvePaymentProvider(root, pool, profile, siteKey, readSecret); }
      catch (error) { result.warnings.push({ site: siteKey, profileKey: profile.key, currency: null, message: failure(error) }); continue; }
      for (const currency of Object.keys(profile.methods ?? {})) {
        try {
          const probe = await probeCurrency(adapter, profile, currency);
          await recordPhisPaymentProfileProbe(pool, profile, probe.merchantIdentity, probe.mode, currency, probe.methods);
          result.reprobed.push({ site: siteKey, profileKey: profile.key, currency });
        } catch (error) {
          result.warnings.push({ site: siteKey, profileKey: profile.key, currency, message: failure(error) });
        }
      }
    }
  }
  return result;
}

/** `phis maintain --task payments`: the shared reconciliation, reaching the Provider the way this process can. */
export async function recoverPhisPayments(root: string, pool: Pool, readSecret: SecretReader, dryRun: boolean) {
  const { cleared, detail } = await reconcilePhisPayments({
    pool, dryRun, resolveProvider: (profile, siteKey) => resolvePaymentProvider(root, pool, profile, siteKey, readSecret),
  });
  return { cleared, detail };
}
