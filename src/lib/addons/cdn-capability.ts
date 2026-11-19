import "server-only";

import type { PhisCdnCapabilityV1, PhisCdnFileV1 } from "./contract.ts";
import { listSiteCdnFiles, readSiteCdn, readSiteCdnFile } from "@/db/site-cdn.mts";
import { getPool } from "@/lib/db";
import { PHIS_CDN_LIST_LIMIT, presentPhisCdnFile } from "@/lib/cdn-core";

/**
 * `cdn:v1`: the Site's CDN catalogue, read-only.
 *
 * Bound to the Site of the call. A Site without a CDN answers empty rather than failing, so an Add-on
 * can offer CDN files wherever the operator set one up. There is no writer: publishing is
 * `phis cdn publish`, the operator's, for the reason `secrets:v1` has none.
 */
export function buildPhisAddonCdnCapability(input: { siteId: number }): PhisCdnCapabilityV1 {
  const { siteId } = input;

  return Object.freeze({
    async configured() {
      return (await readSiteCdn(getPool(), siteId)) !== null;
    },

    async file(key: string): Promise<PhisCdnFileV1 | null> {
      if (typeof key !== "string" || key.length === 0 || key.length > 620) return null;
      const pool = getPool();
      const cdn = await readSiteCdn(pool, siteId);
      if (!cdn) return null;
      const row = await readSiteCdnFile(pool, siteId, key);
      return row ? presentPhisCdnFile(row, cdn.publicBaseUrl) : null;
    },

    async files(query?: { name?: string; limit?: number }): Promise<PhisCdnFileV1[]> {
      const pool = getPool();
      const cdn = await readSiteCdn(pool, siteId);
      if (!cdn) return [];
      const name = typeof query?.name === "string" && query.name.length > 0 ? query.name : null;
      const limit = typeof query?.limit === "number" && Number.isFinite(query.limit) ? query.limit : PHIS_CDN_LIST_LIMIT;
      const rows = await listSiteCdnFiles(pool, siteId, { name, limit });
      return rows.map((row) => presentPhisCdnFile(row, cdn.publicBaseUrl));
    },
  } satisfies PhisCdnCapabilityV1);
}
