import type { Pool } from "pg";

import {
  PhisCdnAdminWithdrawResultFlags,
  PhisCdnCheckObjectFlags,
  PhisCdnCheckReportFlags,
  PhisCdnFileOrigin,
} from "@phis/contracts/addon";
import type { PhisCdnCheckReportV1 } from "@phis/contracts/addon";

import { changeMediaSpaceUsedBytesWithDb, readSiteMediaSpaceIdWithDb } from "../db/media-space-quota.mts";
import {
  insertSiteCdnFile,
  listSiteCdnFiles,
  markSiteCdnFileDeleted,
  readSiteCdnFile,
  withdrawSiteCdnFile,
} from "../db/site-cdn.mts";
import {
  explainPhisCdnKeyRefusal,
  isPhisCdnFileLinked,
  PhisCdnFileFlags,
  readPhisCdnKey,
  resolvePhisCdnContentType,
  type PhisCdnFileRow,
} from "./cdn-core.ts";
import { hashPhisCdnObject, type PhisCdnTarget } from "./cdn-publish.mts";

/*
 * What happens to the catalogue after a file is in it, for `phis cdn` and the CDN page alike: withdraw,
 * delete, and the bucket check with its adoption. Loadable by the CLI, as `cdn-publish.mts` is.
 */

export class PhisCdnUnknownFileError extends Error {
  constructor(key: string, siteKey: string) {
    super(`${key} is not published on ${siteKey}.`);
    this.name = "PhisCdnUnknownFileError";
  }
}

/**
 * Withdraws a file -- a copy or a link -- and, with `remove`, deletes it: a copy's bytes leave the bucket
 * and the Site Space, a link keeps its entry. The key stays taken either way. `flags` carries
 * `AlreadyWithdrawn` where the file was withdrawn before this call.
 */
