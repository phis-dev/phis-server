import "server-only";

import type { PoolClient } from "pg";

import type { PhisAddonSchemaDescriptor } from "./contract.ts";
import { derivePhisAddonSchemaName } from "./schema-name.ts";
import { discardPhiMediaAssets, type PhiDiscardedMediaObject } from "@/db/media-discard";
import { drainPhiDiscardedMediaObjects } from "@/lib/media-asset-delete";
import { readPhisAddonRowAssetIds } from "@/db/server-addon-assets.mts";
import { listThreadAttachedAssetIdsWithDb } from "@/db/threads";

/**
 * What happens to a row's files when the row itself goes.
 *
 * The foreign key takes the links with the row -- that is the cascade doing its job -- but a Media Asset
 * is not the Add-on's to cascade, and no constraint was ever going to reach into a store. So the file
 * outlived the link by design, counted against the Space and pointed at by nothing.
 *
 * Doing it here rather than leaving it to the Add-on is the whole point. An Add-on that forgets fails
 * invisibly: the row is gone, the listing looks right, and only the quota slowly says otherwise. And the
 * question is not one an Add-on is even equipped to answer, because it never sees an Asset id.
 *
 * Three steps, because the middle one is the only one that can be undone. What a row holds is read
 * before the statement, since the links go with it; the files are given up inside the same transaction,
 * so a rollback takes that back too; and the store is touched only after the commit, against notes that
 * were written down while there was still something to write them from.
 */
export type PhisAddonRowAssets = {
  /** Whether this table declares asset slots at all. Tables that do not are left entirely alone. */
  slotted(table: string): boolean;
  /** The row's files, read before the row goes. */
  collect(db: PoolClient, table: string, ownerId: unknown): Promise<number[]>;
  /** Gives those files up: rows, Space figures, and a note per object. */
  discard(db: PoolClient, assetIds: readonly number[]): Promise<PhiDiscardedMediaObject[]>;
  /** Removes the objects, once the transaction that gave them up has actually committed. */
  drain(objects: readonly PhiDiscardedMediaObject[]): Promise<void>;
};

export function buildPhisAddonRowAssets(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  schema: PhisAddonSchemaDescriptor | null;
}): PhisAddonRowAssets {
  const { addonId, siteId, siteKey, schema } = input;
  const schemaName = derivePhisAddonSchemaName(addonId);

  return Object.freeze({
    slotted(table: string) {
      const declared = schema?.tables.find((entry) => entry.name === table);
      return (declared?.assets ?? []).length > 0;
    },

    async collect(db: PoolClient, table: string, ownerId: unknown) {
      return await readPhisAddonRowAssetIds(db, { schemaName, table }, {
        siteId,
        ownerId: String(ownerId),
      });
    },

    async discard(db: PoolClient, assetIds: readonly number[]) {
      /*
       * A file a message carries stays. The row's link goes with the row either way; the file is then
       * pointed at by the message alone, still on the Add-on's Space, and `--sweep` takes it once no
       * message names it any more. Discarding it here would not delete it anyway: the attachment's
       * foreign key refuses at commit, and the whole row delete with it.
       */
      const attached = new Set(await listThreadAttachedAssetIdsWithDb(db, siteId, assetIds));
      const { objects } = await discardPhiMediaAssets(db, {
        siteId,
        assetIds: assetIds.filter((id) => !attached.has(id)),
      });
      return objects;
    },

    async drain(objects: readonly PhiDiscardedMediaObject[]) {
      await drainPhiDiscardedMediaObjects({ siteId, siteKey, objects });
    },
  } satisfies PhisAddonRowAssets);
}
