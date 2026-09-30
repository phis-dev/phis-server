import { NextRequest, NextResponse } from "next/server";

import {
  countMediaAssetsBySiteWithFilters,
  listMediaFolderDescendantIds,
  listMediaAssetsBySiteWithFilters,
  listMediaFolders,
} from "@/db/media";
import {
  readRequestedMediaSpaceId,
  requireMediaManagementSiteContext,
} from "@/lib/guards/site-media-api";
import { normalizePhiMediaKind } from "@/lib/constants/media";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaAssetForTile } from "@/lib/media-response";
import {
  ensureSiteMediaConfig,
  listSelectableMediaSpaces,
  resolveAuthorizedMediaSpace,
} from "@/db/media-spaces";
import { listSiteGroups } from "@/db/site-groups";
import {
  nextMediaSpaceError,
  serializeMediaSpace,
  serializeUnmaterializedGroupMediaSpace,
} from "@/lib/media-response";
import { parsePositiveInt, PHI_MAX_PAGE_SIZE } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function parseDateTimeOrNull(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function GET(request: NextRequest) {
  let siteKey: string | null = null;
  try {
    const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
    if (error) {
      return error;
    }
    siteKey = site.key;

    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const page = parsePositiveInt(url.searchParams.get("page"));
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"));
    const id = parsePositiveInt(url.searchParams.get("id"));
    const folderId = parsePositiveInt(url.searchParams.get("folderId"));
    /*
     * The name the list contract states in `DB.md`, and the one the site UI sends.
     *
     * It used to read `flags` here, which no caller has ever sent: a picked flag went out as
     * `presentationFlags`, arrived unread, and the list came back unfiltered -- silently, because an
     * absent filter is a valid request. The Mask picker and the Background Control both rest on it.
     */
    const presentationFlags = parsePositiveInt(url.searchParams.get("presentationFlags"));
    const kinds = [...new Set(url.searchParams.getAll("kind")
      .map((kind) => kind.trim())
      .filter(Boolean)
      .map(normalizePhiMediaKind))];
    const since = parseDateTimeOrNull(url.searchParams.get("since"));
    const until = parseDateTimeOrNull(url.searchParams.get("until"));
    const sort = url.searchParams.get("sort");

    if (!page || !pageSize) {
      return NextResponse.json(
        { error: "Missing pagination parameters. Use page and pageSize." },
        { status: 400 },
      );
    }

    if (sort && sort !== "created_at_desc") {
      return NextResponse.json(
        { error: "Unsupported sort. Use created_at_desc." },
        { status: 400 },
      );
    }

    const normalizedPageSize = Math.min(pageSize, PHI_MAX_PAGE_SIZE);
    const offset = (page - 1) * normalizedPageSize;
    const requestedSpaceId = readRequestedMediaSpaceId(request);
    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id,
      siteWide,
      userId: session!.userId,
      requestedSpaceId,
    });
    /*
     * A Group Space that nothing has been written to yet is a legitimate destination, not an error: it
     * simply holds nothing, and reading it must not be what creates it. The listing answers with the
     * empty Space and the full selector so an interface can show the group and let an Author start
     * using it.
     */
    if (!resolution.ok && resolution.reason !== "space_not_materialized") {
      return nextMediaSpaceError(resolution.reason);
    }
    const config = resolution.ok ? resolution.config : await ensureSiteMediaConfig(site.id);
    // A materialized Group Space carries only its group id; the selector needs the group's name too.
    // Retired groups included: a Space outlives the group's service, and it still needs its name.
    const groupNames = new Map(
      (await listSiteGroups(site.id, { includeRetired: true })).map((group) => [group.id, group.name]),
    );
    const selectable = await listSelectableMediaSpaces({
      siteId: site.id,
      userId: session!.userId,
      includeSiteSpace: true,
      config,
    });
    const spaceList = [
      ...selectable.spaces.map((entry) => serializeMediaSpace(entry, selectable.config, groupNames.get(entry.groupId ?? -1))),
      ...selectable.pendingGroups.map((group) => serializeUnmaterializedGroupMediaSpace(group, selectable.config)),
    ];
    if (!resolution.ok) {
      const pending = typeof requestedSpaceId === "object" && requestedSpaceId?.kind === "group"
        ? selectable.pendingGroups.find((group) => group.id === requestedSpaceId.groupId)
        : undefined;
      return NextResponse.json({
        activeSpace: pending ? serializeUnmaterializedGroupMediaSpace(pending, selectable.config) : null,
        spaces: spaceList,
        folders: [],
        assets: [],
        pagination: { page, pageSize: normalizedPageSize, total: 0, hasMore: false },
      });
    }
    const { space } = resolution;
    const folders = await listMediaFolders(site.id, space.id);
    const folderIds = folderId ? await listMediaFolderDescendantIds(site.id, space.id, folderId) : null;
    const assets = await listMediaAssetsBySiteWithFilters(site.id, {
      id,
      spaceId: space.id,
      folderId: folderIds && folderIds.length > 0 ? null : folderId,
      folderIds,
      query: q,
      presentationFlags,
      kinds,
      since,
      until,
      sort: "created_at_desc",
      limit: normalizedPageSize + 1,
      offset,
    });
    const total = await countMediaAssetsBySiteWithFilters(site.id, {
      id,
      spaceId: space.id,
      folderId: folderIds && folderIds.length > 0 ? null : folderId,
      folderIds,
      query: q,
      presentationFlags,
      kinds,
      since,
      until,
      sort: "created_at_desc",
    });
    const hasMore = assets.length > normalizedPageSize;
    const pagedAssets = hasMore ? assets.slice(0, normalizedPageSize) : assets;

    return NextResponse.json({
      activeSpace: serializeMediaSpace(space, selectable.config, groupNames.get(space.groupId ?? -1)),
      spaces: spaceList,
      folders,
      assets: pagedAssets.map(serializeMediaAssetForTile),
      pagination: {
        page,
        pageSize: normalizedPageSize,
        total,
        hasMore,
      },
    });
  } catch (error) {
    logRuntimeEvent("error", "media.list.failed", {
      message: error instanceof Error ? error.message : "Media list failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
      meta: {
        query: new URL(request.url).searchParams.get("q"),
      },
    });
    return NextResponse.json(
      { error: "media_list_failed", message: "Media list failed." },
      { status: 500 },
    );
  }
}