export async function withdrawPhisCdnFile(pool: Pool, target: PhisCdnTarget, key: string, options: { remove: boolean }) {
  const row = await readSiteCdnFile(pool, target.siteId, key, { includeWithdrawn: true });
  if (!row) throw new PhisCdnUnknownFileError(key, target.siteKey);
  const withdrawn = await withdrawSiteCdnFile(pool, target.siteId, key);
  let deleted = false;
  if (options.remove && (row.flags & PhisCdnFileFlags.Deleted) === 0) {
    // The bytes first: a file is never marked deleted while its bytes are still served.
    if (!isPhisCdnFileLinked(row)) await target.storage.deleteObject(key);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const marked = await markSiteCdnFileDeleted(client, target.siteId, key);
      if (marked && marked.storedBytes > 0) {
        const spaceId = await readSiteMediaSpaceIdWithDb(client, target.siteId);
        if (spaceId !== null) await changeMediaSpaceUsedBytesWithDb(client, { spaceId, delta: -marked.storedBytes });
      }
      await client.query("COMMIT");
      deleted = marked !== null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const after = (await readSiteCdnFile(pool, target.siteId, key, { includeWithdrawn: true }))!;
  return {
    row: after,
    flags: withdrawn ? 0 : PhisCdnAdminWithdrawResultFlags.AlreadyWithdrawn,
    deleted,
  };
}

/** Why an object in the bucket cannot be adopted, or its content type where it can. */
function readAdoptable(storageKey: string, storedType: string | null | undefined) {
  const parts = readPhisCdnKey(storageKey);
  if (!parts) return { parts: null, contentType: null, reason: "not <name>/<version>/<file>" };
  const refusal = explainPhisCdnKeyRefusal(parts.name, parts.version, parts.fileName);
  if (refusal) return { parts: null, contentType: null, reason: refusal };
  try {
    return { parts, contentType: resolvePhisCdnContentType(parts.fileName, storedType), reason: null };
  } catch (error) {
    return { parts: null, contentType: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The bucket against the catalogue's copies: what lies there unrecorded (and whether it can be adopted),
 * what is offered and gone, and sizes that disagree. Links are not checked: their bytes are elsewhere.
 */
export async function checkPhisCdnBucket(pool: Pool, target: PhisCdnTarget): Promise<PhisCdnCheckReportV1> {
  const objects = await target.storage.listPrefix("");
  const rows = await listSiteCdnFiles(pool, target.siteId, { includeWithdrawn: true, all: true, copiesOnly: true });
  const links = new Set((await listSiteCdnFiles(pool, target.siteId, { includeWithdrawn: true, all: true }))
    .filter(isPhisCdnFileLinked).map((row) => row.object_key));
  const byKey = new Map<string, PhisCdnFileRow>(rows.map((row) => [row.object_key, row]));
  const inBucket = new Set(objects.map((object) => object.storageKey));

  const unrecorded: PhisCdnCheckReportV1["unrecorded"] = [];
  const sizeMismatch: PhisCdnCheckReportV1["sizeMismatch"] = [];
  for (const object of objects) {
    const row = byKey.get(object.storageKey);
    if (row) {
      if ((row.flags & PhisCdnFileFlags.Deleted) !== 0) {
        unrecorded.push({ key: object.storageKey, sizeBytes: object.byteSize, flags: 0, reason: "the key belongs to a deleted file" });
      } else if (Number(row.size_bytes) !== object.byteSize) {
        sizeMismatch.push({ key: object.storageKey, recorded: Number(row.size_bytes), stored: object.byteSize });
      }
      continue;
    }
    if (links.has(object.storageKey)) {
      unrecorded.push({ key: object.storageKey, sizeBytes: object.byteSize, flags: 0, reason: "the key is recorded as a link" });
      continue;
    }
    const { reason } = readAdoptable(object.storageKey, object.contentType);
    unrecorded.push({
      key: object.storageKey,
      sizeBytes: object.byteSize,
      flags: reason === null ? PhisCdnCheckObjectFlags.Adoptable : 0,
      reason,
    });
  }
  // A withdrawn file whose bytes are gone is what a delete leaves; only an offered one is missing.
  const missing = rows
    .filter((row) => (row.flags & PhisCdnFileFlags.Withdrawn) === 0 && !inBucket.has(row.object_key))
    .map((row) => row.object_key);
  const consistent = unrecorded.length === 0 && missing.length === 0 && sizeMismatch.length === 0;
  return {
    flags: consistent ? PhisCdnCheckReportFlags.Consistent : 0,
    objects: objects.length,
    // A deleted file stays in the catalogue for its key, but its bytes are meant to be gone.
    recorded: rows.filter((row) => (row.flags & PhisCdnFileFlags.Deleted) === 0).length,
    unrecorded,
    missing,
    sizeMismatch,
  };
}

/**
 * Takes objects the catalogue does not hold into it, with origin `cli` as `phis cdn check --adopt` does:
 * each hashed once from the bucket and counted in the Site Space, since the bytes are stored already.
 */
export async function adoptPhisCdnObjects(pool: Pool, target: PhisCdnTarget, keys: readonly string[]) {
  const adopted: string[] = [];
  const refused: { key: string; reason: string }[] = [];
  for (const key of keys) {
    if (await readSiteCdnFile(pool, target.siteId, key, { includeWithdrawn: true })) {
      refused.push({ key, reason: "the key is in the catalogue already" });
      continue;
    }
    const head = await target.storage.headObject(key);
    if (!head) {
      refused.push({ key, reason: "no object lies at the key" });
      continue;
    }
    const { parts, contentType, reason } = readAdoptable(key, head.contentType);
    if (!parts || !contentType) {
      refused.push({ key, reason: reason ?? "not adoptable" });
      continue;
    }
    const digest = await hashPhisCdnObject(target.storage, key, { sizeBytes: head.byteSize });
    if (!digest || digest.bytes !== head.byteSize) {
      refused.push({ key, reason: "the object could not be read whole" });
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const recorded = await insertSiteCdnFile(client, {
        siteId: target.siteId,
        key: parts.key,
        name: parts.name,
        version: parts.version,
        fileName: parts.fileName,
        sizeBytes: head.byteSize,
        sha256: digest.sha256,
        contentType,
        flags: 0,
        origin: { origin: PhisCdnFileOrigin.Cli, addonId: null, actorUserId: null, sourceUrl: null },
      });
      if (recorded) {
        const spaceId = await readSiteMediaSpaceIdWithDb(client, target.siteId);
        if (spaceId !== null) await changeMediaSpaceUsedBytesWithDb(client, { spaceId, delta: head.byteSize });
      }
      await client.query("COMMIT");
      if (recorded) adopted.push(key);
      else refused.push({ key, reason: "the key was recorded at the same time" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { adopted, refused };
}
