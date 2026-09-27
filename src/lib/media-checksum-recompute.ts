import "server-only";

import { createHash } from "node:crypto";

import {
  formatPhiMediaCompositeChecksum,
  isPhisMediaIdentityChecksum,
  resolvePhiMediaUploadPartCount,
  resolvePhiMediaUploadPartSizeBytes,
} from "@phis/contracts/addon";

import { getMediaStorageProfile } from "@/db/media-spaces";
import {
  listMediaAssetsWithoutIdentityChecksum,
  setMediaAssetChecksum,
  type PhiMediaAssetWithoutIdentityChecksum,
} from "@/db/media";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";

/**
 * Giving Assets stored before this a digest duplicate detection can compare.
 *
 * What they have is an `md5` read off a single-request ETag, or nothing at all -- neither is compared, so
 * every Asset uploaded straight to an S3 endpoint before Core asked the Client for a digest sits outside
 * duplicate detection permanently. Nothing in the upload path can fix that afterwards: the bytes are the only
 * evidence, and reading them is exactly the cost the Client-side digest exists to avoid. So it is an
 * operator's decision, once, rather than something a request does.
 *
 * Deliberately not part of any upload. An upload that recomputed a stranger's digest would pay for somebody
 * else's history and would do it again on the next upload.
 */

export type PhiMediaObjectChecksum = { algorithm: "sha256" | "sha256-composite"; value: string };

/**
 * Hashes an object in the form a Provider would report for it, from a single pass over its bytes.
 *
 * Two forms, and which one applies is read off the object rather than guessed: an ETag with a trailing
 * `-<n>` means the object was assembled from *n* parts, and what such an object carries is the composite of
 * its part digests. Anything else arrived whole and carries a plain SHA-256. Computing the other form would
 * produce a digest that is perfectly correct and comparable with nothing -- the same file uploaded today
 * would land under the other one.
 *
 * A composite is only offered where the part count matches `resolvePhiMediaUploadPartSizeBytes` over this
 * size, which is the same condition the S3 Provider applies when it reads one back. Where it does not, the
 * object was divided by something other than this system, its divisions are unknown, and the honest answer
 * is `null`.
 *
 * The part boundaries are applied to the stream as it passes, so a chunk that straddles one is split rather
 * than mis-attributed, and a body of any size costs one part digest in memory.
 */
