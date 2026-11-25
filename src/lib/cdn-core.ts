import {
  PHIS_CDN_FILE_ARCH_MASK,
  PHIS_CDN_FILE_OS_MASK,
  PHIS_CDN_KEY_SEGMENT_PATTERN,
  PHIS_CDN_KEY_VERSION_PATTERN,
  PhisCdnFileArch,
  PhisCdnFileOrigin,
  PhisCdnFileOs,
} from "@phis/contracts/addon";
import type {
  PhisCdnAdminFileState,
  PhisCdnAdminFileV1,
  PhisCdnFileOriginKind,
  PhisCdnFileStorage,
  PhisCdnFileV1,
  PhisCdnUploadStatus,
} from "@phis/contracts/addon";

/*
 * A Site's CDN, the parts the CLI and the Server share: what a key is, what a public address is, which
 * content types a file may be published under, and how a catalogue row's `flags` are laid out. No SQL
 * and no I/O, so both sides can load it.
 *
 * See GROUPS_AND_STORAGE.md, "A Site's CDN".
 */

/**
 * The state bits of `site_cdn_files.flags`: bits 0-7. Bits 8-15 hold the operating systems and bits
 * 16-23 the architectures a file is for (`PHIS_CDN_FILE_OS_SHIFT`, `PHIS_CDN_FILE_ARCH_SHIFT`); 24-30
 * are reserved and 31 stays free, so the column never reads negative.
 */
export const PhisCdnFileFlags = {
  /**
   * No longer offered: not listed, read as null through `cdn:v1`, and its key stays taken. Whether the
   * bytes are still in the bucket is the storage's answer, not this row's -- unless `Deleted` is set.
   */
  Withdrawn: 1 << 0,
  /**
   * Withdrawn and its bytes removed from the bucket, by whoever withdrew it with `--delete` or deleted it
   * on the CDN page. Always set together with `Withdrawn`. For a link: withdrawn and the entry kept, since
   * there were no bytes to remove.
   */
  Deleted: 1 << 1,
  /**
   * The bytes are not in the bucket and never were: Core keeps the entry, and the source's address in
   * `site_cdn_file_origins.source_url` is where a visitor is sent (`storage: "link"`).
   */
  Linked: 1 << 2,
} as const;

/** The state bits, bits 0-7; what lies above them is the platform. */
export const PHIS_CDN_FILE_STATE_MASK = 0xff;
/** Where the `PhisCdnFileOs` bits sit inside `site_cdn_files.flags`. */
export const PHIS_CDN_FILE_OS_SHIFT = 8;
/** Where the `PhisCdnFileArch` bits sit inside `site_cdn_files.flags`. */
export const PHIS_CDN_FILE_ARCH_SHIFT = 16;

/** The operating systems a row's flags state, as `PhisCdnFileOs` bits. */
export function readPhisCdnFileOs(flags: number) {
  return (flags >>> PHIS_CDN_FILE_OS_SHIFT) & PHIS_CDN_FILE_OS_MASK;
}

/** The architectures a row's flags state, as `PhisCdnFileArch` bits. */
export function readPhisCdnFileArch(flags: number) {
  return (flags >>> PHIS_CDN_FILE_ARCH_SHIFT) & PHIS_CDN_FILE_ARCH_MASK;
}

/** Whether `os` and `arch` hold only bits the contract names; a caller's fault otherwise. */
export function isPhisCdnPlatform(os: number, arch: number) {
  return Number.isInteger(os) && Number.isInteger(arch) && os >= 0 && arch >= 0
    && (os & ~PHIS_CDN_FILE_OS_MASK) === 0 && (arch & ~PHIS_CDN_FILE_ARCH_MASK) === 0;
}

/** The platform part of a row's flags, from the wire's two fields. Throws on a bit the contract does not name. */
export function encodePhisCdnPlatformFlags(os: number, arch: number) {
  if (!isPhisCdnPlatform(os, arch)) {
    throw new Error("os and arch must be PhisCdnFileOs and PhisCdnFileArch bits.");
  }
  return (os << PHIS_CDN_FILE_OS_SHIFT) | (arch << PHIS_CDN_FILE_ARCH_SHIFT);
}

/*
 * The tables below are built on first use, not when the module loads: they read the contracts' constants,
 * and a module graph that evaluates this file before `@phis/contracts` (a cycle, a stale dev chunk) must
 * not fail every importer of the catalogue.
 */
let osNames: Readonly<Record<string, number>> | null = null;
let archNames: Readonly<Record<string, number>> | null = null;

