import "server-only";

/**
 * What a file actually is, decided from its first bytes rather than from what the uploader called it.
 *
 * The declared content type reaches the server in a request body, so it is a claim by the one party a
 * content rule exists for. This reads the object instead. It is deliberately hand-written and small:
 * every answer it gives is one a security decision is made on, and a dependency that quietly learns a
 * new format is a dependency that quietly changes that decision.
 *
 * It is a floor and not a roof. Text formats carry no magic bytes, so SVG and HTML are recognized by
 * shape rather than proven, and a file crafted to be two things at once will be read as one of them.
 * `mediaDeliverySafetyHeaders` is what makes the residue harmless, and stays necessary regardless.
 */

/** Enough for every signature below, including the first ZIP entry name and the tar magic at 257. */
export const PHI_MEDIA_SNIFF_HEAD_BYTES = 4096;

export type PhiMediaSniffOutcome = {
  /** What the bytes say, or `null` when they do not say anything. */
  contentType: string | null;
  /** How the answer was reached, so a caller can tell proof from shape. */
  evidence: "signature" | "text" | "container" | "none";
};

type Signature = {
  contentType: string;
  offset: number;
  bytes: readonly number[];
  /** A second run of bytes that must also match, for formats whose magic is split. */
  also?: { offset: number; bytes: readonly number[] };
};

const ascii = (value: string) => [...value].map((character) => character.charCodeAt(0));

/*
 * Order matters where one signature is a prefix of another's context: the RIFF and ISO-BMFF families
 * are distinguished by a second run, so those entries come before anything that would match on the
 * container alone.
 */
