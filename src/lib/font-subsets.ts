import "server-only";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import {
  isPhiCodepointInRanges,
  isPhiFontSubsetKey,
  PHI_FONT_SUBSET_RANGES,
  PHI_FONT_SUBSET_VERSION,
  PhiFontSubsetKey,
  type PhiFontSubsetKeyValue,
} from "@phis/contracts/media";

import { getFontAssetSubsetByAssetIdAndKey, upsertFontAssetSubset, type MediaAssetRecord } from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { PhiMediaKind, resolvePhiMediaKindFromContentType } from "@/lib/constants/media";
import { readPhiFontCodepoints, resolvePhiFontCoverage } from "@/lib/font-metrics";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

/**
 * A typeface, cut along one unicode range and delivered as woff2.
 *
 * An uploaded font is whatever was uploaded -- a whole family with Cyrillic and Greek where a page sets
 * Latin. Declared once per cut with `unicode-range`, it lets a browser fetch the one or two cuts a page
 * actually renders from, which is what Google Fonts and therefore `next/font` already do. A cut is made
 * on first request and kept beside the original, which stays untouched and is what every later cut
 * reads; `PHI_FONT_SUBSET_VERSION` throws every stored cut away when the rule changes.
 *
 * HarfBuzz does the cutting, through its own subset build compiled to WebAssembly: the module has no
 * imports, so it runs inside this process with nothing on the host to install. It reads sfnt, so a
 * woff2 is unpacked first and a woff reassembled; a font collection holds several faces and no single
 * cut, and is left whole.
 */

const require = createRequire(import.meta.url);

type HarfBuzzSubsetExports = {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_or_fail(face: number, input: number): number;
};

/** HB_MEMORY_MODE_WRITABLE: the blob owns a copy HarfBuzz may use in place. */
const HB_MEMORY_MODE_WRITABLE = 2;

let harfBuzzSubset: Promise<HarfBuzzSubsetExports> | null = null;

/*
 * Resolved by Node at run time, from the project root, with a specifier the bundler cannot read.
 * Turbopack rewrites every statically visible `require.resolve` in server code -- the `.wasm` specifier
 * into a wasm module placeholder, the package itself into a `[project]/...` path -- and neither names a
 * file on disk. The server's working directory is the project root in dev and in the standalone build,
 * whose trace keeps the file (`outputFileTracingIncludes` in `next.config.ts`).
 */
const HARFBUZZ_SUBSET_WASM = ["harfbuzzjs", "dist", "harfbuzz-subset.wasm"];

function resolveHarfBuzzSubsetWasmPath() {
  const projectRequire = createRequire(join(process.cwd(), "package.json"));
  return projectRequire.resolve(HARFBUZZ_SUBSET_WASM.join("/"));
}

/** One instance for the process: the module is stateless between calls and its memory is freed after each. */
function loadHarfBuzzSubset() {
  harfBuzzSubset ??= readFile(resolveHarfBuzzSubsetWasmPath())
    .then((bytes) => WebAssembly.instantiate(bytes, {}))
    .then(({ instance }) => instance.exports as unknown as HarfBuzzSubsetExports);
  return harfBuzzSubset;
}

async function loadWoff2() {
  return require("wawoff2") as { compress(input: Uint8Array): Promise<Uint8Array>; decompress(input: Uint8Array): Promise<Uint8Array> };
}

/**
 * A woff, reassembled into the sfnt it was packed from.
 *
 * Each table is stored deflated or as it was, with its original checksum beside it, so reassembly is a
 * table directory and the tables padded to four bytes -- nothing is recomputed that the file did not
 * already carry.
 */
