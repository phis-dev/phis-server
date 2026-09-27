import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  PHIS_MEDIA_UPLOAD_MAX_PART_COUNT,
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  resolvePhiMediaUploadPartCount,
  resolvePhiMediaUploadPartSizeBytes,
} from "@phis/contracts/addon";

import {
  buildPhiMediaCompositeChecksum,
  buildPhiMediaUploadPlanChecksum,
  phiMediaUploadMayAssembleFromParts,
  readPhiMediaClientDigest,
} from "./media-upload-digest";

/**
 * What a Client may claim about a body, and what Core is willing to assert from it.
 *
 * The stake is that a recorded digest refuses somebody else's upload later: duplicate detection answers a
 * match with a 409, so a figure that is wrong -- or right about a different division of the same bytes --
 * blocks a file that is not a duplicate, and nothing downstream would catch it. Hence a shape that is
 * refused rather than tolerated, and a composite Core computes instead of accepting.
 */
const HEX = "a".repeat(64);
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

describe("reading the digest a Client claims", () => {
  it("takes no digest at all, which stays a perfectly ordinary upload", () => {
    expect(readPhiMediaClientDigest({ sizeBytes: 10 })).toEqual({ ok: true, digest: null });
  });

  it("takes a whole-object digest for a body that fits in one part", () => {
    expect(readPhiMediaClientDigest({ sizeBytes: 1024, sha256: HEX.toUpperCase() })).toEqual({
      ok: true,
      digest: { kind: "whole", algorithm: "sha256", value: HEX },
    });
  });

  it("refuses a digest that is not a lowercase hex SHA-256", () => {
    for (const value of ["", "zz", HEX.slice(1), `${HEX}00`, 42]) {
      expect(readPhiMediaClientDigest({ sizeBytes: 1024, sha256: value }).ok).toBe(false);
    }
  });

  /*
   * The shape follows from the size, and a Client that sends the other one has misread the rule. Dropping
   * the digest instead would leave an Asset that cannot be deduplicated and no trace of why.
   */
  it("refuses the wrong shape for the size, in either direction", () => {
    const large = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 3;
    expect(readPhiMediaClientDigest({ sizeBytes: large, sha256: HEX }))
      .toEqual({ ok: false, error: "checksum_shape" });
    expect(readPhiMediaClientDigest({ sizeBytes: 1024, partSha256: [HEX] }))
      .toEqual({ ok: false, error: "checksum_shape" });
  });

  it("refuses both at once, because then the Client is guessing", () => {
    expect(readPhiMediaClientDigest({ sizeBytes: 1024, sha256: HEX, partSha256: [HEX] }))
      .toEqual({ ok: false, error: "checksum_shape" });
  });

  it("folds part digests into the composite the assembled object will carry", () => {
    const sizeBytes = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2 + 1;
    const partCount = resolvePhiMediaUploadPartCount(sizeBytes);
    expect(partCount).toBe(3);
    const partSha256 = ["one", "two", "three"].map(digestOf);

    const reading = readPhiMediaClientDigest({ sizeBytes, partSha256 });
    expect(reading.ok).toBe(true);
    if (!reading.ok || !reading.digest || reading.digest.kind !== "parts") throw new Error("unreachable");
    expect(reading.digest.algorithm).toBe("sha256-composite");
    expect(reading.digest.partChecksums).toEqual(partSha256);
    // The composite is SHA256 over the concatenated binary part digests, with the division named.
    const folded = createHash("sha256")
      .update(Buffer.concat(partSha256.map((value) => Buffer.from(value, "hex"))))
      .digest("hex");
    expect(reading.digest.value).toBe(`${folded}-3-${PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES}`);
  });

  /*
   * A count that disagrees with the rule is the one error worth refusing loudly: each digest is signed
   * into one part request, so a list of another length means the Client hashed boundaries these requests
   * do not address, and every part after the first would be signed against the wrong bytes.
   */
  it("refuses a list of part digests that does not match the division", () => {
    const sizeBytes = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2 + 1;
    for (const count of [1, 2, 4]) {
      expect(readPhiMediaClientDigest({ sizeBytes, partSha256: Array(count).fill(HEX) }))
        .toEqual({ ok: false, error: "invalid_part_checksums" });
    }
  });

  it("refuses a part digest that is not a digest", () => {
    const sizeBytes = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2 + 1;
    expect(readPhiMediaClientDigest({ sizeBytes, partSha256: [HEX, "nope", HEX] }))
      .toEqual({ ok: false, error: "invalid_part_checksums" });
    expect(readPhiMediaClientDigest({ sizeBytes, partSha256: "not a list" }))
      .toEqual({ ok: false, error: "invalid_part_checksums" });
  });
});

