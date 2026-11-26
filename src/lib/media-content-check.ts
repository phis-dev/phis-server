import "server-only";

import sharp from "sharp";

import {
  isPhiMediaContentAllowedInSpace,
  type MediaSpaceRecord,
  type SiteMediaConfigRecord,
} from "@/db/media-spaces";
import {
  PHI_MEDIA_SNIFF_HEAD_BYTES,
  resolvePhiMediaStoredContentType,
  sniffPhiMediaContentType,
  type PhiMediaSniffOutcome,
} from "@/lib/media-content-sniffer";

/**
 * What an object is and whether it may be stored, shared by the two writers of a Media Asset.
 *
 * An upload's `finalize` and a Module's media import (design/MODULE_MEDIA.md) put the same question to
 * the bytes: what are they, does the Space accept that, is an SVG safe, is the image one the Asset's
 * columns can describe. `finalize` asks the steps one at a time, because it works from a prefix of a
 * stored object and has a duplicate check between two of them; the imports without an upload session --
 * a Module's media, a media source's item, `phis media import` (`site-media-write.ts`) -- hold the file, or
 * its first 64 MiB, and ask `inspectPhiMediaObject`, which runs the same steps in the same order.
 */

/** The largest edge an Asset can record: `media_assets.width`/`height` are SMALLINT. */
export const PHI_IMAGE_MAX_EDGE_PX = 32_767;

const SVG_MIN_DISPLAY_DIMENSION = 48;

/**
 * The SVG limit is a refusal, not a truncation. The scan looks for a script element anywhere in the
 * document, so reading a prefix would let one past by putting it late: an SVG too large to check is
 * not accepted rather than half-checked.
 */
export const PHI_SVG_SCAN_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * The image limit is a skip. Dimensions and the blur placeholder are conveniences; an Asset without
 * them is complete, so past the ceiling they are simply absent rather than worth a decode of that size.
 */
export const PHI_IMAGE_DECODE_LIMIT_BYTES = 64 * 1024 * 1024;

export function isSvgContentType(contentType: string) {
  return contentType.trim().toLowerCase().split(";", 1)[0] === "image/svg+xml";
}

function normalizeSvgMetadataDimensions(width: number | null, height: number | null) {
  if (!width || !height) {
    return {
      width: SVG_MIN_DISPLAY_DIMENSION,
      height: SVG_MIN_DISPLAY_DIMENSION,
    };
  }

  const shortestSide = Math.min(width, height);
  if (shortestSide >= SVG_MIN_DISPLAY_DIMENSION) {
    return { width, height };
  }

  const scale = SVG_MIN_DISPLAY_DIMENSION / shortestSide;
  return {
    width: Math.max(SVG_MIN_DISPLAY_DIMENSION, Math.round(width * scale)),
    height: Math.max(SVG_MIN_DISPLAY_DIMENSION, Math.round(height * scale)),
  };
}

export async function readImageMetadata(body: Buffer, contentType: string) {
  if (!contentType.trim().toLowerCase().startsWith("image/")) {
    return {
      width: null as number | null,
      height: null as number | null,
      blurDataUrl: null as string | null,
    };
  }

  try {
    const image = sharp(body, { failOn: "none" }).rotate();
    const metadata = await image.metadata();
    const rawWidth = metadata.width ?? null;
    const rawHeight = metadata.height ?? null;
    const { width, height } = isSvgContentType(contentType)
      ? normalizeSvgMetadataDimensions(rawWidth, rawHeight)
      : { width: rawWidth, height: rawHeight };

    let blurDataUrl: string | null = null;
    if (rawWidth && rawHeight) {
      const blurBuffer = await image
        .clone()
        .resize(16, 16, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 60 })
        .toBuffer();
      blurDataUrl = `data:image/webp;base64,${blurBuffer.toString("base64")}`;
    }

    return {
      width,
      height,
      blurDataUrl,
    };
  } catch {
    return {
      width: null as number | null,
      height: null as number | null,
      blurDataUrl: null as string | null,
    };
  }
}

