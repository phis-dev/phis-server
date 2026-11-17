import type { Pool } from "pg";
import { PHIS_ENTITLEMENT_CORE_SOURCE, type PhisEntitlement } from "@phis/contracts/entitlements";
import {
  allowEntitlementSource, disallowEntitlementSource, ensureEntitlementSubject, findEntitlementSubject, grantEntitlement, listEntitlementSources,
  listEntitlements, updateEntitlement,
} from "../db/entitlements.mts";
import { readProduct } from "../db/products.mts";
import { isPhiSiteMember } from "../db/server-addon-owner.mts";
import { listEntitlementListenersOf, type PhisInstalledManifestEntries } from "../lib/addons/commerce-listeners.ts";
import { isPhisProductId } from "../lib/addons/product-draft.ts";
import { PHIS_ADDON_ID_PATTERN } from "../lib/addons/schema-name.ts";
import { readAddonDesiredState } from "./addons.mts";

type Flags = Map<string, string | boolean>;

const REFERENCE_MAX_LENGTH = 190;
const QUANTITY_MAX = 2_000_000_000;
const USAGE = "Use entitlement source list|allow|deny, list, grant or revoke. What can be held is listed by phis product list.";

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

/**
 * Refuses a user id nobody holds, in words, before a foreign key does it in the database's. An account
 * is global; the message names the Site because that is where the operator was asking.
 */
async function requireUserAccount(pool: Pool, siteKey: string, id: number) {
  const { rows } = await pool.query(`SELECT 1 FROM phis.user_accounts WHERE id = $1`, [id]);
  if (rows.length === 0) throw new Error(`No such user at ${siteKey}.`);
}

function productId(flags: Flags) {
  const value = flag(flags, "product");
  if (!isPhisProductId(value)) throw new Error("--product must be a product id such as @scope/name:key.");
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
  return `${entry.product}  ${entry.source}  ${entry.reference}  ${entry.startsAt} .. ${entry.endsAt ?? "open"}`
    + (entry.subscriptionId ? `  subscription ${entry.subscriptionId}` : "")
    + `  quantity ${entry.quantity ?? "-"}  flags ${entry.flags}  ${entry.valid ? "valid" : "not valid"}`;
}

