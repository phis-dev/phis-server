import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

import { isPhisAddonStorageKeyUnder, phisAddonStoragePrefix } from "../lib/addons/schema-name.ts";
import { PhisMediaSpaceKind } from "../lib/constants/media-space-kinds.ts";

export { phisAddonStoragePrefix };

/**
 * Removing the objects an Add-on left behind, which the database cannot do for it.
 *
 * A purge is one transaction over Core's tables, and object storage is not in it. So the two halves are
 * ordered rather than combined, and the order is deliberate: **the rows go first**. If the storage then
 * refuses, what remains is objects nobody references -- untidy, findable, and removable later. The other
 * order loses data whenever the transaction rolls back after the bytes are already gone.
 *
 * The Site keys have to be read *before* the purge for the same reason a photograph is taken before the
 * demolition: `site_server_addons` is one of the tables the purge empties, and afterwards there is
 * nothing left to say which Sites this Add-on ever had a store on.
 *
 * The Local Provider is reached through the filesystem rather than through its adapter, which is what
 * `phis media check` already does. The adapter carries a `server-only` import that a CLI process cannot
 * load, and the alternative -- rearranging that module so it can -- would be a larger change than the
 * one thing needed here: a directory, removed.
 */

export type PhisAddonStorageSite = {
  siteId: number;
  siteKey: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
};

/** What a purge is about to have to clean up, read while the rows still say so. */
export async function readPhisAddonStorageSites(
  pool: Pool,
  addonId: string,
): Promise<PhisAddonStorageSite[]> {
  const { rows } = await pool.query<{
    site_id: number; site_key: string; provider_id: string;
    config: Record<string, unknown>; secret_reference: string | null;
  }>(
    /*
     * The Site Space's Profile, because that is where the storage capability writes: an Add-on does not
     * choose a Profile. Named by its kind -- "no user and no group" also describes every Add-on Space,
     * so a Site whose Add-ons kept assets was listed once per such Space.
     */
    `SELECT s.id AS site_id, s.key AS site_key,
            p.provider_id, p.config, p.secret_reference
       FROM phis.site_server_addons a
       JOIN phis.sites s ON s.id = a.site_id
       JOIN phis.media_spaces sp ON sp.site_id = s.id AND sp.kind = $2
       JOIN phis.media_storage_profiles p ON p.id = sp.default_storage_profile_id
      WHERE a.addon_id = $1
      ORDER BY s.key`,
    [addonId, PhisMediaSpaceKind.Site],
  );
  return rows.map((row) => ({
    siteId: row.site_id,
    siteKey: row.site_key,
    providerId: row.provider_id,
    config: row.config ?? {},
    secretReference: row.secret_reference,
  }));
}

export type PhisAddonStorageRemoval = {
  siteKey: string;
  providerId: string;
  removed: number;
  error: string | null;
};

/**
 * Empties one Add-on's store on one Site.
 *
 * Reports rather than throws. A purge that stopped at the first unreachable Provider would leave the
 * remaining Sites untouched and give an operator no list of what still needs attention -- and the rows
 * are already gone by this point, so stopping helps nobody.
 */
export async function removePhisAddonStorage(
  site: PhisAddonStorageSite,
  addonId: string,
  resolveAdapter: (site: PhisAddonStorageSite) => Promise<{
    listPrefix(prefix: string): Promise<{ storageKey: string }[]>;
    deleteObject(storageKey: string): Promise<boolean>;
  } | null>,
): Promise<PhisAddonStorageRemoval> {
  const prefix = phisAddonStoragePrefix(addonId, site.siteKey);
  try {
    if (site.providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
      const rootDir = typeof site.config.rootDir === "string" ? site.config.rootDir.trim() : "";
      if (!rootDir) {
        return { siteKey: site.siteKey, providerId: site.providerId, removed: 0, error: null };
      }
      const directory = path.join(rootDir, prefix);
      if (!existsSync(directory)) {
        return { siteKey: site.siteKey, providerId: site.providerId, removed: 0, error: null };
      }
      await rm(directory, { recursive: true, force: true });
      // A directory tree is removed whole; counting what was in it would mean walking it first, for a
      // figure nobody acts on.
      return { siteKey: site.siteKey, providerId: site.providerId, removed: -1, error: null };
    }

    const adapter = await resolveAdapter(site);
    if (!adapter) {
      return {
        siteKey: site.siteKey,
        providerId: site.providerId,
        removed: 0,
        error: "No installed Add-on offers this Storage Provider any more, so its objects stay.",
      };
    }
    // The Provider matches the prefix as a string, so `acme` lists `acme-eu` too; only what lies under
    // this Site's own directory may go.
    const heads = (await adapter.listPrefix(prefix))
      .filter((head) => isPhisAddonStorageKeyUnder(prefix, head.storageKey));
    let removed = 0;
    for (const head of heads) {
      if (await adapter.deleteObject(head.storageKey)) {
        removed += 1;
      }
    }
    return { siteKey: site.siteKey, providerId: site.providerId, removed, error: null };
  } catch (error) {
    return {
      siteKey: site.siteKey,
      providerId: site.providerId,
      removed: 0,
      error: error instanceof Error ? error.message.trim() : "the storage gave no reason",
    };
  }
}

/**
 * Sets the counters to what the store actually holds.
 *
 * The running totals can drift, and only downward-safe drift is harmless. A write that the storage
 * accepted after Core had given the booking back, an object removed by an operator with a bucket
 * client, a Provider migration that copied objects across -- none of these go through `put`, and each
 * leaves the figure describing a store that no longer exists. A ceiling reached by drift refuses writes
 * against space that is free, and nothing in the error says so.
 *
 * It is a command and not a background pass because it costs a full listing of the prefix, which is the
 * unbounded operation the ceiling exists to prevent. Run after a migration, or when a figure is
 * disbelieved.
 */
export async function recountPhisAddonStorage(
  pool: Pool,
  input: {
    addonId: string;
    site: PhisAddonStorageSite;
    listPrefix: (prefix: string) => Promise<{ storageKey: string; byteSize: number }[]>;
  },
) {
  const prefix = phisAddonStoragePrefix(input.addonId, input.site.siteKey);
  // Same boundary as the purge: a string-prefix listing does not stop at the Site key, and a figure
  // that counted the neighbouring Site's bytes would refuse this one's writes for room it has.
  const heads = (await input.listPrefix(prefix))
    .filter((head) => isPhisAddonStorageKeyUnder(prefix, head.storageKey));
  const bytes = heads.reduce((total, head) => total + head.byteSize, 0);
  const objects = heads.length;
  const { rows } = await pool.query<{ storage_used_bytes: string; storage_used_objects: number }>(
    `UPDATE phis.site_server_addons
        SET storage_used_bytes = $3, storage_used_objects = $4, updated_at = NOW()
      WHERE addon_id = $1 AND site_id = $2
      RETURNING storage_used_bytes, storage_used_objects`,
    [input.addonId, input.site.siteId, bytes, objects],
  );
  return { siteKey: input.site.siteKey, bytes, objects, applied: rows.length > 0 };
}
