export const PhiMediaAssetFlags = {
  Private: 1 << 0,
  Archived: 1 << 1,
  Restricted: 1 << 2,
  Featured: 1 << 3,
  Locked: 1 << 4,
  Mask: 1 << 5,
} as const;

/**
 * Availability of the non-Site Media Space kinds, per `GROUPS_AND_STORAGE.md` section 7.
 *
 * Availability is a capability and is deliberately separate from quota: `0` means the Space kind does
 * not exist for this Site, which is rejected distinguishably from an exhausted quota. The Site Space is
 * never governed by these flags.
 */
export const PhiSiteMediaFlags = {
  UserSpacesEnabled: 1 << 0,
  GroupSpacesEnabled: 1 << 1,
} as const;

export const PhiMediaFolderFlags = {
  Collapsed: 1 << 0,
  Hidden: 1 << 1,
  Locked: 1 << 2,
} as const;

export const PhiMediaKind = {
  Image: "image",
  Video: "video",
  Audio: "audio",
  Pdf: "pdf",
  Markdown: "markdown",
  Document: "document",
  Archive: "archive",
  /*
   * Arbitrary bytes, offered as a download and nothing else.
   *
   * Separate from `Other` because the two mean opposite things to a declaration: `Binary` is a Module
   * saying it wants executables and disk images, while `Other` is the answer for a type nothing has
   * classified. Without it, a Module that legitimately distributes an installer would have to declare
   * the catch-all to get one.
   */
  Binary: "binary",
  Other: "other",
} as const;

export const PhiImageAssetVariantKey = {
  Thumbnail: 0,
  Preview: 1,
  Banner: 2,
  Header: 3,
  Card: 4,
  Hero: 5,
  Avatar: 6,
  Logo: 7,
  Landscape: 8,
  Portrait: 9,
} as const;

export const PhiImageAssetVariantKeyName = {
  [PhiImageAssetVariantKey.Thumbnail]: "thumbnail",
  [PhiImageAssetVariantKey.Preview]: "preview",
  [PhiImageAssetVariantKey.Banner]: "banner",
  [PhiImageAssetVariantKey.Header]: "header",
  [PhiImageAssetVariantKey.Card]: "card",
  [PhiImageAssetVariantKey.Hero]: "hero",
  [PhiImageAssetVariantKey.Avatar]: "avatar",
  [PhiImageAssetVariantKey.Logo]: "logo",
  [PhiImageAssetVariantKey.Landscape]: "landscape",
  [PhiImageAssetVariantKey.Portrait]: "portrait",
} as const;

export type PhiImageAssetVariantSpec = {
  width: number;
  height: number;
  fit: "cover" | "contain";
  quality: number;
  format: "webp";
};

export function hasPhiMediaAssetFlag(flags: number | null | undefined, flag: number) {
  return typeof flags === "number" && (flags & flag) === flag;
}

export function isPhiMediaAssetPublic(flags: number | null | undefined) {
  return (
    !hasPhiMediaAssetFlag(flags, PhiMediaAssetFlags.Private) &&
    !hasPhiMediaAssetFlag(flags, PhiMediaAssetFlags.Archived) &&
    !hasPhiMediaAssetFlag(flags, PhiMediaAssetFlags.Restricted)
  );
}

export function hasPhiMediaFolderFlag(flags: number | null | undefined, flag: number) {
  return typeof flags === "number" && (flags & flag) === flag;
}

export function normalizePhiMediaKind(kind: string | null | undefined) {
  const normalized = (kind ?? "").trim().toLowerCase();
  if (
    normalized === PhiMediaKind.Image ||
    normalized === PhiMediaKind.Video ||
    normalized === PhiMediaKind.Audio ||
    normalized === PhiMediaKind.Pdf ||
    normalized === PhiMediaKind.Markdown ||
    normalized === PhiMediaKind.Document ||
    normalized === PhiMediaKind.Archive ||
    normalized === PhiMediaKind.Binary
  ) {
    return normalized;
  }

  return PhiMediaKind.Other;
}

