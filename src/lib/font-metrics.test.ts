import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { readPhiFontMetrics } from "@/lib/font-metrics";

/**
 * The numbers a Theme writes into `size-adjust`, read from a file nobody controls.
 *
 * The fixtures are built here rather than shipped: a font binary in the repository would be a licence
 * to keep track of, and a hand-built one states in the test what each number is supposed to be.
 */

const UNITS_PER_EM = 1000;
const ADVANCE = 500;
const SPACE_ADVANCE = 250;
const SAMPLE_LENGTH = 27; // a..z and the space

function table(size: number, writes: [number, number][], signed = true) {
  const buffer = Buffer.alloc(size);
  for (const [offset, value] of writes) {
    if (signed) buffer.writeInt16BE(value, offset);
    else buffer.writeUInt16BE(value, offset);
  }
  return buffer;
}

function headTable() {
  const head = Buffer.alloc(54);
  head.writeUInt16BE(UNITS_PER_EM, 18);
  return head;
}

function hheaTable() {
  const hhea = Buffer.alloc(36);
  hhea.writeInt16BE(950, 4);
  hhea.writeInt16BE(-250, 6);
  hhea.writeInt16BE(30, 8);
  hhea.writeUInt16BE(92, 34); // one full metric for every glyph the cmap below reaches
  return hhea;
}

function os2Table() {
  return table(96, [
    [2, 480], // xAvgCharWidth -- deliberately not the advance average, so the source can be told apart
    [30, 0x0100], // sFamilyClass 1: an oldstyle serif
    [86, 520], // sxHeight
    [88, 700], // sCapHeight
  ]);
}

function postTable() {
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0, 12); // isFixedPitch: proportional
  return post;
}

/** Format 4, one segment covering the sample plus the terminator every font must carry. */
function cmapTable() {
  const segCount = 2;
  const subtable = Buffer.alloc(16 + segCount * 8);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(0, 4);
  subtable.writeUInt16BE(segCount * 2, 6);
  const endCodes = 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  subtable.writeUInt16BE(0x7a, endCodes);
  subtable.writeUInt16BE(0xffff, endCodes + 2);
  subtable.writeUInt16BE(0x20, startCodes);
  subtable.writeUInt16BE(0xffff, startCodes + 2);
  // Space becomes glyph 1, and every letter follows in code order.
  subtable.writeInt16BE(-0x20 + 1, idDeltas);
  subtable.writeInt16BE(1, idDeltas + 2);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4); // platform 3, encoding 1: the Unicode table a browser reads
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, subtable]);
}

function hmtxTable() {
  const hmtx = Buffer.alloc(92 * 4);
  for (let glyph = 0; glyph < 92; glyph += 1) {
    hmtx.writeUInt16BE(glyph === 1 ? SPACE_ADVANCE : ADVANCE, glyph * 4);
  }
  return hmtx;
}

function nameTable(family: string) {
  const value = Buffer.from(family, "utf16le").swap16();
  const header = Buffer.alloc(6 + 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(18, 4);
  header.writeUInt16BE(3, 6); // platform 3
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(0x409, 10);
  header.writeUInt16BE(16, 12); // typographic family
  header.writeUInt16BE(value.length, 14);
  header.writeUInt16BE(0, 16);
  return Buffer.concat([header, value]);
}

const TABLES: [string, Buffer][] = [
  ["OS/2", os2Table()],
  ["cmap", cmapTable()],
  ["glyf", Buffer.alloc(64, 7)],
  ["head", headTable()],
  ["hhea", hheaTable()],
  ["hmtx", hmtxTable()],
  ["loca", Buffer.alloc(16, 3)],
  ["name", nameTable("Phi Test Sans")],
  ["post", postTable()],
];

function buildSfnt() {
  const header = Buffer.alloc(12 + TABLES.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(TABLES.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  TABLES.forEach(([tag, body], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 4, "latin1");
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(body.length, record + 12);
    offset += body.length;
    bodies.push(body);
  });
  return Buffer.concat([header, ...bodies]);
}

function uintBase128(value: number) {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining > 0);
  for (let index = 0; index < bytes.length - 1; index += 1) bytes[index]! |= 0x80;
  return Buffer.from(bytes);
}

const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ",
];

/**
 * A woff2 with a transformed `glyf` and `loca` in the middle of it.
 *
 * That pair is the whole reason the directory walk is worth testing: their length in the stream is the
 * transformed one, and taking the original instead does not lose those two tables -- it shifts every
 * table after them, so the metrics come back as noise rather than as an error.
 */
function buildWoff2() {
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, 4, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(TABLES.length, 12);

  const directory: Buffer[] = [];
  const stream: Buffer[] = [];
  for (const [tag, body] of TABLES) {
    const known = WOFF2_KNOWN_TAGS.indexOf(tag);
    const transformed = tag === "glyf" || tag === "loca";
    const stored = transformed ? body.subarray(0, body.length - 4) : body;
    const flags = Buffer.from([known < 0 ? 0x3f : known]);
    const parts = [flags];
    if (known < 0) parts.push(Buffer.from(tag, "latin1"));
    parts.push(uintBase128(body.length));
    if (transformed) parts.push(uintBase128(stored.length));
    directory.push(Buffer.concat(parts));
    stream.push(stored);
  }

  const compressed = brotliCompressSync(Buffer.concat(stream));
  return Buffer.concat([header, ...directory, compressed]);
}

describe("Font metrics", () => {
  it("reads the proportions out of an sfnt", () => {
    const metrics = readPhiFontMetrics(buildSfnt());
    expect(metrics).not.toBeNull();
    expect(metrics!.format).toBe("sfnt");
    expect(metrics!.familyName).toBe("Phi Test Sans");
    expect(metrics!.unitsPerEm).toBe(UNITS_PER_EM);
    expect(metrics!.ascent).toBe(950);
    expect(metrics!.descent).toBe(-250);
    expect(metrics!.lineGap).toBe(30);
    expect(metrics!.capHeight).toBe(700);
    expect(metrics!.xHeight).toBe(520);
    expect(metrics!.category).toBe("serif");
  });

  it("measures the width of running text from the advances, not from the font's own average", () => {
    const metrics = readPhiFontMetrics(buildSfnt());
    /*
     * Every letter is 500 and the space is 250, so the answer is the space's weight away from 500:
     * the frequency table gives it 0.1774 of a sample that sums to 0.9999, which lands on 456. The flat
     * mean over the same glyphs would be 491, and the 480 in `OS/2` is neither.
     */
    expect(metrics!.xWidthAvg).toBe(456);
    expect(metrics!.xWidthAvgSource).toBe("glyphs");
    expect(Math.round((26 * ADVANCE + SPACE_ADVANCE) / SAMPLE_LENGTH)).toBe(491);
  });

  it("reads the same numbers back out of a woff2", () => {
    const metrics = readPhiFontMetrics(buildWoff2());
    expect(metrics).not.toBeNull();
    expect(metrics!.format).toBe("woff2");
    expect(metrics!.unitsPerEm).toBe(UNITS_PER_EM);
    expect(metrics!.ascent).toBe(950);
    expect(metrics!.xWidthAvg).toBe(456);
    expect(metrics!.familyName).toBe("Phi Test Sans");
  });

  it("answers with nothing for bytes that are not a font", () => {
    expect(readPhiFontMetrics(Buffer.from("not a font at all"))).toBeNull();
    expect(readPhiFontMetrics(Buffer.alloc(0))).toBeNull();
    // A truncated sfnt: the signature is right and there is nothing behind it.
    expect(readPhiFontMetrics(buildSfnt().subarray(0, 40))).toBeNull();
  });
});
