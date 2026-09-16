import "server-only";

import { brotliDecompressSync, inflateSync } from "node:zlib";

/**
 * What a typeface says about its own proportions, read out of the file.
 *
 * A font that did not come through `next/font` has no fallback face, so the browser paints in a
 * substitute until the file arrives and then reflows. The cure is an `@font-face` whose `size-adjust`
 * and `*-override` descriptors make the substitute stand in at the right size, and the numbers for that
 * are in the font: `head` gives the unit grid, `hhea` and `OS/2` the vertical extents, and the advance
 * widths say how wide the running text will be. They are read once, here, and kept on the Asset --
 * a render has no business opening a font file.
 *
 * Hand-written for the same reason `media-content-sniffer.ts` is: this reads bytes an uploader chose,
 * in the one process that must not be surprised, and every number it returns ends up in a stylesheet.
 * It also keeps the upload path free of a parser that quietly learns new formats.
 *
 * It answers or it does not. A font it cannot read is still a perfectly good font; it simply arrives
 * without metrics, and the Theme falls back to an unadjusted face -- which is where we were before.
 */

/** Enough for any single metrics table; a guard against a length field that claims the world. */
const MAX_TABLE_BYTES = 1024 * 1024;

/*
 * The woff2 known-table list, in the order the specification numbers it. A table's tag is this index
 * unless the entry says otherwise, and the numbering is what lets a directory entry cost one byte.
 * Only the first handful is read here; the rest has to be present so the walk over the directory keeps
 * its place.
 */
const WOFF2_KNOWN_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post",
  "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea",
  "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop",
  "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
] as const;

export type PhiFontMetrics = {
  /** The container the numbers were read from, for a reader wondering what was parsed. */
  format: "sfnt" | "woff" | "woff2";
  familyName: string | null;
  /** The grid every other number below is measured on. */
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  capHeight: number | null;
  xHeight: number | null;
  /**
   * How wide running text sets, as an advance width on the same grid.
   *
   * `glyphs` is the average advance of the lowercase Latin letters and the space, which is what a line
   * of prose is mostly made of. `os2` is the font's own `xAvgCharWidth`, taken when the advances cannot
   * be read -- it averages every glyph in the file, so a family carrying Greek and Cyrillic reports a
   * width no Latin paragraph will have. The source is recorded because the two are not equally good.
   */
  xWidthAvg: number | null;
  xWidthAvgSource: "glyphs" | "os2" | null;
  /**
   * What the file says it is, for choosing the local substitute -- and `null` when it says nothing.
   *
   * Read from PANOSE where a font fills it in, from the `OS/2` family class otherwise. Neither is
   * mandatory and plenty of good fonts leave both at zero (Lora, among the three this package ships),
   * so the absence is reported rather than papered over with a guess: whoever picks the substitute can
   * ask the person who uploaded the file, which is a better source than a coin toss.
   */
  category: "serif" | "sans-serif" | "monospace" | null;
};

type TableMap = Map<string, Buffer>;

function readTag(buffer: Buffer, offset: number) {
  return buffer.length >= offset + 4 ? buffer.toString("latin1", offset, offset + 4) : "";
}

function sliceTable(source: Buffer, offset: number, length: number) {
  if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
  if (offset < 0 || length <= 0 || length > MAX_TABLE_BYTES) return null;
  if (offset + length > source.length) return null;
  return source.subarray(offset, offset + length);
}

function readSfntTables(buffer: Buffer): TableMap {
  const tables: TableMap = new Map();
  if (buffer.length < 12) return tables;
  const numTables = buffer.readUInt16BE(4);
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    if (record + 16 > buffer.length) break;
    const tag = readTag(buffer, record);
    const table = sliceTable(buffer, buffer.readUInt32BE(record + 8), buffer.readUInt32BE(record + 12));
    if (tag && table) tables.set(tag, table);
  }
  return tables;
}

function readWoffTables(buffer: Buffer): TableMap {
  const tables: TableMap = new Map();
  if (buffer.length < 44) return tables;
  const numTables = buffer.readUInt16BE(12);
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20;
    if (record + 20 > buffer.length) break;
    const tag = readTag(buffer, record);
    const offset = buffer.readUInt32BE(record + 4);
    const compressedLength = buffer.readUInt32BE(record + 8);
    const originalLength = buffer.readUInt32BE(record + 12);
    const stored = sliceTable(buffer, offset, compressedLength);
    if (!tag || !stored) continue;
    if (compressedLength >= originalLength) {
      tables.set(tag, stored);
      continue;
    }
    if (originalLength > MAX_TABLE_BYTES) continue;
    try {
      tables.set(tag, inflateSync(stored));
    } catch {
      // A table that will not inflate is one table missing, not a file that cannot be read.
    }
  }
  return tables;
}