/** The names `phis cdn publish --os` takes, lowercase, as the contract's constants are named. */
export function phisCdnOsNames(): Readonly<Record<string, number>> {
  return osNames ??= Object.freeze(Object.fromEntries(
    Object.entries(PhisCdnFileOs).map(([name, bit]) => [name.toLowerCase(), bit]),
  ));
}

/** The names `phis cdn publish --arch` takes. */
export function phisCdnArchNames(): Readonly<Record<string, number>> {
  return archNames ??= Object.freeze(Object.fromEntries(
    Object.entries(PhisCdnFileArch).map(([name, bit]) => [name.toLowerCase(), bit]),
  ));
}

function readPlatformNames(input: string, names: Readonly<Record<string, number>>, flag: string) {
  let bits = 0;
  for (const raw of input.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const bit = names[name];
    if (bit === undefined) {
      throw new Error(`${flag} "${raw.trim()}" is not one of: ${Object.keys(names).join(", ")}.`);
    }
    bits |= bit;
  }
  return bits;
}

/** `--os linux,macos` as `PhisCdnFileOs` bits. */
export function readPhisCdnOsNames(input: string) {
  return readPlatformNames(input, phisCdnOsNames(), "--os");
}

/** `--arch x64,arm64` as `PhisCdnFileArch` bits. */
export function readPhisCdnArchNames(input: string) {
  return readPlatformNames(input, phisCdnArchNames(), "--arch");
}

/** The names of the bits set, in the contract's order: what `phis cdn list` prints. */
export function namePhisCdnPlatform(os: number, arch: number) {
  const pick = (names: Readonly<Record<string, number>>, bits: number) =>
    Object.entries(names).filter(([, bit]) => (bits & bit) !== 0).map(([name]) => name);
  return { os: pick(phisCdnOsNames(), os), arch: pick(phisCdnArchNames(), arch) };
}

/** The extensions whose operating system nobody has to state: an installer is for one system. */
function osByExtension(extension: string): number {
  switch (extension) {
    case "dmg": case "pkg": return PhisCdnFileOs.MacOS;
    case "exe": case "msi": return PhisCdnFileOs.Windows;
    case "deb": case "rpm": return PhisCdnFileOs.Linux;
    case "apk": return PhisCdnFileOs.Android;
    default: return 0;
  }
}

/** The architecture names packages carry in their file names (`phis_0.8.1-1+trixie_amd64.deb`). */
function archByToken(token: string): number | undefined {
  switch (token) {
    case "amd64": case "x86_64": case "x64": return PhisCdnFileArch.X64;
    case "arm64": case "aarch64": return PhisCdnFileArch.Arm64;
    case "i386": case "i686": case "x86": return PhisCdnFileArch.X86;
    case "armhf": case "armel": case "armv7": return PhisCdnFileArch.Arm32;
    case "riscv64": return PhisCdnFileArch.RiscV64;
    default: return undefined;
  }
}

/**
 * The platform a file name states where it is obvious: the operating system from an installer's
 * extension (.dmg/.pkg macOS, .exe/.msi Windows, .deb/.rpm Linux, .apk Android), the architecture from
 * one architecture name among the name's parts. Zero where the name says nothing, and for the
 * architecture also where it names two.
 */
export function guessPhisCdnPlatform(fileName: string) {
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const os = osByExtension(extension);
  const found = new Set<number>();
  for (const token of fileName.toLowerCase().split(/[._+~-]/u)) {
    const bit = archByToken(token);
    if (bit !== undefined) found.add(bit);
  }
  // x86_64 splits on its own underscore; read it whole as well.
  if (/(^|[._+~-])x86_64([._+~-]|$)/u.test(fileName.toLowerCase())) {
    found.delete(PhisCdnFileArch.X86);
    found.add(PhisCdnFileArch.X64);
  }
  const arch = found.size === 1 ? [...found][0]! : 0;
  return { os, arch };
}

/**
 * `site_cdn_uploads.status`. Open below `Published`, which is what the partial unique index on open rows
 * reads (`status < 4`); the numbers are the stored contract and the names are the wire's
 * (`PhisCdnUploadStatus`).
 */
export const PhisCdnUploadStatusCode = {
  Pending: 1,
  Uploading: 2,
  Hashing: 3,
  Published: 4,
  Failed: 5,
  Aborted: 6,
} as const;

const UPLOAD_STATUS_NAMES: Readonly<Record<number, PhisCdnUploadStatus>> = {
  [PhisCdnUploadStatusCode.Pending]: "pending",
  [PhisCdnUploadStatusCode.Uploading]: "uploading",
  [PhisCdnUploadStatusCode.Hashing]: "hashing",
  [PhisCdnUploadStatusCode.Published]: "published",
  [PhisCdnUploadStatusCode.Failed]: "failed",
  [PhisCdnUploadStatusCode.Aborted]: "aborted",
};

