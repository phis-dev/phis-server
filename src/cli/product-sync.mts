import type { Pool } from "pg";

import type { PhisAddonProductDescriptor } from "@phis/contracts/products";

import {
  reconcileProductSupply,
  syncManifestProducts,
  type ManifestProductAction,
  type ProductSupplyChange,
} from "../db/products.mts";
import { listProductListenersOf, type PhisInstalledManifestEntries } from "../lib/addons/commerce-listeners.ts";
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";

/**
 * Where Core brings a Site's product directory in step with the installed Add-ons: when an Add-on is
 * switched on or off for a Site (`phis addon site`) and when a release is reconciled
 * (`phis addon reconcile`). Both are operator commands, so the listeners of `product.changed` are read
 * from the desired state on disk, as `phis entitlement` reads its own; the running server delivers
 * the rows.
 */

/** The products an Add-on's manifest declares, registered at one Site, and those it dropped withdrawn. */
export async function syncAddonProductsAtSite(
  pool: Pool,
  input: {
    addonId: string;
    siteId: number;
    declared: readonly PhisAddonProductDescriptor[];
    entries: PhisInstalledManifestEntries;
  },
): Promise<ManifestProductAction[]> {
  return syncManifestProducts(pool, {
    siteId: input.siteId,
    supplier: input.addonId,
    declared: input.declared.map((product) => normalizePhisProductDraft(product, `${input.addonId}:${product.key}` as never)),
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