/** woff2 writes its lengths in a variable number of bytes, seven bits at a time, high group first. */
function readUIntBase128(buffer: Buffer, cursor: { offset: number }) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (cursor.offset >= buffer.length) return null;
    const byte = buffer[cursor.offset]!;
    cursor.offset += 1;
    // A leading zero would make the encoding ambiguous, and the value must stay inside 32 bits.
    if (index === 0 && byte === 0x80) return null;
    if (value > 0x01ffffff) return null;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  return null;
}

function readWoff2Tables(buffer: Buffer): TableMap {
  const tables: TableMap = new Map();
  if (buffer.length < 48) return tables;
  const numTables = buffer.readUInt16BE(12);
  const cursor = { offset: 48 };
  const directory: { tag: string; length: number }[] = [];
  for (let index = 0; index < numTables; index += 1) {
    if (cursor.offset >= buffer.length) return tables;
    const flags = buffer[cursor.offset]!;
    cursor.offset += 1;
    const known = flags & 0x3f;
    let tag: string;
    if (known === 0x3f) {
      tag = readTag(buffer, cursor.offset);
      cursor.offset += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[known] ?? "";
    }
    const originalLength = readUIntBase128(buffer, cursor);
    if (originalLength == null) return tables;
    /*
     * `glyf` and `loca` are transformed unless the entry says they are not, and every other table is
     * the other way round. Either way the transformed length is what the table occupies in the stream,
     * and reading it wrong does not lose one table -- it moves every table after it.
     */
    const transformVersion = (flags >> 6) & 0x03;
    const transformed = tag === "glyf" || tag === "loca" ? transformVersion === 0 : transformVersion !== 0;
    let length = originalLength;
    if (transformed) {
      const transformLength = readUIntBase128(buffer, cursor);
      if (transformLength == null) return tables;
      length = transformLength;
    }
    directory.push({ tag, length });
  }

  let decompressed: Buffer;
  try {
    decompressed = brotliDecompressSync(buffer.subarray(cursor.offset));
  } catch {
    return tables;
  }

  let streamOffset = 0;
  for (const entry of directory) {
    const table = sliceTable(decompressed, streamOffset, entry.length);
    streamOffset += entry.length;
    // A transformed `glyf` is not a `glyf`, but nothing here reads one; the walk only has to pass it.
    if (entry.tag && table && entry.tag !== "glyf" && entry.tag !== "loca") {
      tables.set(entry.tag, table);
    }
  }
  return tables;
}

function readTables(buffer: Buffer): { format: PhiFontMetrics["format"]; tables: TableMap } | null {
  const signature = readTag(buffer, 0);
  if (signature === "wOF2") return { format: "woff2", tables: readWoff2Tables(buffer) };
  if (signature === "wOFF") return { format: "woff", tables: readWoffTables(buffer) };
  if (signature === "OTTO" || signature === "true" || signature === "typ1") {
    return { format: "sfnt", tables: readSfntTables(buffer) };
  }
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x00010000) {
    return { format: "sfnt", tables: readSfntTables(buffer) };
  }
  // A collection carries several faces and no single answer; it is read as the font it is not.
  return null;
}

/*
 * How wide a line of prose sets, as the weighted mean advance of the characters it is made of.
 *
 * The weights are the frequencies those characters have in running text, and the space carries the
 * largest of them by far -- it is the most common character in any prose and one of the narrowest
 * glyphs in most faces. Averaging the sample flat instead reports a font about a tenth wider than it
 * sets: measured against Fira Sans, flat gives 508 units where the weighted mean gives 459, and the
 * published reference figure is 458. A `size-adjust` built on the flat number would swap the substitute
 * out for a font ten percent narrower, which is the reflow this whole reader exists to prevent.
 *
 * English frequencies, used for every Site regardless of its language: the alternative is a table per
 * language and a decision about which one a page is in, for a second-order correction on a number whose
 * job is to be approximately right before the real font arrives.
 */
const PHI_FONT_WIDTH_SAMPLE_WEIGHTS: Readonly<Record<string, number>> = {
  a: 0.0668, b: 0.0122, c: 0.0228, d: 0.0348, e: 0.1039, f: 0.0182, g: 0.0165,
  h: 0.0499, i: 0.0570, j: 0.0009, k: 0.0063, l: 0.0330, m: 0.0202, n: 0.0574,
  o: 0.0614, p: 0.0158, q: 0.0008, r: 0.0491, s: 0.0531, t: 0.0746, u: 0.0227,
  v: 0.0079, w: 0.0194, x: 0.0015, y: 0.0161, z: 0.0006, " ": 0.1774,
};

