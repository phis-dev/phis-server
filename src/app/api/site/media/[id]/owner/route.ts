import { NextRequest, NextResponse } from "next/server";

import { getMediaAssetBySiteAndId, setMediaAssetOwner } from "@/db/media";
import { getMediaSpaceById, PhisMediaSpaceKind } from "@/db/media-spaces";
import {
  canTransferMediaAssetOwnership,
  requireMediaAssetContext,
} from "@/lib/guards/site-media-api";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaAssetForDetail } from "@/lib/media-response";
import { parsePositiveInt } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * Handing one Asset over.
 *
 * Its own address because it is its own act. Folding it into the Asset PATCH would have made the one
 * field that ends someone else's access indistinguishable from a change of title, and both the
 * authority it needs and the record it leaves are different.
 *
 * Who may: the owner gives away what is theirs, an Editor reaches into someone else's ownership. Giving
 * away is never the dangerous direction -- one is dropping one's own rights -- so it needs nothing
 * beyond owning the Asset, whether it goes to a person or to `null`. `null` means the group's rather
 * than anyone's, which is what a receipt handed to a case becomes and what a deleted account leaves
 * behind. Taking, passing on, and releasing someone *else's* are the Editor acts.
 *
 * The recipient must already be in the group -- ownership carries rights, and handing it outside would
 * grant across the group boundary rather than inside it.
 *
 * `created_by_user_id` does not move. Whoever brought the Asset in stays recorded as having done so
 * after they can no longer touch it -- that is what makes a handed-over receipt still attributable.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  let siteKey: string | null = null;
  try {
    const resolvedParams = await Promise.resolve(params);
    const assetId = parsePositiveInt(resolvedParams.id);
    if (!assetId) {
      return NextResponse.json({ error: "Missing asset id." }, { status: 400 });
    }

    // Reading the Asset is the floor for being told anything about it; the transfer itself is
    // authorized below, against the row this returns.
    const { site, session, siteWide, error } = await requireMediaAssetContext(request, assetId, "read");
    if (error) {
      return error;
    }
    siteKey = site.key;

    const body = await request.json().catch(() => null) as { ownerUserId?: unknown } | null;
    if (!body || !("ownerUserId" in body)) {
      return NextResponse.json({ error: "Missing ownerUserId." }, { status: 400 });
    }
    const nextOwnerUserId = body.ownerUserId == null
      ? null
      : parsePositiveInt(String(body.ownerUserId));
    if (body.ownerUserId != null && nextOwnerUserId == null) {
      return NextResponse.json({ error: "Invalid ownerUserId." }, { status: 400 });
    }

    const asset = await getMediaAssetBySiteAndId(site.id, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
    }
    const space = await getMediaSpaceById(site.id, asset.spaceId);
    if (!space || space.kind !== PhisMediaSpaceKind.Group) {
      // A User Space has one owner by construction and the Site Space has none; neither is handed over.
      return NextResponse.json({ error: "media_asset_owner_fixed" }, { status: 409 });
    }

    // The guard's session; it is present on every pass, so there is nothing to read again.
    const actorUserId = session?.userId ?? null;
    if (actorUserId == null) {
      return NextResponse.json({ error: "media_asset_owner_forbidden" }, { status: 403 });
    }

    /*
     * Site Media authority reached this route without any group standing, so asking for its level would
     * read zero and refuse an administrator. Administration transfers because it administers; everyone
     * else transfers by their level in the group, and the two are separate answers rather than one.
     */
    const allowed = siteWide || await canTransferMediaAssetOwnership({
      siteId: site.id,
      groupId: space.groupId,
      actorId: actorUserId,
      ownerUserId: asset.ownerUserId,
      nextOwnerUserId,
    });
    if (!allowed) {
      return NextResponse.json({ error: "media_asset_owner_forbidden" }, { status: 403 });
    }

    const updated = await setMediaAssetOwner({
      siteId: site.id,
      assetId,
      ownerUserId: nextOwnerUserId,
      actorUserId,
    });
    if (!updated) {
      return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
    }

    // The handover is the record. There is no audit table, and the pair of columns says who brought the
    // Asset in and who holds it now, but neither says who moved it or when.
    logRuntimeEvent("info", "media.asset.owner_transferred", {
      siteKey,
      userId: actorUserId,
      targetType: "media-asset",
      targetId: assetId,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        groupId: space.groupId,
        previousOwnerUserId: asset.ownerUserId,
        ownerUserId: nextOwnerUserId,
      },
    });

    return NextResponse.json({ asset: serializeMediaAssetForDetail(updated) });
  } catch (error) {
    logRuntimeEvent("error", "media.asset.owner_transfer_failed", {
      message: error instanceof Error ? error.message : "Media asset owner transfer failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json(
      { error: "media_asset_owner_transfer_failed", message: "Media asset owner transfer failed." },
      { status: 500 },
    );
  }
}
