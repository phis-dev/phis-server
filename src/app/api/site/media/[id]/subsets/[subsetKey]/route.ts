import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { ensureFontAssetSubset } from "@/lib/font-subsets";
import { canDeliverMediaAsset, mediaDeliveryCacheControl, mediaDeliverySafetyHeaders } from "@/lib/media-delivery";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { requireSiteFromRequest } from "@/lib/site-context";

/**
 * One unicode cut of a font Asset, made on the first request for it.
 *
 * A route beside `/variants` rather than a kind of variant: that route answers a non-image with a fixed
 * icon by contract, and a cut is not a rendition of a picture. Delivery is the original's -- the same
 * policy check before any lookup, the same revision-keyed caching -- because a cut is the same file,
 * only shorter.
 */
async function deliver(request: NextRequest, rawId: string, rawSubsetKey: string) {
  const site = await requireSiteFromRequest(request);
  const id = Number.parseInt(rawId, 10);
  const subsetKey = Number.parseInt(rawSubsetKey, 10);
  if (!site || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(subsetKey) || subsetKey < 0) {
    return new NextResponse(null, { status: 404 });
  }
  const asset = await getMediaAssetBySiteAndId(site.id, id);
  if (!asset || !await canDeliverMediaAsset(request, asset)) {
    return new NextResponse(null, { status: 404 });
  }
  const subset = await ensureFontAssetSubset(asset, subsetKey);
  if (!subset) return new NextResponse(null, { status: 404 });
  const profile = await getMediaStorageProfile(site.id, subset.storageProfileId);
  if (!profile) return NextResponse.json({ error: "Storage Profile unavailable." }, { status: 503 });
  const storage = await createPhisMediaStorageServiceForProfile(profile);
  const head = await storage.headObject(subset.storageKey);
  if (!head) return new NextResponse(null, { status: 404 });
  const contentType = "font/woff2";
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(head.byteSize),
    etag: `"${head.etag}"`,
    "cache-control": mediaDeliveryCacheControl(request, asset),
    "last-modified": new Date(head.lastModifiedAt).toUTCString(),
    ...mediaDeliverySafetyHeaders(contentType, asset.originalName),
  });
  if (request.method === "HEAD") return new NextResponse(null, { status: 200, headers });
  const body = await storage.getObjectStream(subset.storageKey);
  return body
    ? new NextResponse(body, { status: 200, headers })
    : new NextResponse(null, { status: 404 });
}

type Context = { params: Promise<{ id: string; subsetKey: string }> };

export async function GET(request: NextRequest, context: Context) {
  const params = await context.params;
  return deliver(request, params.id, params.subsetKey);
}

export async function HEAD(request: NextRequest, context: Context) {
  const params = await context.params;
  return deliver(request, params.id, params.subsetKey);
}