const PHI_FONT_WIDTH_SAMPLE = Object.keys(PHI_FONT_WIDTH_SAMPLE_WEIGHTS).join("");

function readCmapUnicodeMap(cmap: Buffer | undefined) {
  if (!cmap || cmap.length < 4) return null;
  const numTables = cmap.readUInt16BE(2);
  let best: { offset: number; format: number } | null = null;
  for (let index = 0; index < numTables; index += 1) {
    const record = 4 + index * 8;
    if (record + 8 > cmap.length) break;
    const platformId = cmap.readUInt16BE(record);
    const encodingId = cmap.readUInt16BE(record + 2);
    const offset = cmap.readUInt32BE(record + 4);
    if (offset + 4 > cmap.length) continue;
    const format = cmap.readUInt16BE(offset);
    const unicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!unicode) continue;
    if (format === 4 || format === 12) {
      // Format 12 covers everything format 4 does, so it wins where a font offers both.
      if (!best || (format === 12 && best.format !== 12)) best = { offset, format };
    }
  }
  if (!best) return null;

  const map = new Map<number, number>();
  if (best.format === 4) {
    const segCountX2 = cmap.readUInt16BE(best.offset + 6);
    const segCount = segCountX2 / 2;
    const endCodes = best.offset + 14;
    const startCodes = endCodes + segCountX2 + 2;
    const idDeltas = startCodes + segCountX2;
    const idRangeOffsets = idDeltas + segCountX2;
    if (idRangeOffsets + segCountX2 > cmap.length) return null;
    for (const character of PHI_FONT_WIDTH_SAMPLE) {
      const code = character.codePointAt(0)!;
      for (let segment = 0; segment < segCount; segment += 1) {
        if (cmap.readUInt16BE(endCodes + segment * 2) < code) continue;
        if (cmap.readUInt16BE(startCodes + segment * 2) > code) break;
        const idDelta = cmap.readInt16BE(idDeltas + segment * 2);
        const idRangeOffset = cmap.readUInt16BE(idRangeOffsets + segment * 2);
        if (idRangeOffset === 0) {
          map.set(code, (code + idDelta) & 0xffff);
          break;
        }
        const start = cmap.readUInt16BE(startCodes + segment * 2);
        const glyphOffset = idRangeOffsets + segment * 2 + idRangeOffset + (code - start) * 2;
        if (glyphOffset + 2 > cmap.length) break;
        const glyphId = cmap.readUInt16BE(glyphOffset);
        if (glyphId !== 0) map.set(code, (glyphId + idDelta) & 0xffff);
        break;
      }
    }
    return map;
  }

  const numGroups = cmap.readUInt32BE(best.offset + 12);
  for (let group = 0; group < numGroups; group += 1) {
    const record = best.offset + 16 + group * 12;
    if (record + 12 > cmap.length) break;
    const startCode = cmap.readUInt32BE(record);
    const endCode = cmap.readUInt32BE(record + 4);
    const startGlyph = cmap.readUInt32BE(record + 8);
    for (const character of PHI_FONT_WIDTH_SAMPLE) {
      const code = character.codePointAt(0)!;
      if (code >= startCode && code <= endCode) map.set(code, startGlyph + (code - startCode));
    }
  }
  return map;
}

function readAverageAdvance(tables: TableMap, numberOfHMetrics: number) {
  const hmtx = tables.get("hmtx");
  const glyphIds = readCmapUnicodeMap(tables.get("cmap"));
  if (!hmtx || !glyphIds || glyphIds.size === 0 || numberOfHMetrics <= 0) return null;
  let total = 0;
  let weight = 0;
  for (const [character, characterWeight] of Object.entries(PHI_FONT_WIDTH_SAMPLE_WEIGHTS)) {
    const glyphId = glyphIds.get(character.codePointAt(0)!);
    if (glyphId == null) return null;
    // Past the last full metric every glyph repeats that one's advance, which is how monospace ends.
    const offset = Math.min(glyphId, numberOfHMetrics - 1) * 4;
    if (offset + 2 > hmtx.length) return null;
    total += hmtx.readUInt16BE(offset) * characterWeight;
    weight += characterWeight;
  }
  // A font missing part of the sample is not a font this measure says anything about.
  return weight > 0 ? Math.round(total / weight) : null;
}