export function namePhisCdnUploadStatus(status: number): PhisCdnUploadStatus {
  const name = UPLOAD_STATUS_NAMES[status];
  if (!name) throw new Error(`${status} is not a CDN upload status.`);
  return name;
}

/** The most files one read returns; `cdn:v1` caps `limit` here. */
export const PHIS_CDN_LIST_LIMIT = 500;

/*
 * The first segment `api` is refused, because the CDN's host may share its name with a translation
 * mirror whose two doors are `/api/v1/tr` and `/api/v1/locales` (cdn.phis.dev does). A file under those
 * paths could never be reached, and refusing the whole segment keeps the rule one word long.
 */
const RESERVED_NAMES = new Set(["api"]);

export type PhisCdnKeyParts = { key: string; name: string; version: string; fileName: string };

/** Whether each segment holds its own pattern: the version may carry a colon, name and file name may not. */
function isPhisCdnKeySegments(name: string, version: string, fileName: string) {
  return PHIS_CDN_KEY_SEGMENT_PATTERN.test(name)
    && PHIS_CDN_KEY_VERSION_PATTERN.test(version)
    && PHIS_CDN_KEY_SEGMENT_PATTERN.test(fileName);
}

/** The three segments of a key, or null when it is not `<name>/<version>/<file>` with valid segments. */
export function readPhisCdnKey(key: string): PhisCdnKeyParts | null {
  const segments = key.split("/");
  if (segments.length !== 3) return null;
  const [name, version, fileName] = segments as [string, string, string];
  if (!isPhisCdnKeySegments(name, version, fileName)) return null;
  return { key, name, version, fileName };
}

/** Why three segments are not a key a publish may write, or null when they are one. */
export function explainPhisCdnKeyRefusal(name: string, version: string, fileName: string): string | null {
  const segments = [
    ["--name", name, PHIS_CDN_KEY_SEGMENT_PATTERN, "letters, digits and . _ + ~ -"],
    ["--version", version, PHIS_CDN_KEY_VERSION_PATTERN, "letters, digits and . _ + ~ : -"],
    ["the file name", fileName, PHIS_CDN_KEY_SEGMENT_PATTERN, "letters, digits and . _ + ~ -"],
  ] as const;
  for (const [label, segment, pattern, allowed] of segments) {
    if (typeof segment !== "string" || !pattern.test(segment)) {
      return `${label} "${String(segment)}" is not a CDN key segment: ${allowed}, not starting with a dot, tilde or colon, at most 200.`;
    }
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return `--name "${name}" is reserved: the CDN host may serve /api/ for something else.`;
  }
  return null;
}

/** The key a publish writes, refused with a reason an operator can act on. */
export function buildPhisCdnKey(name: string, version: string, fileName: string): PhisCdnKeyParts {
  const refusal = explainPhisCdnKeyRefusal(name, version, fileName);
  if (refusal) throw new Error(refusal);
  return { key: `${name}/${version}/${fileName}`, name, version, fileName };
}

/**
 * The CDN's public base URL as stored: `https`, a host, optionally a path, no trailing slash, no query.
 *
 * A path is allowed because a bucket may sit behind a prefix of somebody else's host; the address of a
 * file is always this base, a slash, and the encoded key.
 */
export function readPhisCdnPublicBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`"${input}" is not a URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`The CDN's public base URL must be https, not ${url.protocol}.`);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("The CDN's public base URL takes no query, fragment or credentials.");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

