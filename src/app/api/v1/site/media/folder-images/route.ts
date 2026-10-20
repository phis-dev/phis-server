import { NextResponse } from "next/server";

import { listMediaFolderDescendantIds, listPublicSiteSpaceMediaImagesInFolders, type PublicMediaFolderImagesSort } from "@/db/media";
import { ensureSiteMediaSpace } from "@/db/media-spaces";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { serializeMediaAssetForPublicReference } from "@/lib/media-response";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/** However many a Folder holds, a page gets at most this many; the Widget asks for fewer. */
const MAX_FOLDER_IMAGES = 200;
const DEFAULT_FOLDER_IMAGES = 50;

function parsePositiveInt(value: string | null) {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The public pictures of a Media Folder, for a page that shows a Folder rather than named Assets.
 *
 * Internal token only: the session-guarded `/api/site/media` is the library's own view and needs a
 * Media role, which a public render has not got. What comes back is the public reference projection,
 * the same one `/api/v1/site/references` answers for named Assets, so a Widget draws both alike. The
 * Folder must be in the Site Space; a Group's Folder answers empty rather than leaking its pictures.
 */
export async function GET(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const url = new URL(request.url);
  const folderId = parsePositiveInt(url.searchParams.get("folderId"));
  if (!folderId) return NextResponse.json({ error: "Invalid folder." }, { status: 400 });
  const subfolders = url.searchParams.get("subfolders") !== "0";
  const sortParam = url.searchParams.get("sort") ?? "name_asc";
  if (sortParam !== "name_asc" && sortParam !== "created_at_desc") {
    return NextResponse.json({ error: "Invalid sort." }, { status: 400 });
  }
  const sort: PublicMediaFolderImagesSort = sortParam;
  const limit = Math.min(parsePositiveInt(url.searchParams.get("limit")) ?? DEFAULT_FOLDER_IMAGES, MAX_FOLDER_IMAGES);

  const { space } = await ensureSiteMediaSpace(site.id);
  const folderIds = subfolders
    ? await listMediaFolderDescendantIds(site.id, space.id, folderId)
    : [folderId];
  const assets = (await listPublicSiteSpaceMediaImagesInFolders(site.id, { folderIds, sort, limit }))
    .map(serializeMediaAssetForPublicReference);
  return NextResponse.json({ folderId, subfolders, sort, assets });
}
