import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { Pool } from "pg";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

import {
  PHI_SERVER_ADDON_ASSET_PREFIX,
  derivePhiServerAddonSchemaName,
  phiServerAddonStoragePrefix,
} from "../lib/addons/schema-name.ts";
import { PHI_SERVER_ADDON_ASSET_STATUS } from "../lib/addons/schema-ddl.ts";
import { bookPhiServerAddonStorage } from "../db/server-addon-storage-usage.mts";
import type { PhiServerAddonStorageSite } from "./storage-purge.mts";

/**
 * Collecting what an Add-on's asset store no longer refers to.
 *
 * This is possible only because a row names the object. While nothing linked the two, which of an
 * Add-on's objects still mattered was a question only the Add-on could answer; with the asset table it
 * is a subtraction -- list the sub-prefix, take away every key a row names, and what remains is nobody's.
 *
 * **It looks under `assets/` and nowhere else.** The free key space `storage:v1` hands out is managed by
 * the Add-on itself and no row of Core's describes it, so a sweep that saw both would read every one of
 * those objects as an orphan and delete live data that was never a mistake. That boundary is the whole
 * safety of this file.
 *
 * Two kinds of leftovers, from two different causes:
 *
 * - **Objects nobody names.** A parent row removed takes its asset rows with it through the cascade,
 *   and the cascade is SQL: it cannot reach into a store. So the objects outlive the rows by design,
 *   and this is where they are caught up with.
 * - **Reservations that were never redeemed.** A place was made, its bytes were charged, and the
 *   transfer never came. The row says so and has said so since it expired.
 *
 * The order within each is objects first, rows second -- the opposite of the purge, and for the same
 * reason. Here the row is what proves an object may be removed, so losing the row first would strand
 * the object permanently. There the row was the data, so losing it before the transaction committed
 * would have been the loss.
 */

export type PhiServerAddonObjectAdapter = {
  listPrefix(prefix: string): Promise<{ storageKey: string; byteSize: number }[]>;
  deleteObject(storageKey: string): Promise<boolean>;
};

/**
 * The built-in Provider, reached through the filesystem.
 *
 * Its adapter carries a `server-only` import a CLI process cannot load, which is the same reason
 * `phis media check` and the purge go this way.
 */
export function phiServerAddonLocalObjectAdapter(rootDir: string): PhiServerAddonObjectAdapter {
  return {
    async listPrefix(prefix: string) {
      const base = path.join(rootDir, prefix);
      if (!existsSync(base)) {
        return [];
      }
      const found: { storageKey: string; byteSize: number }[] = [];
      const walk = async (directory: string) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          const info = await stat(full);
          found.push({
            // Reported as a storage key, so a caller comparing against `storage_key` compares like
            // with like whichever Provider answered.
            storageKey: path.relative(rootDir, full).split(path.sep).join("/"),
            byteSize: info.size,
          });
        }
      };
      await walk(base);
      return found;
    },
    async deleteObject(storageKey: string) {
      const file = path.join(rootDir, storageKey);
      if (!existsSync(file)) {
        return false;
      }
      const { rm } = await import("node:fs/promises");
      await rm(file, { force: true });
      return true;
    },
  };
}

export function phiServerAddonObjectAdapterFor(
  site: PhiServerAddonStorageSite,
  resolved: PhiServerAddonObjectAdapter | null,
): PhiServerAddonObjectAdapter | null {
  if (site.providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    const rootDir = typeof site.config.rootDir === "string" ? site.config.rootDir.trim() : "";
    return rootDir ? phiServerAddonLocalObjectAdapter(rootDir) : null;
  }
  return resolved;
}

/**
 * The tables Core added beside the ones that declare files.
 *
 * Read from the catalog rather than from the manifest, and not by name: a declared table may legitimately
 * be called `foo_assets` where `foo` declares nothing. What distinguishes a derived one is that it holds
 * both `storage_key` and `upload_token`, which no descriptor can produce -- an Add-on cannot declare
 * either, because the columns are Core's.
 */
