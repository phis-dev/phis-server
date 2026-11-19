import { PHIS_CDN_KEY_SEGMENT_PATTERN } from "@phis/contracts/addon";
import type { PhisCdnFileV1 } from "@phis/contracts/addon";

/*
 * A Site's CDN, the parts the CLI and the Server share: what a key is, what a public address is, and
 * which content types a file may be published under. No SQL and no I/O, so both sides can load it.
 *
 * See GROUPS_AND_STORAGE.md, "A Site's CDN".
 */

/** The bits of `site_cdn_files.flags`. */
export const PhisCdnFileFlags = {
  /**
   * No longer offered: not listed, read as null through `cdn:v1`, and its key stays taken. Whether the
   * bytes are still in the bucket is the storage's answer, not this row's.
   */
  Withdrawn: 1 << 0,
} as const;

/** The most files one read returns; `cdn:v1` caps `limit` here. */
export const PHIS_CDN_LIST_LIMIT = 500;

/*
 * The first segment `api` is refused, because the CDN's host may share its name with a translation
 * mirror whose two doors are `/api/v1/tr` and `/api/v1/locales` (cdn.phis.dev does). A file under those
 * paths could never be reached, and refusing the whole segment keeps the rule one word long.
 */
const RESERVED_NAMES = new Set(["api"]);

export type PhisCdnKeyParts = { key: string; name: string; version: string; fileName: string };

/** The three segments of a key, or null when it is not `<name>/<version>/<file>` with valid segments. */
export function readPhisCdnKey(key: string): PhisCdnKeyParts | null {
  const segments = key.split("/");
  if (segments.length !== 3) return null;
  if (!segments.every((segment) => PHIS_CDN_KEY_SEGMENT_PATTERN.test(segment))) return null;
  const [name, version, fileName] = segments as [string, string, string];
  return { key, name, version, fileName };
}

/** The key a publish writes, refused with a reason an operator can act on. */
export function buildPhisCdnKey(name: string, version: string, fileName: string): PhisCdnKeyParts {
  for (const [label, segment] of [["--name", name], ["--version", version], ["the file name", fileName]] as const) {
    if (!PHIS_CDN_KEY_SEGMENT_PATTERN.test(segment)) {
      throw new Error(
        `${label} "${segment}" is not a CDN key segment: letters, digits and . _ + -, not starting with a dot, at most 200.`,
      );
    }
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error(`--name "${name}" is reserved: the CDN host may serve /api/ for something else.`);
  }
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

export type PhisCdnFileRow = {
  object_key: string;
  name: string;
  version: string;
  file_name: string;
  size_bytes: string | number;
  sha256: string;
  content_type: string;
  flags: number;
  published_at: Date | string;
};

export function presentPhisCdnFile(row: PhisCdnFileRow, publicBaseUrl: string): PhisCdnFileV1 {
  return {
    key: row.object_key,
    name: row.name,
    version: row.version,
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    publishedAt: new Date(row.published_at).toISOString(),
    url: phisCdnPublicUrl(publicBaseUrl, row.object_key),
  };
}