export function readPhiFontMetrics(buffer: Buffer): PhiFontMetrics | null {
  const read = readTables(buffer);
  if (!read) return null;
  const { format, tables } = read;
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  if (!head || head.length < 54 || !hhea || hhea.length < 36) return null;

  const unitsPerEm = head.readUInt16BE(18);
  if (!unitsPerEm) return null;

  const os2 = tables.get("OS/2");
  /*
   * `hhea` is what a browser lays lines out with, so it answers first. `OS/2` is consulted only where
   * `hhea` says nothing -- a font with a zero ascent is broken in the same way for everyone, and
   * quietly substituting another table's number would hide that.
   */
  const ascent = hhea.readInt16BE(4) || (os2 && os2.length >= 72 ? os2.readInt16BE(68) : 0);
  const descent = hhea.readInt16BE(6) || (os2 && os2.length >= 74 ? os2.readInt16BE(70) : 0);
  const lineGap = hhea.readInt16BE(8) || (os2 && os2.length >= 76 ? os2.readInt16BE(72) : 0);
  const numberOfHMetrics = hhea.readUInt16BE(34);

  const capHeight = os2 && os2.length >= 90 ? os2.readInt16BE(88) : null;
  const xHeight = os2 && os2.length >= 88 ? os2.readInt16BE(86) : null;
  const glyphWidth = readAverageAdvance(tables, numberOfHMetrics);
  const os2Width = os2 && os2.length >= 4 ? os2.readInt16BE(2) : 0;

  const post = tables.get("post");

  return {
    format,
    familyName: readFamilyName(tables.get("name")),
    unitsPerEm,
    ascent,
    descent,
    lineGap,
    capHeight: capHeight || null,
    xHeight: xHeight || null,
    xWidthAvg: glyphWidth ?? (os2Width > 0 ? os2Width : null),
    xWidthAvgSource: glyphWidth ? "glyphs" : os2Width > 0 ? "os2" : null,
    category: readCategory(os2, post),
  };
}

/**
 * Serif, sans or monospace, from whichever of the two classifications the font bothered to fill in.
 *
 * PANOSE first, because it is the more specific: byte 0 says the font is Latin text at all, byte 1 is
 * the serif style, and byte 3 says monospaced. The `OS/2` family class answers where PANOSE is blank.
 * Fixed pitch outranks both -- a monospaced serif is substituted by a monospaced face, not by Times.
 */
function readCategory(os2: Buffer | undefined, post: Buffer | undefined): PhiFontMetrics["category"] {
  if (post && post.length >= 16 && post.readUInt32BE(12) !== 0) return "monospace";
  if (os2 && os2.length >= 42) {
    const panose = os2.subarray(32, 42);
    if (panose[0] === 2) {
      if (panose[3] === 9) return "monospace";
      const serifStyle = panose[1]!;
      if (serifStyle >= 2 && serifStyle <= 10) return "serif";
      if (serifStyle >= 11 && serifStyle <= 13) return "sans-serif";
    }
  }
  if (os2 && os2.length >= 32) {
    // Classes 1 to 7 are the serif families and 8 is the sans; the rest say nothing either way.
    const familyClass = os2.readInt16BE(30) >> 8;
    if (familyClass >= 1 && familyClass <= 7) return "serif";
    if (familyClass === 8) return "sans-serif";
  }
  return null;
}

/** The typographic family, which is the name a Theme will write down. */
function readFamilyName(name: Buffer | undefined) {
  if (!name || name.length < 6) return null;
  const count = name.readUInt16BE(2);
  const stringOffset = name.readUInt16BE(4);
  let fallback: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const record = 6 + index * 12;
    if (record + 12 > name.length) break;
    const platformId = name.readUInt16BE(record);
    const nameId = name.readUInt16BE(record + 6);
    // 16 is the typographic family where a font has one, 1 the family it falls back to.
    if (nameId !== 1 && nameId !== 16) continue;
    const length = name.readUInt16BE(record + 8);
    const offset = stringOffset + name.readUInt16BE(record + 10);
    const value = sliceTable(name, offset, length);
    if (!value) continue;
    // Platform 3 and platform 0 store UTF-16BE; platform 1 is a single byte per character.
    const text = platformId === 1 ? value.toString("latin1") : value.toString("utf16le").length === value.length
      ? value.swap16().toString("utf16le")
      : Buffer.from(value).swap16().toString("utf16le");
    const trimmed = text.replace(/\0/g, "").trim();
    if (!trimmed) continue;
    if (nameId === 16) return trimmed;
    fallback ??= trimmed;
  }
  return fallback;
}
