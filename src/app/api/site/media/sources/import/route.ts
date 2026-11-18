import { NextRequest, NextResponse } from "next/server";

import { ensureSiteMediaSpace } from "@/db/media-spaces";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { normalizeString, parseStrictPositiveInt, readJsonObjectBody } from "@/lib/helpers/request";
import { serializeMediaAssetForTile } from "@/lib/media-response";
import { importMediaSourceItem, MediaSourceError } from "@/lib/media-sources";

export const dynamic = "force-dynamic";

/**
 * Takes one item of a media source into the Site Space: `{ source, itemId, folderId? }`.
 *
 * Answers `{ asset }`, the Asset as the Media listing shows a tile -- the one that was made, or the one
 * that already held these bytes. Behind write access to the Site Space, as `uploads/init` is for it.
 */
export async function POST(request: NextRequest) {
  const { site, session, error } = await requireMediaSpaceWriteContext(request, async ({ site: ownSite }) =>
    (await ensureSiteMediaSpace(ownSite.id)).space.id);
  if (error) {
    return error;
  }
  if (!session) {
    return NextResponse.json({ error: "authentication_required", message: "Authentication required." }, { status: 401 });
  }

  const body = await readJsonObjectBody(request);
  if (!body) {
    return NextResponse.json({ error: "invalid_json_body", message: "Invalid JSON body." }, { status: 400 });
  }
  const source = normalizeString(body.source);
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const folderId = body.folderId == null ? null : parseStrictPositiveInt(body.folderId);
  if (!source || !itemId) {
    return NextResponse.json(
      { error: "invalid_request", message: "An import needs a source and an item." },
      { status: 400 },
    );
  }
  if (body.folderId != null && folderId === null) {
    return NextResponse.json({ error: "invalid_folder", message: "Invalid Folder." }, { status: 400 });
  }

  try {
    const asset = await importMediaSourceItem({
      site: { id: site.id, key: site.key },
      source,
      itemId,
      folderId,
      actorUserId: session.userId,
    });
    return NextResponse.json({ asset: serializeMediaAssetForTile(asset) });
  } catch (cause) {
    if (cause instanceof MediaSourceError) {
      return NextResponse.json({ error: cause.code, message: cause.message }, { status: cause.status });
    }
    throw cause;
  }
}