export async function computePhiMediaObjectChecksum(input: {
  stream: ReadableStream<Uint8Array>;
  byteSize: number;
  /** The `-<n>` of the object's ETag, where it had one. */
  assembledPartCount: number | null;
}): Promise<PhiMediaObjectChecksum | null> {
  const wantsComposite = input.assembledPartCount !== null;
  if (wantsComposite && resolvePhiMediaUploadPartCount(input.byteSize) !== input.assembledPartCount) {
    return null;
  }

  const partSizeBytes = resolvePhiMediaUploadPartSizeBytes(input.byteSize);
  const partDigests: Buffer[] = [];
  const whole = createHash("sha256");
  let part = createHash("sha256");
  let inPart = 0;
  let total = 0;

  const reader = input.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (!wantsComposite) {
        whole.update(chunk);
        continue;
      }
      // A chunk may cross a part boundary, and the digest of a part is over exactly that part's bytes.
      while (chunk.byteLength > 0) {
        const room = partSizeBytes - inPart;
        const take = Math.min(room, chunk.byteLength);
        part.update(chunk.subarray(0, take));
        inPart += take;
        chunk = chunk.subarray(take);
        if (inPart === partSizeBytes) {
          partDigests.push(part.digest());
          part = createHash("sha256");
          inPart = 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  /*
   * The size is held to. A body that is not the length the catalog records is not the object this digest
   * would be about, and recording one for it would put a figure in the column that refuses a later upload
   * of something else.
   */
  if (total !== input.byteSize) return null;

  if (!wantsComposite) {
    return { algorithm: "sha256", value: whole.digest("hex") };
  }
  // The trailing partial part, which every assembled object has unless its size is an exact multiple.
  if (inPart > 0) partDigests.push(part.digest());
  if (partDigests.length !== input.assembledPartCount) return null;

  const folded = createHash("sha256").update(Buffer.concat(partDigests)).digest("hex");
  return {
    algorithm: "sha256-composite",
    value: formatPhiMediaCompositeChecksum(folded, partDigests.length, partSizeBytes),
  };
}

/** The `-<n>` an ETag carries where the object was assembled, and null where it was not. */
export function readPhiMediaAssembledPartCount(etag: string | null | undefined): number | null {
  const match = /-(\d{1,5})$/u.exec((etag ?? "").replace(/"/gu, ""));
  return match ? Number(match[1]) : null;
}

export type PhiMediaChecksumRecomputeReport = {
  examined: number;
  recorded: number;
  /** Objects whose divisions this system cannot name, or whose size no longer matches the catalog. */
  incomparable: number;
  /** Objects that could not be read at all: a Provider that refused, or bytes that are gone. */
  unreadable: number;
  /** Digests that now name an Asset already in the same Space, which an operator has to decide about. */
  duplicates: { assetId: number; existingAssetId: number; spaceId: number }[];
  /** How many are still without one, so an operator knows whether to run it again. */
  remaining: number;
};

/**
 * Walks a bounded number of Assets without a comparable digest and gives them one.
 *
 * Bounded because every one of them is a whole object read from storage: a limit is what keeps an operator's
 * command from becoming an unannounced transfer of the entire corpus. The report says what is left.
 *
 * Idempotent. An Asset that now carries an identity-grade digest is no longer selected, so running it twice
 * is running it once, and two operators running it at the same moment do the same work rather than conflicting
 * work.
 *
 * A digest that turns out to name an Asset already in the Space is **recorded and reported**, not resolved.
 * Two Assets holding the same bytes is a fact about the corpus; which of them should go is a decision with
 * owners, Folders and references behind it, and a maintenance command has no business making it.
 */
export async function recomputePhiMediaAssetChecksums(input: {
  siteId: number;
  siteKey: string;
  limit: number;
}): Promise<PhiMediaChecksumRecomputeReport> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
  const { assets, remaining } = await listMediaAssetsWithoutIdentityChecksum(input.siteId, limit);

  const report: PhiMediaChecksumRecomputeReport = {
    examined: assets.length,
    recorded: 0,
    incomparable: 0,
    unreadable: 0,
    duplicates: [],
    remaining,
  };

  // One Provider per Profile, however many Assets sit on it.
  const services = new Map<number, Awaited<ReturnType<typeof createPhisMediaStorageServiceForProfile>> | null>();
  const serviceFor = async (storageProfileId: number) => {
    if (services.has(storageProfileId)) return services.get(storageProfileId) ?? null;
    let service: Awaited<ReturnType<typeof createPhisMediaStorageServiceForProfile>> | null = null;
    try {
      const profile = await getMediaStorageProfile(input.siteId, storageProfileId);
      service = profile ? await createPhisMediaStorageServiceForProfile(profile, input.siteKey) : null;
    } catch (error) {
      logRuntimeEvent("warn", "media.checksum.provider_unavailable", {
        message: `Storage Profile ${storageProfileId} could not be opened to read object bytes.`,
        siteKey: input.siteKey,
        error: normalizeLogThrowable(error),
        meta: { storageProfileId },
      });
    }
    services.set(storageProfileId, service);
    return service;
  };

  for (const asset of assets) {
    const outcome = await recordOneChecksum(asset, input, serviceFor);
    if (outcome.kind === "recorded") {
      report.recorded += 1;
      if (outcome.duplicateOf != null) {
        report.duplicates.push({
          assetId: asset.id, existingAssetId: outcome.duplicateOf, spaceId: asset.spaceId,
        });
      }
    } else if (outcome.kind === "incomparable") {
      report.incomparable += 1;
    } else {
      report.unreadable += 1;
    }
  }

  return report;
}

async function recordOneChecksum(
  asset: PhiMediaAssetWithoutIdentityChecksum,
  input: { siteId: number; siteKey: string },
  serviceFor: (storageProfileId: number) => Promise<
    Awaited<ReturnType<typeof createPhisMediaStorageServiceForProfile>> | null
  >,
): Promise<{ kind: "recorded"; duplicateOf: number | null } | { kind: "incomparable" } | { kind: "unreadable" }> {
  const service = await serviceFor(asset.storageProfileId);
  if (!service) return { kind: "unreadable" };

  try {
    const head = await service.headObject(asset.storageKey);
    if (!head) return { kind: "unreadable" };
    const stream = await service.getObjectStream(asset.storageKey);
    if (!stream) return { kind: "unreadable" };

    const checksum = await computePhiMediaObjectChecksum({
      stream,
      byteSize: head.byteSize,
      assembledPartCount: readPhiMediaAssembledPartCount(head.etag),
    });
    if (!checksum || !isPhisMediaIdentityChecksum(checksum.algorithm)) {
      return { kind: "incomparable" };
    }

    const written = await setMediaAssetChecksum({
      id: asset.id,
      siteId: input.siteId,
      algorithm: checksum.algorithm,
      value: checksum.value,
    });
    return { kind: "recorded", duplicateOf: written?.duplicateOfAssetId ?? null };
  } catch (error) {
    logRuntimeEvent("warn", "media.checksum.object_unreadable", {
      message: `Asset ${asset.id} could not be read to compute its digest.`,
      siteKey: input.siteKey,
      error: normalizeLogThrowable(error),
      meta: { assetId: asset.id, storageProfileId: asset.storageProfileId },
    });
    return { kind: "unreadable" };
  }
}
