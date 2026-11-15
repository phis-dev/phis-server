import type { Pool } from "pg";
import { PHIS_ENTITLEMENT_CORE_SOURCE, type PhisEntitlement, type PhisEntitlementKindId } from "@phis/contracts/entitlements";
import {
  allowEntitlementSource, disallowEntitlementSource, ensureEntitlementSubject, findEntitlementSubject, grantEntitlement, listEntitlementKindSources,
  listEntitlements, updateEntitlement,
} from "../db/entitlements.mts";
import { isPhiSiteMember } from "../db/server-addon-owner.mts";
import {
  isPhisEntitlementKindId, listEntitlementKindsOf, listEntitlementListenersOf, type PhisInstalledManifestEntries,
} from "../lib/addons/entitlement-catalogue.ts";
import { PHIS_ADDON_ID_PATTERN } from "../lib/addons/schema-name.ts";
import { readAddonDesiredState } from "./addons.mts";

type Flags = Map<string, string | boolean>;

const REFERENCE_MAX_LENGTH = 190;
const QUANTITY_MAX = 2_000_000_000;
const USAGE = "Use entitlement kinds, source list|allow|deny, list, grant or revoke.";

function flag(flags: Flags, key: string) {
  const value = flags.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${key}.`);
  return value.trim();
}
function optionalFlag(flags: Flags, key: string) {
  const value = flags.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function site(pool: Pool, key: string) {
  const row = (await pool.query<{ id: number; key: string }>("SELECT id, key FROM phis.sites WHERE key = $1", [key])).rows[0];
  if (!row) throw new Error(`Site ${key} does not exist.`);
  return row;
}

function userId(flags: Flags) {
  const raw = flag(flags, "user");
  const id = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) throw new Error("--user must be a user id.");
  return id;
}

function kindId(flags: Flags) {
  const value = flag(flags, "kind");
  if (!isPhisEntitlementKindId(value)) throw new Error("--kind must be a kind id such as @scope/name:kind.");
  return value;
}

function reference(flags: Flags) {
  const value = flag(flags, "reference");
  if (value.length > REFERENCE_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`--reference is 1 to ${REFERENCE_MAX_LENGTH} characters without control characters.`);
  }
  return value;
}

function describeEntry(entry: PhisEntitlement) {
  return `${entry.kind}  ${entry.source}  ${entry.reference}  ${entry.startsAt} .. ${entry.endsAt ?? "open"}`
    + `  quantity ${entry.quantity ?? "-"}  flags ${entry.flags}  ${entry.valid ? "valid" : "not valid"}`;
}

/** What `phis entitlement ...` does, as data plus the lines to print: the caller chooses between them. */
export async function runPhisEntitlementCommand(root: string, pool: Pool, words: readonly string[], flags: Flags) {
  const selectedSite = await site(pool, flag(flags, "site").toLowerCase());
  const addons = readAddonDesiredState(root).addons;
  const entries: PhisInstalledManifestEntries = Object.fromEntries(addons.map((a) => [a.addonId, { enabled: a.enabled, manifest: a.manifest }]));
  const kinds = listEntitlementKindsOf(entries);
  const [command, subcommand] = words;

  if (command === "kinds") {
    return {
      data: { site: selectedSite.key, kinds },
      lines: kinds.length === 0 ? ["No enabled Add-on declares an entitlement kind."]
        : kinds.map((k) => `${k.id}  ${k.title}  ${k.counted ? "counted" : "not counted"}  declared by ${k.addonId}`),
    };
  }

  if (command === "source") {
    if (subcommand === "list") {
      const sources = await listEntitlementKindSources(pool, selectedSite.id);
      return {
        data: { site: selectedSite.key, sources },
        lines: sources.length === 0 ? [`No kind source is allowed at ${selectedSite.key}.`]
          : sources.map((s) => `${s.kind}  ${s.source}  by ${s.grantedByUserId === null ? "the operator" : `user ${s.grantedByUserId}`}  ${s.grantedAt}`),
      };
    }
    if (subcommand !== "allow" && subcommand !== "deny") throw new Error(USAGE);
    const kind = kindId(flags);
    const source = flag(flags, "source");
    if (subcommand === "allow") {
      if (!kinds.some((k) => k.id === kind)) throw new Error(`No enabled Add-on declares ${kind}.`);
      if (!PHIS_ADDON_ID_PATTERN.test(source) || !addons.some((a) => a.addonId === source)) throw new Error(`${source} is not an installed Add-on id.`);
    }
    const changed = subcommand === "allow"
      ? await allowEntitlementSource(pool, { siteId: selectedSite.id, kind, source, grantedByUserId: null })
      : await disallowEntitlementSource(pool, { siteId: selectedSite.id, kind, source });
    const verb = subcommand === "allow" ? "Allowed" : "Withdrew the leave of";
    return {
      data: { site: selectedSite.key, kind, source, changed },
      lines: [changed ? `${verb} ${source} for ${kind} at ${selectedSite.key}.`
        : `No change: ${source} ${subcommand === "allow" ? "was already allowed" : "was not allowed"} for ${kind}.`],
    };
  }

  if (command === "list") {
    const id = userId(flags);
    const kindFlag = optionalFlag(flags, "kind");
    if (kindFlag !== undefined && !isPhisEntitlementKindId(kindFlag)) throw new Error("--kind must be a kind id such as @scope/name:kind.");
    const subject = await ensureEntitlementSubject(pool, selectedSite.id, id);
    const subjectId = (await findEntitlementSubject(pool, selectedSite.id, subject))!.id;
    const found = await listEntitlements(pool, { siteId: selectedSite.id, subjectId, kind: kindFlag ?? null });
    return {
      data: { site: selectedSite.key, userId: id, subject, entitlements: found },
      lines: found.length === 0 ? [`User ${id} has no entitlements at ${selectedSite.key}.`] : found.map(describeEntry),
    };
  }

  if (command === "grant" || command === "revoke") {
    const kind = kindId(flags);
    const ref = reference(flags);
    const listeners = listEntitlementListenersOf(entries);
    if (command === "revoke") {
      const entry = await updateEntitlement(pool, { siteId: selectedSite.id, source: PHIS_ENTITLEMENT_CORE_SOURCE, kind, reference: ref, revoke: true, listeners });
      return {
        data: { site: selectedSite.key, entitlement: entry },
        lines: [entry ? `Revoked ${kind} ${ref} at ${selectedSite.key}.` : `No entry of ${PHIS_ENTITLEMENT_CORE_SOURCE} for ${kind} with reference ${ref}.`],
      };
    }
    const id = userId(flags);
    const declared = kinds.find((k) => k.id === kind);
    if (!declared) throw new Error(`No enabled Add-on declares ${kind}.`);
    if (!await isPhiSiteMember(pool, selectedSite.id, id)) throw new Error(`User ${id} is not an active member of ${selectedSite.key}.`);
    const quantityFlag = optionalFlag(flags, "quantity");
    let quantity: number | null = null;
    if (!declared.counted) {
      if (quantityFlag !== undefined) throw new Error(`${kind} does not count; an entry of it carries no --quantity.`);
    } else {
      quantity = quantityFlag !== undefined && /^\d+$/.test(quantityFlag) ? Number(quantityFlag) : Number.NaN;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) {
        throw new Error(`${kind} counts; --quantity is a whole number of at least 1.`);
      }
    }
    const endsFlag = optionalFlag(flags, "ends");
    let endsAt: string | null = null;
    if (endsFlag !== undefined) {
      const ends = Date.parse(endsFlag);
      if (Number.isNaN(ends)) throw new Error("--ends must be an ISO instant.");
      if (ends <= Date.now()) throw new Error("--ends must be in the future.");
      endsAt = new Date(ends).toISOString();
    }
    const subject = await ensureEntitlementSubject(pool, selectedSite.id, id);
    const subjectId = (await findEntitlementSubject(pool, selectedSite.id, subject))!.id;
    const entry = await grantEntitlement(pool, { siteId: selectedSite.id, subjectId, kind: kind as PhisEntitlementKindId,
      source: PHIS_ENTITLEMENT_CORE_SOURCE, reference: ref, startsAt: null, endsAt, quantity, listeners });
    return { data: { site: selectedSite.key, userId: id, entitlement: entry }, lines: [`Granted: ${describeEntry(entry)}`] };
  }

  throw new Error(USAGE);
}
