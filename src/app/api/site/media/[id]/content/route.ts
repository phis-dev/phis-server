/**
 * The bytes of one Asset, whole or in part.
 *
 * `Range` is answered for every Asset, which is what a browser needs before it will seek in a video: a
 * single `bytes=` range becomes `206` with a `Content-Range`, a first byte past the end becomes `416`, and
 * anything this does not have to honour -- several ranges, another unit, syntax that does not parse --
 * becomes the complete object, which is always a correct answer.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import {
  canDeliverMediaAsset,
  mediaDeliveryCacheControl,
  mediaDeliverySafetyHeaders,
  parsePhiMediaRangeRequest,
} from "@/lib/media-delivery";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { requireSiteFromRequest } from "@/lib/site-context";
import { parseStrictPositiveInt } from "@/lib/helpers/request";

async function deliver(request: NextRequest, rawId: string) {
  const site = await requireSiteFromRequest(request);
  const id = parseStrictPositiveInt(rawId);
  if (!site || id == null) return new NextResponse(null, { status: 404 });
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
    /*
     * Announced on every response, including the complete one and the `HEAD`.
     *
     * A player decides whether it can seek from this header before it ever sends a `Range`, and Safari
     * commonly declines to play a video at all where it is missing. Saying it once the ranged read exists
     * is therefore not a courtesy but the thing that makes the read reachable.
     */
    "accept-ranges": "bytes",
    ...mediaDeliverySafetyHeaders(contentType, asset.originalName),
  });
  if (request.method === "HEAD") return new NextResponse(null, { status: 200, headers });

  const requested = parsePhiMediaRangeRequest(request.headers.get("range"), head.byteSize);
  if (requested.kind === "unsatisfiable") {
    /*
     * The one range that must not be answered with the whole object: a first byte past the end means the
     * caller is wrong about the size, and a complete body would tell it the seek worked.
     */
    return new NextResponse(null, {
      status: 416,
      headers: new Headers({
        "content-range": `bytes */${head.byteSize}`,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      }),
    });
  }

  if (requested.kind === "range") {
    const ranged = await storage.getObjectRangeStream(asset.storageKey, requested);
    if (!ranged) return new NextResponse(null, { status: 404 });

    /*
     * What the Provider says it served, never what was asked for. A Provider that disregarded the range
     * hands back the whole object, and labelling that `206` with a `Content-Range` naming a slice would be
     * a lie a player then acts on -- so the complete body is delivered as the complete body.
     */
    const servesWholeObject = ranged.range.offset === 0 && ranged.range.length >= ranged.byteSize;
    if (servesWholeObject) {
      headers.set("content-length", String(ranged.byteSize));
      return new NextResponse(ranged.body, { status: 200, headers });
    }

    const last = ranged.range.offset + ranged.range.length - 1;
    headers.set("content-length", String(ranged.range.length));
    headers.set("content-range", `bytes ${ranged.range.offset}-${last}/${ranged.byteSize}`);
    return new NextResponse(ranged.body, { status: 206, headers });
  }

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