export function validateSvgUpload(body: Buffer, contentType: string) {
  if (contentType.trim().toLowerCase() !== "image/svg+xml") {
    return null;
  }

  const source = body.toString("utf8");
  const normalized = source.toLowerCase();
  if (!normalized.includes("<svg")) {
    return "SVG upload does not contain an SVG root.";
  }
  if (/<script[\s>]/i.test(source)) {
    return "SVG uploads must not contain script elements.";
  }
  if (/<foreignobject[\s>]/i.test(source)) {
    return "SVG uploads must not contain foreignObject elements.";
  }
  if (/\son[a-z]+\s*=/i.test(source)) {
    return "SVG uploads must not contain event handler attributes.";
  }
  if (/\s(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i.test(source)) {
    return "SVG uploads must not contain external or executable references.";
  }

  return null;
}

/** One past the edge an Asset can record is refused with a reason instead of failing the insert. */
export function isPhiImageTooLarge(meta: { width: number | null; height: number | null }) {
  return (meta.width ?? 0) > PHI_IMAGE_MAX_EDGE_PX || (meta.height ?? 0) > PHI_IMAGE_MAX_EDGE_PX;
}

/**
 * What the bytes turned out to be, and whether the Space accepts that.
 *
 * A mismatch with the declared type is not itself a refusal: the stored type simply becomes the true
 * one. What is refused is the Space rule applied to what actually arrived.
 */
export function judgePhiMediaContent(
  head: Buffer,
  declaredContentType: string,
  /** Null where the Space could not be read: nothing to apply a Space rule to, as `finalize` always read it. */
  space: Pick<MediaSpaceRecord, "kind"> | null,
  mediaConfig: Pick<SiteMediaConfigRecord, "userSpaceContentKinds" | "groupSpaceContentKinds">,
): { contentType: string; sniffed: PhiMediaSniffOutcome; allowed: boolean } {
  const sniffed = sniffPhiMediaContentType(head, declaredContentType);
  const contentType = resolvePhiMediaStoredContentType(sniffed);
  return { contentType, sniffed, allowed: space === null || isPhiMediaContentAllowedInSpace(contentType, space, mediaConfig) };
}

export type PhiMediaObjectInspection =
  | {
    ok: true;
    contentType: string;
    width: number | null;
    height: number | null;
    blurDataUrl: string | null;
  }
  | {
    ok: false;
    code: "content_type_not_allowed" | "unsafe_svg_upload" | "image_too_large";
    message: string;
  };

/**
 * The three steps of `finalize` on an object in hand, in `finalize`'s order.
 *
 * `body` is the whole object, or -- where `byteLength` says the object is longer, as for a streamed import
 * past the image decode limit -- the start of it. That start is always longer than the sniffed head and
 * than the SVG scan limit, so every check is made exactly as on the whole object: the type from the head,
 * an SVG that long refused, an image that long not decoded.
 */
export async function inspectPhiMediaObject(input: {
  body: Buffer;
  byteLength?: number;
  declaredContentType: string;
  space: Pick<MediaSpaceRecord, "kind">;
  mediaConfig: Pick<SiteMediaConfigRecord, "userSpaceContentKinds" | "groupSpaceContentKinds">;
}): Promise<PhiMediaObjectInspection> {
  const { body } = input;
  const byteLength = Math.max(input.byteLength ?? 0, body.byteLength);
  const judged = judgePhiMediaContent(
    body.subarray(0, PHI_MEDIA_SNIFF_HEAD_BYTES),
    input.declaredContentType,
    input.space,
    input.mediaConfig,
  );
  if (!judged.allowed) {
    return {
      ok: false,
      code: "content_type_not_allowed",
      message: "That kind of file does not belong in this Media Space.",
    };
  }
  const { contentType } = judged;

  if (isSvgContentType(contentType)) {
    if (byteLength > PHI_SVG_SCAN_LIMIT_BYTES) {
      return {
        ok: false,
        code: "unsafe_svg_upload",
        message: `An SVG larger than ${PHI_SVG_SCAN_LIMIT_BYTES} bytes cannot be checked and is not accepted.`,
      };
    }
    const svgError = validateSvgUpload(body, contentType);
    if (svgError) return { ok: false, code: "unsafe_svg_upload", message: svgError };
  }

  const meta = contentType.trim().toLowerCase().startsWith("image/")
    && byteLength <= PHI_IMAGE_DECODE_LIMIT_BYTES
    ? await readImageMetadata(body, contentType)
    : { width: null, height: null, blurDataUrl: null };
  if (isPhiImageTooLarge(meta)) {
    return {
      ok: false,
      code: "image_too_large",
      message: `An image may be at most ${PHI_IMAGE_MAX_EDGE_PX} pixels on either edge.`,
    };
  }
  return { ok: true, contentType, width: meta.width, height: meta.height, blurDataUrl: meta.blurDataUrl };
}
