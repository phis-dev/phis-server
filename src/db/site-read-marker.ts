import { getPool } from "@/lib/db";
import { phiPrepared } from "@/lib/db-prepared";

/**
 * The Site's read marker (`phis.site_read_marker`), or null while nothing a Site reads was ever published.
 * Triggers in 001_create_phis.pgsql move it on every published change; only equality means anything.
 */
export async function readSiteReadMarker(siteId: number): Promise<string | null> {
  const { rows } = await getPool().query<{ marker: string }>(phiPrepared(
    "SELECT marker::text AS marker FROM phis.site_read_marker WHERE site_id = $1",
    [siteId],
  ));
  return rows[0]?.marker ?? null;
}
