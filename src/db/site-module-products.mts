import type { Pool, PoolClient } from "pg";

import type { PhisModuleProductRow } from "../lib/module-products.ts";

/**
 * Which products a Site package proposed and the Site took (DB.md `site_module_products`).
 *
 * A row says "this proposal was taken on this Site" and nothing else may ever undo that: it is what keeps a
 * product the Site changed or removed from being made again. Written only under
 * `lockSiteModuleProducts`, in the transaction that read it, so two syncs cannot both find it missing.
 * Plain module rather than `server-only`, because `phis module check` reads the rows from the shell.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

type Row = {
  package_name: string;
  key: string;
  product_key: string;
  flags: number;
  created_at: Date | string;
};

function mapRow(row: Row): PhisModuleProductRow {
  return {
    packageName: row.package_name,
    key: row.key,
    productKey: row.product_key,
    flags: row.flags,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/** Serialises the writers of one Site's rows until the transaction `client` is in ends. */
export async function lockSiteModuleProducts(client: PoolClient, siteId: number) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`phis.site_module_products:${siteId}`]);
}

export async function listSiteModuleProducts(db: Queryable, siteId: number) {
  const { rows } = await db.query<Row>(
    `SELECT package_name, key, product_key, flags, created_at FROM phis.site_module_products
      WHERE site_id = $1 ORDER BY package_name, key`,
    [siteId],
  );
  return rows.map(mapRow);
}

export async function getSiteModuleProduct(db: Queryable, siteId: number, packageName: string, key: string) {
  const { rows } = await db.query<Row>(
    `SELECT package_name, key, product_key, flags, created_at FROM phis.site_module_products
      WHERE site_id = $1 AND package_name = $2 AND key = $3`,
    [siteId, packageName, key],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Records a taken proposal. Never overwrites: a row once written stays as it was. */
export async function insertSiteModuleProduct(db: Queryable, input: {
  siteId: number; packageName: string; key: string; productKey: string; flags: number;
}) {
  await db.query(
    `INSERT INTO phis.site_module_products (site_id, package_name, key, product_key, flags)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, package_name, key) DO NOTHING`,
    [input.siteId, input.packageName, input.key, input.productKey, input.flags],
  );
}

/** Whether the Site has a product of this supplier under this key, in whatever state. */
export async function siteHasSupplierProduct(db: Queryable, siteId: number, supplier: string, key: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM phis.products WHERE site_id = $1 AND supplier_addon_id = $2 AND key = $3`,
    [siteId, supplier, key],
  );
  return rows.length > 0;
}