function woffToSfnt(buffer: Buffer): Buffer | null {
  if (buffer.length < 44) return null;
  const flavor = buffer.readUInt32BE(4);
  const numTables = buffer.readUInt16BE(12);
  const tables: { tag: Buffer; checksum: number; data: Buffer }[] = [];
  for (let index = 0; index < numTables; index += 1) {
    const record = 44 + index * 20;
    if (record + 20 > buffer.length) return null;
    const offset = buffer.readUInt32BE(record + 4);
    const compressedLength = buffer.readUInt32BE(record + 8);
    const originalLength = buffer.readUInt32BE(record + 12);
    if (offset + compressedLength > buffer.length) return null;
    const stored = buffer.subarray(offset, offset + compressedLength);
    const data = compressedLength < originalLength ? inflateSync(stored) : stored;
    if (data.length !== originalLength) return null;
    tables.push({ tag: buffer.subarray(record, record + 4), checksum: buffer.readUInt32BE(record + 16), data });
  }
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  const header = Buffer.alloc(12 + numTables * 16);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    table.tag.copy(header, record);
    header.writeUInt32BE(table.checksum, record + 4);
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(table.data.length, record + 12);
    const padded = Buffer.alloc(Math.ceil(table.data.length / 4) * 4);
    table.data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

async function toSfnt(buffer: Buffer): Promise<Buffer | null> {
  const signature = buffer.toString("latin1", 0, 4);
  if (signature === "wOF2") return Buffer.from(await (await loadWoff2()).decompress(buffer));
  if (signature === "wOFF") return woffToSfnt(buffer);
  if (signature === "OTTO" || signature === "true" || buffer.readUInt32BE(0) === 0x00010000) return buffer;
  return null;
}

/** The sfnt that keeps only the given characters, or null when HarfBuzz refuses the font. */
async function subsetSfnt(sfnt: Buffer, codepoints: readonly number[]): Promise<Buffer | null> {
  const hb = await loadHarfBuzzSubset();
  const fontPointer = hb.malloc(sfnt.length);
  if (!fontPointer) return null;
  new Uint8Array(hb.memory.buffer, fontPointer, sfnt.length).set(sfnt);
  const blob = hb.hb_blob_create(fontPointer, sfnt.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const input = hb.hb_subset_input_create_or_fail();
  try {
    if (!input) return null;
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const codepoint of codepoints) hb.hb_set_add(unicodes, codepoint);
    const subset = hb.hb_subset_or_fail(face, input);
    if (!subset) return null;
    const resultBlob = hb.hb_face_reference_blob(subset);
    const length = hb.hb_blob_get_length(resultBlob);
    const dataPointer = hb.hb_blob_get_data(resultBlob, 0);
    // Copied out before anything is freed: the view is into the module's memory, which the next call reuses.
    const result = length > 0 ? Buffer.from(new Uint8Array(hb.memory.buffer, dataPointer, length)) : null;
    hb.hb_blob_destroy(resultBlob);
    hb.hb_face_destroy(subset);
    return result;
  } finally {
    if (input) hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(fontPointer);
  }
}

/** The characters a cut is made of: those of the font inside its ranges, or outside all of them for `Rest`. */
export function selectPhiFontSubsetCodepoints(codepoints: readonly number[], key: PhiFontSubsetKeyValue) {
  if (key === PhiFontSubsetKey.Rest) {
    const named = Object.values(PHI_FONT_SUBSET_RANGES);
    return codepoints.filter((codepoint) => !named.some((ranges) => isPhiCodepointInRanges(codepoint, ranges)));
  }
  const ranges = PHI_FONT_SUBSET_RANGES[key];
  return codepoints.filter((codepoint) => isPhiCodepointInRanges(codepoint, ranges));
}

/**
 * One cut of a font as woff2, from the font's bytes; null where the font has nothing in it or cannot be
 * cut. Separate from storage so a test can hold a real font to it.
 */
export async function cutPhiFontSubset(original: Buffer, key: PhiFontSubsetKeyValue): Promise<Buffer | null> {
  const codepoints = readPhiFontCodepoints(original);
  if (!codepoints) return null;
  const selected = selectPhiFontSubsetCodepoints(codepoints, key);
  if (selected.length === 0) return null;
  const sfnt = await toSfnt(original);
  if (!sfnt) return null;
  const subset = await subsetSfnt(sfnt, selected);
  return subset ? Buffer.from(await (await loadWoff2()).compress(subset)) : null;
}

function buildSubsetStorageKey(assetStorageKey: string, key: PhiFontSubsetKeyValue) {
  return `${assetStorageKey.trim().replace(/\/+$/gu, "")}.__subsets/${key}.woff2`;
}

export type EnsureFontAssetSubsetResult = {
  storageProfileId: number;
  storageKey: string;
};

export async function ensureFontAssetSubset(
  asset: MediaAssetRecord,
  subsetKey: number,
): Promise<EnsureFontAssetSubsetResult | null> {
  if (resolvePhiMediaKindFromContentType(asset.contentType) !== PhiMediaKind.Font) return null;
  if (!isPhiFontSubsetKey(subsetKey)) return null;

  const storageFor = async (storageProfileId: number) => {
    const profile = await getMediaStorageProfile(asset.siteId, storageProfileId);
    if (!profile) throw new Error(`Media Storage Profile ${storageProfileId} is unavailable.`);
    return createPhisMediaStorageServiceForProfile(profile);
  };

  const existing = await getFontAssetSubsetByAssetIdAndKey(asset.id, subsetKey);
  if (existing && existing.subsetVersion === PHI_FONT_SUBSET_VERSION) {
    const head = await (await storageFor(existing.storageProfileId)).headObject(existing.storageKey);
    if (head) return { storageProfileId: existing.storageProfileId, storageKey: existing.storageKey };
  }

  const storage = await storageFor(asset.storageProfileId);
  const original = await storage.getObject(asset.storageKey);
  if (!original) return null;
  // The cuts that exist are the ones the upload recorded; a request for any other is answered with none.
  const codepoints = readPhiFontCodepoints(original);
  if (!codepoints || !resolvePhiFontCoverage(codepoints).subsets.includes(subsetKey)) return null;

  const woff2 = await cutPhiFontSubset(original, subsetKey);
  if (!woff2) return null;
  const storageKey = buildSubsetStorageKey(asset.storageKey, subsetKey);
  const stored = await storage.putObject({
    storageKey,
    body: woff2,
    contentType: "font/woff2",
    metadata: {
      assetId: String(asset.id),
      siteId: String(asset.siteId),
      sourceStorageKey: asset.storageKey,
      subsetKey: String(subsetKey),
      subsetVersion: String(PHI_FONT_SUBSET_VERSION),
    },
  });
  await upsertFontAssetSubset({
    assetId: asset.id,
    subsetKey,
    subsetVersion: PHI_FONT_SUBSET_VERSION,
    storageProfileId: asset.storageProfileId,
    storageKey,
    contentType: "font/woff2",
    bytes: stored.byteSize ?? woff2.length,
    checksumAlgorithm: "sha256",
    checksumValue: createHash("sha256").update(woff2).digest("hex"),
  });
  return { storageProfileId: asset.storageProfileId, storageKey };
}
