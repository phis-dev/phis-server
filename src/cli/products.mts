import type { Pool } from "pg";

import type { PhisProductId, PhisProductState } from "@phis/contracts/products";

import { listProducts, moveProductsAsOperator, readProduct, releaseProduct, type PhisStoredProduct as PhisProduct } from "../db/products.mts";
import { listProductListenersOf, type PhisInstalledManifestEntries } from "../lib/addons/commerce-listeners.ts";
import { isPhisProductId } from "../lib/addons/product-draft.ts";
import { PHIS_ADDON_ID_PATTERN } from "../lib/addons/schema-name.ts";
import { readAddonDesiredState } from "./addons.mts";

type Flags = Map<string, string | boolean>;

const USAGE = "Use product list, show, release, lock, unlock or withdraw.";
const STATES: readonly PhisProductState[] = ["draft", "active", "withdrawn", "locked"];

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

function productId(flags: Flags) {
  const value = flag(flags, "product");
  if (!isPhisProductId(value)) throw new Error("--product must be a product id such as @scope/name:key.");
  return value;
}

function describeProduct(product: PhisProduct) {
  const notes = [
    product.released ? "released" : "not released",
    ...(product.pendingTerms ? ["terms pending release"] : []),
    ...(product.supplied ? [] : ["supplier off"]),
  ];
  return `${product.id}  ${product.state}  ${product.type}  "${product.title}"  publisher ${product.publisher ?? "-"}  ${notes.join(", ")}`;
}

function describeTerms(terms: { sale: string; referralUrl: string | null; free: boolean; accountRequired: boolean; parts: readonly string[] }) {
  return `sale ${terms.sale}${terms.referralUrl ? ` (${terms.referralUrl})` : ""}, ${terms.free ? "free" : "not free"}, ${terms.accountRequired ? "account required" : "no account required"}, `
    + `parts ${terms.parts.length === 0 ? "-" : terms.parts.join(" ")}`;
}

function showProduct(product: PhisProduct) {
  const attributes = Object.keys(product.attributes);
  return [
    `${product.id}  ${product.state}  version ${product.version}`,
    `  title      ${product.title}`,
    `  summary    ${product.summary || "-"}`,
    `  type       ${product.type}${product.counted ? ", counted" : ""}`,
    `  supplier   ${product.supplier} (${product.supplied ? "switched on for the Site" : "switched off"})`,
    `  publisher  ${product.publisher ?? "- (the Site's own)"}  ${product.released ? "released" : "not released"}`,
    `  image      ${product.imageAssetId === null ? "-" : `Asset ${product.imageAssetId}`}`,
    `  icon       ${product.iconAssetId === null ? "-" : `Asset ${product.iconAssetId}`}`,
    `  terms      ${describeTerms(product)}`,
    ...(product.pendingTerms ? [`  pending    ${describeTerms(product.pendingTerms)}`] : []),
    `  attributes ${attributes.length === 0 ? "-" : attributes.join(", ")}`,
    `  created    ${product.createdAt}  updated ${product.updatedAt}`,
  ];
}

/** What `phis product ...` does, as data plus the lines to print: the caller chooses between them. */
export async function runPhisProductCommand(root: string, pool: Pool, words: readonly string[], flags: Flags) {
  const selectedSite = await site(pool, flag(flags, "site").toLowerCase());
  const addons = readAddonDesiredState(root).addons;
  const entries: PhisInstalledManifestEntries = Object.fromEntries(addons.map((a) => [a.addonId, { enabled: a.enabled, manifest: a.manifest }]));
  const listeners = listProductListenersOf(entries);
  const [command] = words;

  if (command === "list") {
    const supplier = optionalFlag(flags, "supplier");
    if (supplier !== undefined && !PHIS_ADDON_ID_PATTERN.test(supplier)) throw new Error("--supplier must be an Add-on id such as @scope/name.");
    const stateFlag = optionalFlag(flags, "state");
    const states = stateFlag === undefined ? [...STATES] : stateFlag.split(",").map((value) => value.trim());
    if (!states.every((state): state is PhisProductState => (STATES as readonly string[]).includes(state))) {
      throw new Error("--state is a comma-separated list of draft, active, withdrawn or locked.");
    }
    const products: PhisProduct[] = [];
    let cursor: string | null = null;
    do {
      const page = await listProducts(pool, {
        siteId: selectedSite.id, states, cursor, limit: 200, supplier, publisher: optionalFlag(flags, "publisher"),
        released: flags.get("unreleased") === true ? false : undefined,
      });
      products.push(...page.products);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return {
      data: { site: selectedSite.key, products },
      lines: products.length === 0 ? [`No product matches at ${selectedSite.key}.`] : products.map(describeProduct),
    };
  }

  if (command === "show" || command === "release" || command === "lock" || command === "unlock") {
    const id = productId(flags);
    const product = await readProduct(pool, selectedSite.id, id);
    if (!product) throw new Error(`${selectedSite.key} has no product ${id}.`);
    if (command === "show") return { data: { site: selectedSite.key, product }, lines: showProduct(product) };

    if (command === "release") {
      const result = await releaseProduct(pool, { siteId: selectedSite.id, productId: id, listeners });
      const done = result!.outcome === "released" ? `Released ${id}.`
        : result!.outcome === "applied" ? `Released the pending terms of ${id}.` : `No change: ${id} is released and has nothing pending.`;
      return { data: { site: selectedSite.key, outcome: result!.outcome, product: result!.product }, lines: [done] };
    }

    const to = command === "lock" ? "locked" : "unlocked";
    if (command === "lock" ? product.state === "locked" : product.state !== "locked") {
      return {
        data: { site: selectedSite.key, moved: [], product },
        lines: [`No change: ${id} is ${command === "lock" ? "already locked" : `not locked (${product.state})`}.`],
      };
    }
    const moved = await moveProductsAsOperator(pool, { siteId: selectedSite.id, to, productId: id, listeners });
    return {
      data: { site: selectedSite.key, moved },
      lines: [command === "lock" ? `Locked ${id}. No entry for it counts while it is locked.`
        : `Unlocked ${id}; it is withdrawn now, because the state before the lock is not kept. Its supplier can move it on.`],
    };
  }

  if (command === "withdraw") {
    const id = optionalFlag(flags, "product");
    const supplier = optionalFlag(flags, "supplier");
    const publisher = optionalFlag(flags, "publisher");
    if ([id, supplier, publisher].filter((value) => value !== undefined).length !== 1) {
      throw new Error("Pass exactly one of --product, --supplier or --publisher.");
    }
    if (id !== undefined && !isPhisProductId(id)) throw new Error("--product must be a product id such as @scope/name:key.");
    if (supplier !== undefined && !PHIS_ADDON_ID_PATTERN.test(supplier)) throw new Error("--supplier must be an Add-on id such as @scope/name.");
    if (id !== undefined) {
      const product = await readProduct(pool, selectedSite.id, id);
      if (!product) throw new Error(`${selectedSite.key} has no product ${id}.`);
      if (product.state === "locked") throw new Error(`${id} is locked; unlock it first.`);
    }
    const moved = await moveProductsAsOperator(pool, {
      siteId: selectedSite.id, to: "withdrawn", productId: id as PhisProductId | undefined, supplier, publisher, listeners,
    });
    return {
      data: { site: selectedSite.key, moved },
      lines: moved.length === 0 ? ["No change: nothing was active to withdraw."]
        : [...moved.map((move) => `Withdrew ${move.id} (was ${move.from}).`), `${moved.length} product(s) withdrawn at ${selectedSite.key}; holders keep what they have.`],
    };
  }

  throw new Error(USAGE);
}
