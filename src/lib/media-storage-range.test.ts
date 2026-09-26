import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhisLocalMediaStorageAdapter } from "./media-storage.ts";

/**
 * Reading part of an object, which is what lets a browser seek in a video.
 *
 * The property under test is not "it returns some bytes" but that it reports the range it *actually*
 * produced. A `Content-Range` is a claim about which bytes these are, and delivery builds that claim from
 * what comes back here -- so an adapter that echoed the request while serving something else would make
 * the Server lie to a player, which then scrubs to the wrong place or plays noise.
 */

let root: string;
const BODY = Buffer.from("0123456789abcdefghij");
const KEY = "sites/demo/ranged.bin";

describe("reading part of a locally stored object", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phis-range-"));
    const adapter = new PhisLocalMediaStorageAdapter({ rootDir: root, storageKeyPrefix: "sites" });
    await adapter.putObject({ storageKey: KEY, body: BODY, contentType: "application/octet-stream" });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const adapter = () => new PhisLocalMediaStorageAdapter({ rootDir: root, storageKeyPrefix: "sites" });

  async function read(offset: number, length: number) {
    const ranged = await adapter().getObjectRangeStream(KEY, { offset, length });
    if (!ranged) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of ranged.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return { ...ranged, text: Buffer.concat(chunks).toString("utf8") };
  }

  it("serves exactly the bytes asked for, both ends inclusive", async () => {
    const first = await read(0, 4);
    expect(first).toMatchObject({ text: "0123", range: { offset: 0, length: 4 }, byteSize: BODY.length });

    const middle = await read(10, 5);
    expect(middle).toMatchObject({ text: "abcde", range: { offset: 10, length: 5 } });

    const single = await read(19, 1);
    expect(single).toMatchObject({ text: "j", range: { offset: 19, length: 1 } });
  });

  it("clamps a length that runs past the end, and says how much it served", async () => {
    const tail = await read(15, 999);
    expect(tail).toMatchObject({ text: "fghij", range: { offset: 15, length: 5 }, byteSize: BODY.length });
  });

  it("serves nothing for a zero length rather than rounding up to one byte", async () => {
    const empty = await read(5, 0);
    expect(empty).toMatchObject({ text: "", range: { offset: 5, length: 0 } });
  });

  it("names the whole size even when it served a slice, so a Content-Range can state the total", async () => {
    const slice = await read(3, 2);
    expect(slice?.byteSize).toBe(BODY.length);
    expect(slice?.range.length).not.toBe(BODY.length);
  });

  it("answers null for an object that is not there, the way the whole-object read does", async () => {
    expect(await adapter().getObjectRangeStream("sites/demo/absent.bin", { offset: 0, length: 4 })).toBeNull();
  });
});