export function phisCdnPublicUrl(publicBaseUrl: string, key: string) {
  return `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Content types a CDN file is refused under, whatever its extension or `--content-type` says.
 *
 * A page or a script served from the CDN's host would run there, and that host is usually a subdomain of
 * the Site's own (`cdn.phis.dev` beside `phis.dev`) -- close enough to set cookies the Site reads. The
 * CDN is for files people download or a page embeds as media, and none of those is one of these.
 */
const REFUSED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/x-javascript",
]);

const REFUSED_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "xslt", "js", "mjs", "cjs"]);

/** What an extension is published as. Lowercase extension without the dot. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // Archives and compression
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  xz: "application/x-xz",
  zst: "application/zstd",
  bz2: "application/x-bzip2",
  "7z": "application/x-7z-compressed",
  // Packages and installers
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  apk: "application/vnd.android.package-archive",
  dmg: "application/x-apple-diskimage",
  pkg: "application/octet-stream",
  msi: "application/x-msi",
  exe: "application/vnd.microsoft.portable-executable",
  appimage: "application/octet-stream",
  iso: "application/x-iso9660-image",
  img: "application/octet-stream",
  // Models and data
  safetensors: "application/octet-stream",
  gguf: "application/octet-stream",
  onnx: "application/octet-stream",
  bin: "application/octet-stream",
  pt: "application/octet-stream",
  pth: "application/octet-stream",
  ckpt: "application/octet-stream",
  npz: "application/octet-stream",
  parquet: "application/vnd.apache.parquet",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  // Media
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  // Checksums and signatures that travel beside a download
  sha256: "text/plain",
  sig: "application/pgp-signature",
  asc: "application/pgp-signature",
};

const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

/**
 * The content type a file is published under: the one stated, else the extension's, else
 * `application/octet-stream`. No look at the bytes: the publisher is the operator, and the formats the
 * CDN is for (weights, installers) are ones a sniffer does not know anyway. What sniffing would guard
 * against -- a page in disguise -- is refused here by type and by extension instead.
 */
export function resolvePhisCdnContentType(fileName: string, stated?: string | null): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  if (REFUSED_EXTENSIONS.has(extension)) {
    throw new Error(`A .${extension} file is not published on the CDN: a page or a script would run on its host.`);
  }
  const type = (stated?.trim() || CONTENT_TYPES[extension] || "application/octet-stream").toLowerCase();
  const essence = type.split(";")[0]!.trim();
  if (!CONTENT_TYPE_PATTERN.test(essence)) throw new Error(`"${type}" is not a content type.`);
  if (REFUSED_CONTENT_TYPES.has(essence) || essence.endsWith("+xml")) {
    throw new Error(`${essence} is not published on the CDN: a page or a script would run on its host.`);
  }
  return type;
}

/** A catalogue row with its origin, as `src/db/site-cdn.mts` reads it. */
export type PhisCdnFileRow = {
  id: string | number;
  object_key: string;
  name: string;
  version: string;
  file_name: string;
  size_bytes: string | number;
  sha256: string;
  content_type: string;
  flags: number;
  published_at: Date | string;
  /** Null only for a row written before origins were recorded and missed by the sweep (DB.md). */
  origin: number | null;
  origin_addon_id: string | null;
  origin_actor_user_id: number | null;
  source_url: string | null;
};

export function isPhisCdnFileLinked(row: Pick<PhisCdnFileRow, "flags">) {
  return (row.flags & PhisCdnFileFlags.Linked) !== 0;
}

export function presentPhisCdnFile(row: PhisCdnFileRow, publicBaseUrl: string): PhisCdnFileV1 & {
  storage: PhisCdnFileStorage; os: number; arch: number;
} {
  const linked = isPhisCdnFileLinked(row);
  if (linked && !row.source_url) {
    throw new Error(`The CDN link ${row.object_key} has no source address; its origin row is missing.`);
  }
  return {
    key: row.object_key,
    name: row.name,
    version: row.version,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    publishedAt: new Date(row.published_at).toISOString(),
    url: linked ? row.source_url! : phisCdnPublicUrl(publicBaseUrl, row.object_key),
    storage: linked ? "link" : "cdn",
    os: readPhisCdnFileOs(row.flags),
    arch: readPhisCdnFileArch(row.flags),
  };
}

function nameOrigin(origin: number | null): PhisCdnFileOriginKind | undefined {
  switch (origin) {
    case PhisCdnFileOrigin.Cli: return "cli";
    case PhisCdnFileOrigin.Upload: return "upload";
    case PhisCdnFileOrigin.Addon: return "addon";
    default: return undefined;
  }
}

export function readPhisCdnFileState(flags: number): PhisCdnAdminFileState {
  if ((flags & PhisCdnFileFlags.Deleted) !== 0) return "deleted";
  if ((flags & PhisCdnFileFlags.Withdrawn) !== 0) return "withdrawn";
  return "offered";
}

/** One file as the CDN page shows it. A row without an origin is a sweep that did not run, never a CLI file. */
export function presentPhisCdnAdminFile(row: PhisCdnFileRow, publicBaseUrl: string): PhisCdnAdminFileV1 {
  const kind = nameOrigin(row.origin);
  if (!kind) {
    throw new Error(`The CDN file ${row.object_key} has no origin; run the origin sweep in DB.md.`);
  }
  return {
    ...presentPhisCdnFile(row, publicBaseUrl),
    state: readPhisCdnFileState(row.flags),
    origin: {
      kind,
      addonId: row.origin_addon_id,
      actorUserId: row.origin_actor_user_id,
      sourceUrl: row.source_url,
    },
  };
}
