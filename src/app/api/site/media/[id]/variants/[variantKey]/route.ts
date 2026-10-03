import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { ensureImageAssetVariant } from "@/lib/image-variants";
import { canDeliverMediaAsset, mediaDeliveryCacheControl, mediaDeliverySafetyHeaders } from "@/lib/media-delivery";
import { requireSiteFromRequest } from "@/lib/site-context";

async function deliver(
  request: NextRequest,
  rawId: string,
  rawVariantKey: string,
) {
  const site = await requireSiteFromRequest(request);
  const id = Number.parseInt(rawId, 10);
  const variantKey = Number.parseInt(rawVariantKey, 10);
  if (!site || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(variantKey) || variantKey < 0) {
    return new NextResponse(null, { status: 404 });
  }
  const asset = await getMediaAssetBySiteAndId(site.id, id);
  if (!asset || !await canDeliverMediaAsset(request, asset)) {
    return new NextResponse(null, { status: 404 });
  }
  // The variant as ensured: its head and its storage come with it, so nothing here reads them again.
  const variant = await ensureImageAssetVariant(asset, variantKey);
  if (!variant) return new NextResponse(null, { status: 404 });
  const { head, storage } = variant;
  const contentType = head.contentType || variant.contentType;
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(head.byteSize),
    etag: `"${head.etag}"`,
    "cache-control": mediaDeliveryCacheControl(request, asset),
    "last-modified": new Date(head.lastModifiedAt).toUTCString(),
    ...mediaDeliverySafetyHeaders(contentType, asset.originalName),
  });
  if (request.method === "HEAD") return new NextResponse(null, { status: 200, headers });
  const body = await storage.getObjectStream(variant.storageKey);
  return body
    ? new NextResponse(body, { status: 200, headers })
    : new NextResponse(null, { status: 404 });
}

type Context = { params: Promise<{ id: string; variantKey: string }> };

export async function GET(request: NextRequest, context: Context) {
  const params = await context.params;
  return deliver(request, params.id, params.variantKey);
}

export async function HEAD(request: NextRequest, context: Context) {
  const params = await context.params;
  return deliver(request, params.id, params.variantKey);
}
