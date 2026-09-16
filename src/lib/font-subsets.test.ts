import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { isPhiCodepointInRanges, PHI_FONT_SUBSET_RANGES, PhiFontSubsetKey } from "@phis/contracts/media";

import { readPhiFontCodepoints } from "@/lib/font-metrics";
import { cutPhiFontSubset, selectPhiFontSubsetCodepoints } from "@/lib/font-subsets";

const require = createRequire(import.meta.url);

/*
 * A real typeface rather than a hand-built one: cutting is HarfBuzz's work, and only a font with outlines
 * and layout tables says whether the cut still is one. Geist ships with Next under the OFL, so the test
 * carries no font of its own.
 */
const GEIST = readFileSync(require.resolve("next/dist/compiled/@vercel/og/Geist-Regular.ttf"));

/** The same font as a woff, table by table deflated -- the one container this package reassembles itself. */
function toWoff(sfnt: Buffer) {
  const numTables = sfnt.readUInt16BE(4);
  const header = Buffer.alloc(44 + numTables * 20);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(sfnt.readUInt32BE(0), 4);
  header.writeUInt16BE(numTables, 12);
  const bodies: Buffer[] = [];
  let offset = header.length;
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const tableOffset = sfnt.readUInt32BE(record + 8);
    const length = sfnt.readUInt32BE(record + 12);
    const original = sfnt.subarray(tableOffset, tableOffset + length);
    const deflated = deflateSync(original);
    const stored = deflated.length < original.length ? deflated : original;
    const entry = 44 + index * 20;
    sfnt.copy(header, entry, record, record + 4);
    header.writeUInt32BE(offset, entry + 4);
    header.writeUInt32BE(stored.length, entry + 8);
    header.writeUInt32BE(length, entry + 12);
    header.writeUInt32BE(sfnt.readUInt32BE(record + 4), entry + 16);
    const padded = Buffer.alloc(Math.ceil(stored.length / 4) * 4);
    stored.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([header, ...bodies]);
}

describe("Font subsets", () => {
  it("cuts a font down to the characters of one range, as woff2", async () => {
    const cut = await cutPhiFontSubset(GEIST, PhiFontSubsetKey.Latin);
    expect(cut).not.toBeNull();
    expect(cut!.toString("latin1", 0, 4)).toBe("wOF2");
    expect(cut!.length).toBeLessThan(GEIST.length / 4);

    const kept = readPhiFontCodepoints(cut!)!;
    expect(kept).toContain("a".codePointAt(0));
    // Nothing survives that the cut was not asked for.
    expect(kept.every((codepoint) => isPhiCodepointInRanges(codepoint, PHI_FONT_SUBSET_RANGES[PhiFontSubsetKey.Latin]))).toBe(true);
  });

  it("reads woff2 and woff originals to the same cut", async () => {
    const wawoff2 = require("wawoff2") as { compress(input: Uint8Array): Promise<Uint8Array> };
    const fromTtf = readPhiFontCodepoints((await cutPhiFontSubset(GEIST, PhiFontSubsetKey.Latin))!)!.sort();
    const fromWoff2 = await cutPhiFontSubset(Buffer.from(await wawoff2.compress(GEIST)), PhiFontSubsetKey.Latin);
    const fromWoff = await cutPhiFontSubset(toWoff(GEIST), PhiFontSubsetKey.Latin);
    expect(readPhiFontCodepoints(fromWoff2!)!.sort()).toEqual(fromTtf);
    expect(readPhiFontCodepoints(fromWoff!)!.sort()).toEqual(fromTtf);
  });

  it("answers with no cut for a range the font has nothing in", async () => {
    const codepoints = readPhiFontCodepoints(GEIST)!;
    const emptyKey = [PhiFontSubsetKey.GreekExt, PhiFontSubsetKey.CyrillicExt, PhiFontSubsetKey.Vietnamese]
      .find((key) => selectPhiFontSubsetCodepoints(codepoints, key).length === 0);
    expect(emptyKey).toBeDefined();
    expect(await cutPhiFontSubset(GEIST, emptyKey!)).toBeNull();
  });

  it("keeps in the rest exactly what no named range holds", () => {
    const rest = selectPhiFontSubsetCodepoints([0x41, 0x416, 0x3042, 0x1f600], PhiFontSubsetKey.Rest);
    expect(rest).toEqual([0x3042, 0x1f600]);
  });
});