const SIGNATURES: readonly Signature[] = [
  { contentType: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { contentType: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { contentType: "image/gif", offset: 0, bytes: ascii("GIF87a") },
  { contentType: "image/gif", offset: 0, bytes: ascii("GIF89a") },
  { contentType: "image/webp", offset: 0, bytes: ascii("RIFF"), also: { offset: 8, bytes: ascii("WEBP") } },
  { contentType: "audio/wav", offset: 0, bytes: ascii("RIFF"), also: { offset: 8, bytes: ascii("WAVE") } },
  { contentType: "image/avif", offset: 4, bytes: ascii("ftypavif") },
  { contentType: "image/avif", offset: 4, bytes: ascii("ftypavis") },
  { contentType: "image/heic", offset: 4, bytes: ascii("ftypheic") },
  { contentType: "audio/mp4", offset: 4, bytes: ascii("ftypM4A") },
  { contentType: "video/mp4", offset: 4, bytes: ascii("ftypisom") },
  { contentType: "video/mp4", offset: 4, bytes: ascii("ftypmp42") },
  { contentType: "video/mp4", offset: 4, bytes: ascii("ftypMSNV") },
  { contentType: "video/quicktime", offset: 4, bytes: ascii("ftypqt  ") },
  { contentType: "image/bmp", offset: 0, bytes: ascii("BM") },
  { contentType: "image/tiff", offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
  { contentType: "image/tiff", offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { contentType: "image/vnd.microsoft.icon", offset: 0, bytes: [0x00, 0x00, 0x01, 0x00] },
  { contentType: "video/webm", offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { contentType: "video/ogg", offset: 0, bytes: ascii("OggS") },
  { contentType: "audio/flac", offset: 0, bytes: ascii("fLaC") },
  { contentType: "audio/mpeg", offset: 0, bytes: ascii("ID3") },
  { contentType: "application/pdf", offset: 0, bytes: ascii("%PDF-") },
  /*
   * Fonts, so an upload is a font rather than a blob.
   *
   * Without a signature here the bytes fall through to `application/octet-stream`, which is stored and
   * then read back as the `binary` kind -- and a Theme looking for the typeface it owns would be
   * searching among installers. The TrueType magic `00 01 00 00` is not the icon magic `00 00 01 00`
   * above it, so the two do not shadow each other.
   */
  { contentType: "font/woff2", offset: 0, bytes: ascii("wOF2") },
  { contentType: "font/woff", offset: 0, bytes: ascii("wOFF") },
  { contentType: "font/otf", offset: 0, bytes: ascii("OTTO") },
  { contentType: "font/collection", offset: 0, bytes: ascii("ttcf") },
  { contentType: "font/ttf", offset: 0, bytes: [0x00, 0x01, 0x00, 0x00] },
  { contentType: "application/x-7z-compressed", offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { contentType: "application/x-rar-compressed", offset: 0, bytes: ascii("Rar!") },
  { contentType: "application/gzip", offset: 0, bytes: [0x1f, 0x8b] },
  { contentType: "application/x-tar", offset: 257, bytes: ascii("ustar") },
  { contentType: "application/x-executable", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { contentType: "application/x-msdownload", offset: 0, bytes: ascii("MZ") },
  { contentType: "application/x-mach-binary", offset: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { contentType: "application/x-mach-binary", offset: 0, bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { contentType: "application/x-rpm", offset: 0, bytes: [0xed, 0xab, 0xee, 0xdb] },
  { contentType: "application/vnd.debian.binary-package", offset: 0, bytes: ascii("!<arch>") },
];

function matches(head: Buffer, offset: number, bytes: readonly number[]) {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

/*
 * Every OOXML and ODF document is a ZIP, so the container alone cannot answer which one. ODF says so
 * itself: its first entry is `mimetype` carrying the literal type. OOXML only reveals `[Content_Types]
 * .xml` that early, so the declared type is allowed to refine it -- the bytes still prove it is a ZIP,
 * and nothing dangerous is a ZIP, so the refinement can only pick among archive-shaped answers.
 */
const ZIP_REFINABLE = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/epub+zip",
  "application/java-archive",
]);

function sniffZip(head: Buffer, declaredContentType: string): PhiMediaSniffOutcome {
  const text = head.subarray(0, 512).toString("latin1");
  const odf = /mimetype(application\/vnd\.oasis\.opendocument\.[a-z-]+)/u.exec(text);
  if (odf) return { contentType: odf[1]!, evidence: "container" };
  if (ZIP_REFINABLE.has(declaredContentType)) {
    return { contentType: declaredContentType, evidence: "container" };
  }
  return { contentType: "application/zip", evidence: "signature" };
}

/** Text carries no magic, so the two formats that can run in the Site's origin are pinned by shape. */
function sniffText(head: Buffer, declaredContentType: string): PhiMediaSniffOutcome | null {
  if (head.includes(0)) return null;
  /*
   * A head is a prefix, so the last character may be cut in half. That is not evidence of anything:
   * decode the whole run first and only give ground a byte at a time if it will not decode.
   */
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string | null = null;
  for (let trimmed = 0; trimmed <= 3 && trimmed < head.length; trimmed += 1) {
    try {
      text = decoder.decode(head.subarray(0, head.length - trimmed));
      break;
    } catch {
      text = null;
    }
  }
  if (text === null) return null;

  const leading = text.replace(/^[\s﻿]+/u, "").slice(0, 512).toLowerCase();
  if (leading.startsWith("<!doctype html") || leading.startsWith("<html")) {
    return { contentType: "text/html", evidence: "text" };
  }
  if (leading.startsWith("<svg") || (leading.startsWith("<?xml") && leading.includes("<svg"))) {
    return { contentType: "image/svg+xml", evidence: "text" };
  }
  // Anything else textual keeps the label it came with, as long as that label is itself textual.
  const declared = declaredContentType.trim().toLowerCase().split(";", 1)[0]!.trim();
  if (declared.startsWith("text/") && declared !== "text/html") {
    return { contentType: declared, evidence: "text" };
  }
  if (declared === "application/json" || declared === "application/xml" || declared === "application/rtf") {
    return { contentType: declared, evidence: "text" };
  }
  return { contentType: "text/plain", evidence: "text" };
}

/**
 * Reads the first bytes of an object and says what it is.
 *
 * `declaredContentType` is consulted only where the bytes are genuinely ambiguous -- which ZIP, which
 * flavour of text -- and never to override something the bytes settled.
 */
export function sniffPhiMediaContentType(head: Buffer, declaredContentType: string): PhiMediaSniffOutcome {
  if (head.length === 0) return { contentType: null, evidence: "none" };

  if (matches(head, 0, [0x50, 0x4b, 0x03, 0x04])) return sniffZip(head, declaredContentType);
  for (const signature of SIGNATURES) {
    if (!matches(head, signature.offset, signature.bytes)) continue;
    if (signature.also && !matches(head, signature.also.offset, signature.also.bytes)) continue;
    return { contentType: signature.contentType, evidence: "signature" };
  }

  return sniffText(head, declaredContentType) ?? { contentType: null, evidence: "none" };
}

/**
 * The type an Asset is stored and served as.
 *
 * Unidentified bytes become `application/octet-stream` rather than keeping their claim: an object
 * nothing recognizes is bytes, and calling it what it was labelled would carry the claim into delivery.
 */
export function resolvePhiMediaStoredContentType(outcome: PhiMediaSniffOutcome) {
  return outcome.contentType ?? "application/octet-stream";
}
