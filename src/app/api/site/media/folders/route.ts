import { NextRequest, NextResponse } from "next/server";

import { createMediaFolder, listMediaFolders } from "@/db/media";
import { clearSiteConfigCache } from "@/db/site-config";
import {
  readRequestedMediaSpaceId,
  requireMediaManagementSiteContext,
} from "@/lib/guards/site-media-api";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolveAuthorizedMediaSpace } from "@/db/media-spaces";
import { nextMediaSpaceError, serializeMediaSpace } from "@/lib/media-response";
import {
  normalizeNonNegativeInteger,
  normalizeString,
  parsePositiveInt,
  parseStrictPositiveInt,
} from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeFlags(value: FormDataEntryValue | null) {
  return normalizeNonNegativeInteger(normalizeString(value));
}

export async function GET(request: NextRequest) {
  let siteKey: string | null = null;
  const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  siteKey = site.key;

  try {
    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id,
      siteWide,
      userId: session!.userId,
      requestedSpaceId: readRequestedMediaSpaceId(request),
    });
    if (!resolution.ok) return nextMediaSpaceError(resolution.reason);
    const { space, config: mediaConfig } = resolution;
    const folders = await listMediaFolders(site.id, space.id);
    return NextResponse.json({
      activeSpace: serializeMediaSpace(space, mediaConfig),
      folders,
    });
  } catch (error) {
    logRuntimeEvent("error", "media.folders.list_failed", {
      message: error instanceof Error ? error.message : "Media Folder list failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
    });
    return NextResponse.json(
      { error: "media_folders_list_failed", message: "Media Folder list failed." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let siteKey: string | null = null;
  const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  siteKey = site.key;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart payload." }, { status: 400 });
  }

  const name = normalizeString(formData.get("name"));
  if (!name) {
    return NextResponse.json({ error: "Missing Folder name." }, { status: 400 });
  }
  // Absent or empty creates the Folder at the root; a value that names no Folder is refused.
  const statedParentId = normalizeString(formData.get("parentId"));
  const parentId = statedParentId ? parseStrictPositiveInt(statedParentId) : null;
  if (statedParentId && parentId === null) {
    return NextResponse.json({ error: "Invalid parentId value." }, { status: 400 });
  }

  try {
    const resolution = await resolveAuthorizedMediaSpace({
      // A write is what brings a Group Space into existence.
      intent: "write",
      siteId: site.id,
      siteWide,
      userId: session!.userId,
      requestedSpaceId: readRequestedMediaSpaceId(request),
    });
    if (!resolution.ok) return nextMediaSpaceError(resolution.reason);
    const { space } = resolution;
    const folder = await createMediaFolder({
      siteId: site.id,
      spaceId: space.id,
      parentId,
      name,
      sortOrder: parsePositiveInt(formData.get("sortOrder")?.toString()) ?? 0,
      flags: normalizeFlags(formData.get("flags")) ?? 0,
    });

    clearSiteConfigCache(site.id);

    return NextResponse.json({
      folder,
    });
  } catch (error) {
    logRuntimeEvent("error", "media.folders.create_failed", {
      message: error instanceof Error ? error.message : "Media Folder create failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
      meta: {
        name,
      },
    });
    return NextResponse.json(
      { error: "media_folders_create_failed", message: "Media Folder create failed." },
      { status: 500 },
    );
  }
}
