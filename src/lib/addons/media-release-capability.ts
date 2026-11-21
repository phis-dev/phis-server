import "server-only";

import {
  PHIS_MEDIA_RELEASE_MAX_IDS,
  type PhisMediaReleaseCapabilityV1,
  type PhisMediaReleaseOutcome,
  type PhisMediaReleaseResultV1,
} from "./contract.ts";
import { lockSiteSpaceMediaAssetForRelease, pruneEmptyMediaFolderBranch } from "@/db/media";
import { discardPhiMediaAssets, type PhiMediaDiscardResult } from "@/db/media-discard";
import { clearSiteConfigCache } from "@/db/site-config";
import { countThreadAttachmentsForAsset } from "@/db/threads";
import { withTransaction } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";
import { drainPhiDiscardedMediaObjects } from "@/lib/media-asset-delete";
import { collectMediaAssetDeleteReferences } from "@/lib/media-delete-guard";

/**
 * `media-release:v1`: an Add-on gives up Assets of the Site's Media library (SERVER_ADDONS.md,
 * media-release:v1).
 *
 * Core deletes an Asset only where nothing references it -- the same references the Media library's delete
 * refuses on, the caller's own `core.mediaAsset` columns included, and a message's attachment -- and never
 * one in a locked Folder. The caller clears its own rows first; an Asset it still names is kept. Kept is
 * an answer, not an error, and says nothing about what holds the Asset.
 *
 * One transaction per Asset: the row lock, the count and the delete. The store is touched after the
 * commit, through the discard notes, exactly as the Media library's delete does it.
 */

export class PhisAddonMediaReleaseError extends Error {}

type Released = { outcome: PhisMediaReleaseOutcome; spaceId?: number; folderId?: number | null; discarded?: PhiMediaDiscardResult };

/** A reference the count did not see -- a stale index row, say -- still refuses through its foreign key. */
function isForeignKeyRefusal(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "23503";
}

async function releaseOne(siteId: number, assetId: number): Promise<Released> {
  try {
    return await withTransaction(async (client): Promise<Released> => {
      const locked = await lockSiteSpaceMediaAssetForRelease(client, siteId, assetId);
      if (!locked) return { outcome: "not-found" };
      if (locked.folderLocked) return { outcome: "kept" };
      if ((await collectMediaAssetDeleteReferences(siteId, locked.asset, client)).length > 0) return { outcome: "kept" };
      // Read on the pool: what is committed is all there is, since a new attachment waits for the lock.
      if (await countThreadAttachmentsForAsset(siteId, assetId) > 0) return { outcome: "kept" };
      const discarded = await discardPhiMediaAssets(client, { siteId, assetIds: [assetId] });
      return {
        outcome: discarded.assetIds.length > 0 ? "deleted" : "not-found",
        spaceId: locked.asset.spaceId,
        folderId: locked.asset.folderId,
        discarded,
      };
    });
  } catch (error) {
    if (isForeignKeyRefusal(error)) return { outcome: "kept" };
    throw error;
  }
}

export function buildPhisAddonMediaReleaseCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  actorUserId: number | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisMediaReleaseCapabilityV1 {
  const { addonId, siteId, siteKey } = input;

  return Object.freeze({
    async release(request: { ids: readonly number[] }): Promise<PhisMediaReleaseResultV1[]> {
      if (input.unauthenticated) {
        throw new PhisAddonMediaReleaseError(
          `${addonId} called mediaRelease.release from an unverified hook; a hook that deletes declares how its caller can be believed.`,
        );
      }
      const ids = request?.ids;
      if (
        !Array.isArray(ids)
        || ids.length > PHIS_MEDIA_RELEASE_MAX_IDS
        || !ids.every((id) => Number.isSafeInteger(id) && id > 0)
      ) {
        throw new PhisAddonMediaReleaseError(`ids is a list of at most ${PHIS_MEDIA_RELEASE_MAX_IDS} positive integer Asset ids.`);
      }
      const results: PhisMediaReleaseResultV1[] = [];
      let deletedAny = false;
      for (const id of new Set(ids)) {
        const released = await releaseOne(siteId, id);
        if (released.outcome === "deleted") {
          deletedAny = true;
          await drainPhiDiscardedMediaObjects({ siteId, siteKey, objects: released.discarded!.objects });
          if (released.folderId != null) await pruneEmptyMediaFolderBranch(siteId, released.spaceId!, released.folderId);
        }
        logRuntimeEvent("info", "addon.media.released", {
          siteKey,
          pluginKey: addonId,
          userId: input.actorUserId,
          targetType: "media-asset",
          targetId: id,
          meta: { outcome: released.outcome },
        });
        results.push({ id, released: released.outcome });
      }
      if (deletedAny) clearSiteConfigCache(siteId);
      return results;
    },
  } satisfies PhisMediaReleaseCapabilityV1);
}
