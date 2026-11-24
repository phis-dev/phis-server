import type { Pool } from "pg";

import type { PhisAddonProductDescriptor } from "@phis/contracts/products";

import {
  reconcileProductSupply,
  syncManifestProducts,
  type ManifestProductAction,
  type ProductSupplyChange,
} from "../db/products.mts";
import { listProductListenersOf, type PhisInstalledManifestEntries } from "../lib/addons/commerce-listeners.ts";
import { normalizePhisProductDraft, phisProductSourceLocaleAtSite } from "../lib/addons/product-draft.ts";
import { readMergedPhiConfigSync, resolvePhiSiteSourceLocale } from "../lib/config-files-cli.ts";

/**
 * Where Core brings a Site's product directory in step with the installed Add-ons: when an Add-on is
 * switched on or off for a Site (`phis addon site`) and when a release is reconciled
 * (`phis addon reconcile`). Both are operator commands, so the listeners of `product.changed` are read
 * from the desired state on disk, as `phis entitlement` reads its own; the running server delivers
 * the rows.
 */

/**
 * The products an Add-on's manifest declares, registered at one Site, and those it dropped withdrawn.
 *
 * Their texts are the Add-on's own, so they are in the manifest's `sourceLocale` (required where a manifest
 * declares products), kept as null where that is the Site's language (`@phis/contracts/products`, rule 2).
 */
export async function syncAddonProductsAtSite(
  pool: Pool,
  input: {
    addonId: string;
    siteId: number;
    declared: readonly PhisAddonProductDescriptor[];
    /** The manifest's `sourceLocale`. */
    sourceLocale: string | undefined;
    entries: PhisInstalledManifestEntries;
    /** Where the configuration naming the Site's source language lives. */
    configRoot: string;
  },
): Promise<ManifestProductAction[]> {
  if (input.declared.length === 0) {
    return syncManifestProducts(pool, { siteId: input.siteId, supplier: input.addonId, declared: [], listeners: listProductListenersOf(input.entries) });
  }
  if (!input.sourceLocale) throw new Error(`${input.addonId} declares products and no sourceLocale; its manifest is not valid.`);
  const { rows } = await pool.query<{ key: string }>(`SELECT key FROM phis.sites WHERE id = $1`, [input.siteId]);
  if (!rows[0]) throw new Error(`Site ${input.siteId} does not exist.`);
  const siteSourceLocale = resolvePhiSiteSourceLocale(readMergedPhiConfigSync(input.configRoot), rows[0].key);
  return syncManifestProducts(pool, {
    siteId: input.siteId,
    supplier: input.addonId,
    declared: input.declared.map((product) => {
      const draft = normalizePhisProductDraft({ ...product, sourceLocale: input.sourceLocale }, `${input.addonId}:${product.key}` as never);
      return { ...draft, sourceLocale: phisProductSourceLocaleAtSite(draft.sourceLocale, siteSourceLocale) };
    }),
    listeners: listProductListenersOf(input.entries),
  });
}

/** Withdraws the products whose supplier is off and restores those whose supplier is back. */
export async function reconcileProductSupplyAfterChange(
  pool: Pool,
  entries: PhisInstalledManifestEntries,
  siteId?: number,
): Promise<ProductSupplyChange[]> {
  return reconcileProductSupply(pool, listProductListenersOf(entries), siteId);
}