export function resolvePhiMediaKindFromContentType(contentType: string | null | undefined) {
  const normalized = (contentType ?? "").trim().toLowerCase();
  if (!normalized) {
    return PhiMediaKind.Other;
  }

  if (normalized.startsWith("image/")) {
    return PhiMediaKind.Image;
  }
  if (normalized.startsWith("video/")) {
    return PhiMediaKind.Video;
  }
  if (normalized.startsWith("audio/")) {
    return PhiMediaKind.Audio;
  }
  if (normalized === "application/pdf") {
    return PhiMediaKind.Pdf;
  }
  if (normalized === "text/markdown") {
    return PhiMediaKind.Markdown;
  }
  if (
    normalized === "application/msword" ||
    normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalized === "application/rtf" ||
    normalized === "text/plain" ||
    normalized === "application/vnd.oasis.opendocument.text"
  ) {
    return PhiMediaKind.Document;
  }
  if (
    normalized === "application/zip" ||
    normalized === "application/x-7z-compressed" ||
    normalized === "application/x-rar-compressed" ||
    normalized === "application/x-tar"
  ) {
    return PhiMediaKind.Archive;
  }
  /*
   * `application/octet-stream` belongs here rather than with the unclassified: an unlabelled blob is
   * bytes, and a Module declaring `binary` is saying it accepts exactly that.
   */
  if (
    normalized === "application/octet-stream" ||
    normalized === "application/x-msdownload" ||
    normalized === "application/vnd.microsoft.portable-executable" ||
    normalized === "application/x-executable" ||
    normalized === "application/x-mach-binary" ||
    normalized === "application/x-msi" ||
    normalized === "application/x-apple-diskimage" ||
    normalized === "application/vnd.debian.binary-package" ||
    normalized === "application/x-rpm"
  ) {
    return PhiMediaKind.Binary;
  }

  return PhiMediaKind.Other;
}

export function normalizePhiImageAssetVariantKey(key: unknown) {
  const parsed =
    typeof key === "number"
      ? key
      : Number.parseInt(typeof key === "string" ? key.trim() : "", 10);
  if (
    Number.isInteger(parsed) &&
    Object.prototype.hasOwnProperty.call(PhiImageAssetVariantKeyName, parsed)
  ) {
    return parsed as (typeof PhiImageAssetVariantKey)[keyof typeof PhiImageAssetVariantKey];
  }

  return null;
}

export function resolvePhiImageAssetVariantKeyName(
  key: number | null | undefined,
): string | null {
  if (typeof key !== "number" || !Number.isInteger(key)) {
    return null;
  }

  return PhiImageAssetVariantKeyName[key as keyof typeof PhiImageAssetVariantKeyName] ?? null;
}

export function resolvePhiImageAssetVariantSpec(
  key: number | null | undefined,
): PhiImageAssetVariantSpec | null {
  switch (key) {
    case PhiImageAssetVariantKey.Thumbnail:
      return { width: 256, height: 256, fit: "cover", quality: 80, format: "webp" };
    case PhiImageAssetVariantKey.Preview:
      return { width: 640, height: 360, fit: "cover", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Banner:
      return { width: 1600, height: 89, fit: "cover", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Header:
      return { width: 1920, height: 144, fit: "cover", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Card:
      return { width: 960, height: 640, fit: "cover", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Hero:
      return { width: 1600, height: 900, fit: "cover", quality: 84, format: "webp" };
    case PhiImageAssetVariantKey.Avatar:
      return { width: 100, height: 100, fit: "cover", quality: 80, format: "webp" };
    case PhiImageAssetVariantKey.Logo:
      return { width: 512, height: 256, fit: "contain", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Landscape:
      return { width: 640, height: 396, fit: "cover", quality: 82, format: "webp" };
    case PhiImageAssetVariantKey.Portrait:
      return { width: 396, height: 640, fit: "cover", quality: 82, format: "webp" };
    default:
      return null;
  }
}

export function buildPhiImageAssetVariantPublicUrl(
  publicUrl: string,
  variantKey: number | null | undefined,
  variantVersion: number | null | undefined = 0,
) {
  const normalizedUrl = (publicUrl ?? "").trim();
  if (!normalizedUrl || typeof variantKey !== "number" || !Number.isInteger(variantKey)) {
    return null;
  }

  const normalizedVersion =
    typeof variantVersion === "number" && Number.isInteger(variantVersion) && variantVersion >= 0
      ? variantVersion
      : 0;

  if (/^https?:\/\//i.test(normalizedUrl)) {
    const url = new URL(normalizedUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/variant/${variantKey}/v/${normalizedVersion}`;
    return url.toString();
  }

  return `${normalizedUrl.replace(/\/+$/, "")}/variant/${variantKey}/v/${normalizedVersion}`;
}
