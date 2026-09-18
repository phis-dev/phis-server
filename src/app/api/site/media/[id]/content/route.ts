import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { canDeliverMediaAsset, mediaDeliveryCacheControl, mediaDeliverySafetyHeaders } from "@/lib/media-delivery";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { requireSiteFromRequest } from "@/lib/site-context";

async function deliver(request: NextRequest, rawId: string) {
  const site = await requireSiteFromRequest(request);
  const id = Number.parseInt(rawId, 10);
  if (!site || !Number.isSafeInteger(id) || id <= 0) return new NextResponse(null, { status: 404 });
  const asset = await getMediaAssetBySiteAndId(site.id, id);
  if (!asset || !await canDeliverMediaAsset(request, asset)) return new NextResponse(null, { status: 404 });
  const profile = await getMediaStorageProfile(site.id, asset.storageProfileId);
  if (!profile) return NextResponse.json({ error: "Storage Profile unavailable." }, { status: 503 });
  const storage = await createPhisMediaStorageServiceForProfile(profile, site.key)
  const head = await storage.headObject(asset.storageKey);
  if (!head) return new NextResponse(null, { status: 404 });
  const contentType = head.contentType || asset.contentType;
  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(head.byteSize),
    etag: `"${head.etag}"`,
    "cache-control": mediaDeliveryCacheControl(request, asset),
    "last-modified": new Date(head.lastModifiedAt).toUTCString(),
    ...mediaDeliverySafetyHeaders(contentType, asset.originalName),
  });
  if (request.method === "HEAD") return new NextResponse(null, { status: 200, headers });
  // Streamed, not read: delivery only moves bytes, and holding the object would make the largest
  // one a Site accepts the memory a single download costs.
  const body = await storage.getObjectStream(asset.storageKey);
  return body ? new NextResponse(body, { status: 200, headers }) : new NextResponse(null, { status: 404 });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return deliver(request, (await context.params).id);
}
export async function HEAD(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return deliver(request, (await context.params).id);
}