/** What `phis entitlement ...` does, as data plus the lines to print: the caller chooses between them. */
export async function runPhisEntitlementCommand(root: string, pool: Pool, words: readonly string[], flags: Flags) {
  const selectedSite = await site(pool, flag(flags, "site").toLowerCase());
  const addons = readAddonDesiredState(root).addons;
  const entries: PhisInstalledManifestEntries = Object.fromEntries(addons.map((a) => [a.addonId, { enabled: a.enabled, manifest: a.manifest }]));
  const [command, subcommand] = words;

  if (command === "source") {
    if (subcommand === "list") {
      const sources = await listEntitlementSources(pool, selectedSite.id);
      return {
        data: { site: selectedSite.key, sources },
        lines: sources.length === 0 ? [`No source is allowed to write entitlements at ${selectedSite.key}.`]
          : sources.map((s) => `${s.source}  ${s.allProducts ? "all products" : `products of ${s.suppliers.join(", ")}`}`
            + `  by ${s.grantedByUserId === null ? "the operator" : `user ${s.grantedByUserId}`}  ${s.grantedAt}`),
      };
    }
    if (subcommand !== "allow" && subcommand !== "deny") throw new Error(USAGE);
    const source = flag(flags, "source");
    if (subcommand === "deny") {
      const changed = await disallowEntitlementSource(pool, { siteId: selectedSite.id, source });
      return {
        data: { site: selectedSite.key, source, changed },
        lines: [changed ? `Withdrew the leave of ${source} at ${selectedSite.key}.` : `No change: ${source} was not allowed.`],
      };
    }
    if (!PHIS_ADDON_ID_PATTERN.test(source) || !addons.some((a) => a.addonId === source)) throw new Error(`${source} is not an installed Add-on id.`);
    const everything = flags.get("all-products") === true;
    const named = optionalFlag(flags, "suppliers");
    if (everything === (named !== undefined)) throw new Error("Pass --all-products, or --suppliers <@scope/name,...> to allow the products of those suppliers only.");
    const suppliers = named === undefined ? null : [...new Set(named.split(",").map((value) => value.trim()))];
    if (suppliers && !suppliers.every((supplier) => PHIS_ADDON_ID_PATTERN.test(supplier))) throw new Error("--suppliers is a comma-separated list of Add-on ids.");
    const changed = await allowEntitlementSource(pool, { siteId: selectedSite.id, source, suppliers, grantedByUserId: null });
    const scope = suppliers === null ? "every product" : `the products of ${suppliers.join(", ")}`;
    return {
      data: { site: selectedSite.key, source, allProducts: suppliers === null, suppliers: suppliers ?? [], changed },
      lines: [changed ? `Allowed ${source} to write entitlements for ${scope} at ${selectedSite.key}.` : `No change: ${source} was already allowed for ${scope}.`],
    };
  }

  if (command === "list") {
    const id = userId(flags);
    const productFlag = optionalFlag(flags, "product");
    if (productFlag !== undefined && !isPhisProductId(productFlag)) throw new Error("--product must be a product id such as @scope/name:key.");
    await requireUserAccount(pool, selectedSite.key, id);
    const subject = await ensureEntitlementSubject(pool, selectedSite.id, id);
    const subjectId = (await findEntitlementSubject(pool, selectedSite.id, subject))!.id;
    const found = await listEntitlements(pool, { siteId: selectedSite.id, subjectId, product: productFlag ?? null });
    return {
      data: { site: selectedSite.key, userId: id, subject, entitlements: found },
      lines: found.length === 0 ? [`User ${id} has no entitlements at ${selectedSite.key}.`] : found.map(describeEntry),
    };
  }

  if (command === "grant" || command === "revoke") {
    const product = productId(flags);
    const ref = reference(flags);
    const listeners = listEntitlementListenersOf(entries);
    if (command === "revoke") {
      const entry = await updateEntitlement(pool, { siteId: selectedSite.id, source: PHIS_ENTITLEMENT_CORE_SOURCE, product, reference: ref, revoke: true, listeners });
      return {
        data: { site: selectedSite.key, entitlement: entry },
        lines: [entry ? `Revoked ${product} ${ref} at ${selectedSite.key}.` : `No entry of ${PHIS_ENTITLEMENT_CORE_SOURCE} for ${product} with reference ${ref}.`],
      };
    }
    const id = userId(flags);
    const held = await readProduct(pool, selectedSite.id, product);
    if (!held) throw new Error(`${selectedSite.key} has no product ${product}; phis product list shows what it has.`);
    await requireUserAccount(pool, selectedSite.key, id);
    if (!await isPhiSiteMember(pool, selectedSite.id, id)) throw new Error(`User ${id} is not an active member of ${selectedSite.key}.`);
    const quantityFlag = optionalFlag(flags, "quantity");
    let quantity: number | null = null;
    if (!held.counted) {
      if (quantityFlag !== undefined) throw new Error(`${product} does not count; an entry of it carries no --quantity.`);
    } else {
      quantity = quantityFlag !== undefined && /^\d+$/.test(quantityFlag) ? Number(quantityFlag) : Number.NaN;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) {
        throw new Error(`${product} counts; --quantity is a whole number of at least 1.`);
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
    const entry = await grantEntitlement(pool, { siteId: selectedSite.id, subjectId, product,
      source: PHIS_ENTITLEMENT_CORE_SOURCE, reference: ref, startsAt: null, endsAt, quantity, counted: held.counted, listeners });
    if (!entry) throw new Error(`${product} is ${held.state}; a new entry needs an active product.`);
    return { data: { site: selectedSite.key, userId: id, entitlement: entry }, lines: [`Granted: ${describeEntry(entry)}`] };
  }

  throw new Error(USAGE);
}