export async function readPhiServerAddonAssetTables(pool: Pool, addonId: string) {
  const schemaName = derivePhiServerAddonSchemaName(addonId);
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND column_name IN ('storage_key', 'upload_token')
      GROUP BY table_name
     HAVING COUNT(DISTINCT column_name) = 2
      ORDER BY table_name`,
    [schemaName],
  );
  return { schemaName, tables: rows.map((row) => row.table_name) };
}

export type PhiServerAddonSweepResult = {
  siteKey: string;
  /** Reservations that ran out before they were redeemed. */
  expired: number;
  /** Objects under `assets/` that no row named. */
  orphaned: number;
  bytesReleased: number;
  error: string | null;
};

export async function sweepPhiServerAddonAssets(
  pool: Pool,
  input: {
    addonId: string;
    site: PhiServerAddonStorageSite;
    adapter: PhiServerAddonObjectAdapter;
  },
): Promise<PhiServerAddonSweepResult> {
  const { addonId, site, adapter } = input;
  const { schemaName, tables } = await readPhiServerAddonAssetTables(pool, addonId);
  const result: PhiServerAddonSweepResult = {
    siteKey: site.siteKey, expired: 0, orphaned: 0, bytesReleased: 0, error: null,
  };
  if (tables.length === 0) {
    return result;
  }

  const quoted = (table: string) => `"${schemaName}"."${table.replaceAll('"', '""')}"`;

  try {
    for (const table of tables) {
      const { rows } = await pool.query<{ id: string; storage_key: string; byte_size: string }>(
        `SELECT id, storage_key, byte_size FROM ${quoted(table)}
          WHERE site_id = $1 AND status = $2 AND expires_at <= NOW()`,
        [site.siteId, PHI_SERVER_ADDON_ASSET_STATUS.pending],
      );
      for (const row of rows) {
        // Object first: the row is the only record that this object may be removed, so dropping it
        // first would strand the bytes with nothing left to identify them.
        await adapter.deleteObject(row.storage_key).catch(() => {});
        const { rowCount } = await pool.query(
          `DELETE FROM ${quoted(table)} WHERE id = $1 AND status = $2`,
          [row.id, PHI_SERVER_ADDON_ASSET_STATUS.pending],
        );
        if (rowCount) {
          result.expired += 1;
          // The reservation was charged when it was made, which is what the sweep gives back.
          const bytes = Number(row.byte_size);
          result.bytesReleased += bytes;
          await bookPhiServerAddonStorage(pool, {
            addonId, siteId: site.siteId, bytes: -bytes, objects: -1,
          }).catch(() => {});
        }
      }
    }

    /*
     * What is under `assets/` against what the rows name.
     *
     * Every key is read, including pending ones. A reservation whose object is mid-transfer is named by
     * its row, and the row always exists before the object does -- which is the property `begin` was
     * built around and the reason this comparison cannot delete an upload in progress.
     */
    const named = new Set<string>();
    for (const table of tables) {
      const { rows } = await pool.query<{ storage_key: string }>(
        `SELECT storage_key FROM ${quoted(table)} WHERE site_id = $1`,
        [site.siteId],
      );
      for (const row of rows) {
        named.add(row.storage_key);
      }
    }

    const prefix = `${phiServerAddonStoragePrefix(addonId, site.siteKey)}/${PHI_SERVER_ADDON_ASSET_PREFIX}`;
    for (const head of await adapter.listPrefix(prefix)) {
      if (named.has(head.storageKey)) {
        continue;
      }
      if (!await adapter.deleteObject(head.storageKey).catch(() => false)) {
        continue;
      }
      result.orphaned += 1;
      result.bytesReleased += head.byteSize;
      /*
       * Given back at what the object weighs, not at what it was booked for.
       *
       * The usual orphan is one the cascade left behind -- a parent row removed takes its asset rows,
       * and nothing in SQL touches a counter -- so the booking is still standing and this is what
       * settles it. Where it does not settle exactly, `--recount` is the answer.
       */
      await bookPhiServerAddonStorage(pool, {
        addonId, siteId: site.siteId, bytes: -head.byteSize, objects: -1,
      }).catch(() => {});
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message.trim() : "the storage gave no reason";
  }
  return result;
}
