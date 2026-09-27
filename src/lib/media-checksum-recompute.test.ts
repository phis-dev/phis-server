import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  formatPhiMediaCompositeChecksum,
} from "@phis/contracts/addon";

import {
  computePhiMediaObjectChecksum,
  readPhiMediaAssembledPartCount,
} from "./media-checksum-recompute";

/**
 * Hashing an object that is already stored, in the form a Provider would report for it.
 *
 * The stake is the same one duplicate detection always carries: a digest recorded in the wrong form is
 * perfectly correct and comparable with nothing, so the same file uploaded tomorrow would not be recognised --
 * and a digest recorded for bytes that are not the ones the catalog describes would refuse somebody else's
 * upload later. Both are silent, which is why the form is read off the object and the size is held to.
 */

/** A body as a stream, handed out in chunks that deliberately do not line up with part boundaries. */
function streamOf(body: Buffer, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, body.byteLength);
      controller.enqueue(new Uint8Array(body.subarray(offset, end)));
      offset = end;
    },
  });
}

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest();
const PART = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES;

describe("reading whether an object was assembled", () => {
  it("takes the count out of an ETag that carries one", () => {
    expect(readPhiMediaAssembledPartCount('"bd631ff35edada2b905ff1bfe7aa369f-2"')).toBe(2);
    expect(readPhiMediaAssembledPartCount("abc-128")).toBe(128);
  });

  it("answers null for an ETag of a body that arrived whole", () => {
    expect(readPhiMediaAssembledPartCount('"24916206c1727512a41bd39ca126f67f"')).toBeNull();
    expect(readPhiMediaAssembledPartCount("")).toBeNull();
    expect(readPhiMediaAssembledPartCount(null)).toBeNull();
  });
});

describe("hashing a stored object", () => {
  it("gives a body that arrived whole a plain sha256", async () => {
    const body = Buffer.alloc(4096, 7);
    const checksum = await computePhiMediaObjectChecksum({
      stream: streamOf(body, 700), byteSize: body.byteLength, assembledPartCount: null,
    });
    expect(checksum).toEqual({ algorithm: "sha256", value: sha256(body).toString("hex") });
  });

  /*
   * The composite over the same divisions an upload would use, computed in one pass. The chunk size here is
   * deliberately unrelated to the part size: a chunk that straddles a boundary has to be split, or every part
   * after the first is hashed over the wrong bytes -- which yields a plausible digest that matches nothing.
   */
  it("gives an assembled body the composite of its part digests", async () => {
    const parts = [Buffer.alloc(PART, 3), Buffer.alloc(1024 * 1024, 9)];
    const body = Buffer.concat(parts);
    const checksum = await computePhiMediaObjectChecksum({
      stream: streamOf(body, 777_777), byteSize: body.byteLength, assembledPartCount: 2,
    });

    const folded = createHash("sha256").update(Buffer.concat(parts.map(sha256))).digest("hex");
    expect(checksum).toEqual({
      algorithm: "sha256-composite",
      value: formatPhiMediaCompositeChecksum(folded, 2, PART),
    });
  });

  it("splits a part that is exactly the part size, with no trailing empty part", async () => {
    const parts = [Buffer.alloc(PART, 1), Buffer.alloc(PART, 2)];
    const body = Buffer.concat(parts);
    const checksum = await computePhiMediaObjectChecksum({
      stream: streamOf(body, PART), byteSize: body.byteLength, assembledPartCount: 2,
    });

    const folded = createHash("sha256").update(Buffer.concat(parts.map(sha256))).digest("hex");
    expect(checksum?.value).toBe(formatPhiMediaCompositeChecksum(folded, 2, PART));
  });

  /*
   * A count that disagrees with the rule means the object was divided by something other than this system.
   * Its divisions are unknown, so no comparable digest exists for it -- and claiming one would put a value in
   * the column that can never match while looking as though it could.
   */
  it("refuses an object whose part count is not the one this system would use", async () => {
    const body = Buffer.alloc(PART + 1024, 5);
    expect(await computePhiMediaObjectChecksum({
      stream: streamOf(body, 4096), byteSize: body.byteLength, assembledPartCount: 5,
    })).toBeNull();
  });

  it("refuses a body that is not the size the catalog records", async () => {
    const body = Buffer.alloc(4096, 7);
    // Shorter than recorded: something replaced or truncated the object, and this digest is not about it.
    expect(await computePhiMediaObjectChecksum({
      stream: streamOf(body, 512), byteSize: 8192, assembledPartCount: null,
    })).toBeNull();
    // Longer than recorded, which is the same kind of disagreement.
    expect(await computePhiMediaObjectChecksum({
      stream: streamOf(body, 512), byteSize: 2048, assembledPartCount: null,
    })).toBeNull();
  });

  it("hashes an empty object rather than refusing it", async () => {
    const checksum = await computePhiMediaObjectChecksum({
      stream: streamOf(Buffer.alloc(0), 16), byteSize: 0, assembledPartCount: null,
    });
    expect(checksum).toEqual({ algorithm: "sha256", value: sha256(Buffer.alloc(0)).toString("hex") });
  });

  /*
   * The whole reason for recomputing at all: the value has to be the one a fresh upload of the same file
   * would produce, or duplicate detection still does not recognise it.
   */
  it("matches what a Client would have computed for the same bytes", async () => {
    const body = Buffer.alloc(2048, 42);
    const recomputed = await computePhiMediaObjectChecksum({
      stream: streamOf(body, 100), byteSize: body.byteLength, assembledPartCount: null,
    });
    const asAClientWould = createHash("sha256").update(body).digest("hex");
    expect(recomputed?.value).toBe(asAClientWould);
  });
});
