import { createHash } from "node:crypto";

import {
  formatPhiMediaCompositeChecksum,
  resolvePhiMediaUploadPartCount,
  resolvePhiMediaUploadPartSizeBytes,
  type PhisMediaChecksumAlgorithm,
} from "@phis/contracts/addon";

/**
 * What a Client can say about a body before it sends it, and what Core does with that.
 *
 * The point of asking at all is that a digest signed into an upload request is verified by the endpoint:
 * a body that does not match it is refused there and never becomes an object, so Core can record the
 * Client's figure without having seen a byte. A digest Core merely *recorded* would be worse than none --
 * duplicate detection refuses an upload on a match, so a wrong figure blocks a file that is not a
 * duplicate, and there is no later moment that would catch it.
 *
 * Two shapes, because a browser cannot produce one of them for a large file. Web Crypto has no
 * incremental digest: a whole-object SHA-256 means holding the whole body in memory. So a body that is to
 * arrive in parts is described per part, and Core folds those into the composite the assembled object will
 * carry. Which shape applies follows from the size through `resolvePhiMediaUploadPartSizeBytes`, the same
 * rule the Provider addresses the parts with -- neither side tells the other.
 */
export const PHI_MEDIA_CLIENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type PhiMediaClientDigest =
  | { kind: "whole"; algorithm: "sha256"; value: string }
  | { kind: "parts"; algorithm: "sha256-composite"; value: string; partChecksums: readonly string[] };

export type PhiMediaClientDigestReading =
  | { ok: true; digest: PhiMediaClientDigest | null }
  | { ok: false; error: "invalid_checksum" | "invalid_part_checksums" | "checksum_shape" };

/**
 * Reads what the Client claimed, or says why it cannot be used.
 *
 * A refusal rather than a shrug. A Client that sends a malformed digest, or the wrong shape for the size
 * it also declared, has misunderstood the rule -- and quietly dropping the digest would turn that into an
 * Asset that silently cannot be deduplicated, discovered by nobody. Sending none at all stays perfectly
 * allowed: that is `{ digest: null }`, and the body then either passes through Core to be hashed or
 * carries whatever the Provider can attest.
 */
export function readPhiMediaClientDigest(input: {
  sizeBytes: number;
  sha256?: unknown;
  partSha256?: unknown;
}): PhiMediaClientDigestReading {
  const wantsParts = phiMediaUploadMayAssembleFromParts(input.sizeBytes);
  const hasWhole = input.sha256 != null;
  const hasParts = input.partSha256 != null;

  if (!hasWhole && !hasParts) return { ok: true, digest: null };
  // One or the other, and the one the size calls for. Both at once means the Client is guessing.
  if (hasWhole === hasParts) return { ok: false, error: "checksum_shape" };
  if (hasParts !== wantsParts) return { ok: false, error: "checksum_shape" };

  if (hasWhole) {
    const value = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
    if (!PHI_MEDIA_CLIENT_DIGEST_PATTERN.test(value)) return { ok: false, error: "invalid_checksum" };
    return { ok: true, digest: { kind: "whole", algorithm: "sha256", value } };
  }

  if (!Array.isArray(input.partSha256)) return { ok: false, error: "invalid_part_checksums" };
  const partChecksums = input.partSha256.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : "");
  if (partChecksums.some((entry) => !PHI_MEDIA_CLIENT_DIGEST_PATTERN.test(entry))) {
    return { ok: false, error: "invalid_part_checksums" };
  }
  /*
   * The count is the division, and a disagreement about it is not a detail to be tolerated. Each digest
   * is signed into one part request, so a list of another length means the Client hashed boundaries that
   * are not the ones those requests address -- every part but the first would be signed against the wrong
   * bytes, and the upload would fail one part at a time for no legible reason.
   */
  if (partChecksums.length !== resolvePhiMediaUploadPartCount(input.sizeBytes)) {
    return { ok: false, error: "invalid_part_checksums" };
  }

  return {
    ok: true,
    digest: {
      kind: "parts",
      algorithm: "sha256-composite",
      value: buildPhiMediaCompositeChecksum(partChecksums, input.sizeBytes),
      partChecksums,
    },
  };
}

/**
 * The digest an object assembled from these parts will carry, computed here rather than asked for.
 *
 * `SHA256` over the concatenated binary part digests, with the division named alongside. Core computes it
 * from the part digests it is about to have signed, so it is the same arithmetic the endpoint performs
 * while assembling, over the same inputs -- and a Client cannot assert it, which is the reason it is not
 * a field the Client could send.
 */
export function buildPhiMediaCompositeChecksum(
  partChecksums: readonly string[],
  sizeBytes: number,
): string {
  const digest = createHash("sha256")
    .update(Buffer.concat(partChecksums.map((value) => Buffer.from(value, "hex"))))
    .digest("hex");
  return formatPhiMediaCompositeChecksum(digest, partChecksums.length, resolvePhiMediaUploadPartSizeBytes(sizeBytes));
}

/**
 * Whether a body of this size is to arrive in parts.
 *
 * A size question and nothing else, which is a change of grounds: it used to follow from a Profile's probe
 * answering whether a whole-object digest survives an assembly, and that answer can never be yes -- the
 * S3 API accepts `ChecksumType: FULL_OBJECT` for the CRC algorithms alone, so a permission resting on it
 * never opened. What an assembled object carries is `sha256-composite`, which duplicate detection can
 * compare, so there is nothing left to trade away and the only question is whether parts are worth it.
 *
 * Above one part they are: a single request that fails at ninety per cent starts again from the first
 * byte, and on an ordinary connection that is the usual outcome rather than the unlucky one. Each part
 * here fails and repeats on its own.
 *
 * The Client computes the same rule to know whether to hash whole or per part, and a Provider that cannot
 * assemble parts ignores the permission either way.
 */
export function phiMediaUploadMayAssembleFromParts(sizeBytes: number): boolean {
  return sizeBytes > resolvePhiMediaUploadPartSizeBytes(sizeBytes);
}

/** What the plan is told, for a digest Core may assert under this Profile's algorithm. */
export function buildPhiMediaUploadPlanChecksum(
  digest: PhiMediaClientDigest | null,
  profileAlgorithm: string | null,
): {
  checksum?: { algorithm: PhisMediaChecksumAlgorithm; value: string };
  partChecksums?: readonly string[];
} {
  /*
   * Only under a SHA-256 Profile, and the reason is not squeamishness: these are SHA-256 digests, and a
   * Profile that records SHA-512 would be handed a figure it cannot compare with anything it holds. The
   * body then takes whatever path it would have taken without a digest.
   */
  if (!digest || profileAlgorithm !== "sha256") return {};
  if (digest.kind === "whole") {
    return { checksum: { algorithm: "sha256", value: digest.value } };
  }
  return {
    checksum: { algorithm: "sha256-composite", value: digest.value },
    partChecksums: digest.partChecksums,
  };
}