describe("deciding whether a body arrives in parts", () => {
  it("answers from the size alone", () => {
    expect(phiMediaUploadMayAssembleFromParts(1)).toBe(false);
    expect(phiMediaUploadMayAssembleFromParts(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES)).toBe(false);
    expect(phiMediaUploadMayAssembleFromParts(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 1)).toBe(true);
  });

  it("is the same boundary the digest shape follows, so the two can never disagree", () => {
    for (const sizeBytes of [1, 1024, PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES, PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 1]) {
      const wantsParts = phiMediaUploadMayAssembleFromParts(sizeBytes);
      const partCount = resolvePhiMediaUploadPartCount(sizeBytes);
      expect(wantsParts).toBe(partCount > 1);
    }
  });
});

describe("what the plan is told", () => {
  const whole = { kind: "whole", algorithm: "sha256", value: HEX } as const;
  const parts = {
    kind: "parts",
    algorithm: "sha256-composite",
    value: buildPhiMediaCompositeChecksum([HEX, HEX], PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2),
    partChecksums: [HEX, HEX],
  } as const;

  it("passes a whole-object digest through under its own algorithm", () => {
    expect(buildPhiMediaUploadPlanChecksum(whole, "sha256"))
      .toEqual({ checksum: { algorithm: "sha256", value: HEX } });
  });

  it("passes the part digests and the composite they add up to", () => {
    expect(buildPhiMediaUploadPlanChecksum(parts, "sha256")).toEqual({
      checksum: { algorithm: "sha256-composite", value: parts.value },
      partChecksums: [HEX, HEX],
    });
  });

  /*
   * Only under a SHA-256 Profile. These are SHA-256 digests, and a Profile recording SHA-512 would be
   * handed a figure incomparable with everything it holds -- the body then takes the path it would have
   * taken with no digest at all.
   */
  it("says nothing where the Profile records another algorithm, or none", () => {
    expect(buildPhiMediaUploadPlanChecksum(whole, "sha512")).toEqual({});
    expect(buildPhiMediaUploadPlanChecksum(parts, "sha512")).toEqual({});
    expect(buildPhiMediaUploadPlanChecksum(whole, null)).toEqual({});
    expect(buildPhiMediaUploadPlanChecksum(null, "sha256")).toEqual({});
  });
});

/**
 * The division, pinned to its actual numbers.
 *
 * **If this file fails, do not adjust it.** A `sha256-composite` value means "these bytes, divided this way",
 * and the division is written into it -- so changing the rule gives the same file a different value. Nothing
 * breaks loudly: duplicate detection simply stops matching anything stored under the old rule, and the corpus
 * quietly becomes two that can never be told to be the same. A failure here is therefore a decision about
 * every object already stored, and the only honest ways through it are to leave the numbers alone or to
 * re-derive every affected digest on purpose.
 *
 * The arithmetic itself -- the floor, the ceiling, the point where the part grows instead of the count -- is
 * tested in phis-storage-s3, relative to these constants. This is the part that says what the constants are.
 */
describe("the frozen division", () => {
  it("is sixteen mebibytes, and at most a thousand parts", () => {
    expect(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES).toBe(16 * 1024 * 1024);
    expect(PHIS_MEDIA_UPLOAD_MAX_PART_COUNT).toBe(1000);
  });

  it("divides these sizes into exactly these parts", () => {
    // Written out rather than computed, so a changed rule cannot agree with the test that encodes it.
    expect(resolvePhiMediaUploadPartCount(1)).toBe(1);
    expect(resolvePhiMediaUploadPartCount(16 * 1024 * 1024)).toBe(1);
    expect(resolvePhiMediaUploadPartCount(16 * 1024 * 1024 + 1)).toBe(2);
    expect(resolvePhiMediaUploadPartCount(100 * 1024 * 1024)).toBe(7);
    expect(resolvePhiMediaUploadPartCount(2 * 1024 * 1024 * 1024)).toBe(128);
    // Past the thousand-part ceiling the part grows instead of the count: 20 GiB in 976 parts of 21 MiB.
    expect(resolvePhiMediaUploadPartSizeBytes(20 * 1024 * 1024 * 1024)).toBe(21 * 1024 * 1024);
    expect(resolvePhiMediaUploadPartCount(20 * 1024 * 1024 * 1024)).toBe(976);
  });

  it("produces this exact value for these exact part digests", () => {
    const parts = ["one", "two"].map(digestOf);
    // The recorded form: the fold, the count, the part size. All three decide whether two of them match.
    expect(buildPhiMediaCompositeChecksum(parts, 20 * 1024 * 1024))
      .toBe(`${createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p, "hex")))).digest("hex")}-2-16777216`);
  });

  it("gives the same file the same value twice, which is the whole point", () => {
    const parts = ["a", "b", "c"].map(digestOf);
    const size = 40 * 1024 * 1024;
    expect(buildPhiMediaCompositeChecksum(parts, size)).toBe(buildPhiMediaCompositeChecksum(parts, size));
  });
});
