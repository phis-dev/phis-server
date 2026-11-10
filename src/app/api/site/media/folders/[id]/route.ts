import { NextRequest, NextResponse } from "next/server";

import {
  deleteMediaFolderBySite,
  getMediaFolderBySiteAndId,
  hasLockedMediaFolder,
  hasLockedMediaFolderInBranch,
  updateMediaFolder,
} from "@/db/media";
import { PhiMediaFolderFlags } from "@phis/contracts/media";
import { clearSiteConfigCache } from "@/db/site-config";
import {
  readRequestedMediaSpaceId,
  requireMediaManagementSiteContext,
} from "@/lib/guards/site-media-api";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolveAuthorizedMediaSpace } from "@/db/media-spaces";
import { nextMediaSpaceError } from "@/lib/media-response";
import {
  normalizeNonNegativeInteger,
  normalizeString,
  parsePositiveInt,
  parseStrictPositiveInt,
  requireJsonObjectBody,
} from "@/lib/helpers/request";

export const dynamic = "force-dynamic";


export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  let siteKey: string | null = null;
  const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  siteKey = site.key;

  try {
    const resolvedParams = await Promise.resolve(params);
    const folderId = parsePositiveInt(resolvedParams.id);
    if (!folderId) {
      return NextResponse.json({ error: "Missing Folder id." }, { status: 400 });
    }

    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id,
      siteWide,
      userId: session!.userId,
      requestedSpaceId: readRequestedMediaSpaceId(request),
    });
    if (!resolution.ok) return nextMediaSpaceError(resolution.reason);
    const { space } = resolution;
    const folder = await getMediaFolderBySiteAndId(site.id, space.id, folderId);
    if (!folder) {
      return NextResponse.json({ error: "Media Folder not found." }, { status: 404 });
    }

    return NextResponse.json({
      folder,
    });
  } catch (error) {
    logRuntimeEvent("error", "media.folder.read_failed", {
      message: error instanceof Error ? error.message : "Media Folder read failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
    });
    return NextResponse.json(
      { error: "media_folder_read_failed", message: "Media Folder read failed." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  let siteKey: string | null = null;
  const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  siteKey = site.key;

  try {
    const resolvedParams = await Promise.resolve(params);
    const folderId = parsePositiveInt(resolvedParams.id);
    if (!folderId) {
      return NextResponse.json({ error: "Missing Folder id." }, { status: 400 });
    }

    const parsedBody = await requireJsonObjectBody(request);
    if (!parsedBody.ok) {
      return parsedBody.response;
    }
    const payload = parsedBody.body;

    if (Object.hasOwn(payload, "name") && !normalizeString(payload.name)) {
      return NextResponse.json({ error: "Folder name cannot be empty." }, { status: 400 });
    }

    const sortOrder = Object.hasOwn(payload, "sortOrder") ? normalizeNonNegativeInteger(payload.sortOrder) : undefined;
    const flags = Object.hasOwn(payload, "flags") ? normalizeNonNegativeInteger(payload.flags) : undefined;
    // `null` moves the Folder to the root; anything else has to name a Folder, not fall back to the root.
    const parentId = !Object.hasOwn(payload, "parentId")
      ? undefined
      : payload.parentId === null
        ? null
        : parseStrictPositiveInt(payload.parentId);
    if (Object.hasOwn(payload, "parentId") && payload.parentId !== null && parentId === null) {
      return NextResponse.json({ error: "Invalid parentId value." }, { status: 400 });
    }
    if (Object.hasOwn(payload, "sortOrder") && sortOrder === null) {
      return NextResponse.json({ error: "Invalid sortOrder value." }, { status: 400 });
    }
    if (Object.hasOwn(payload, "flags") && flags === null) {
      return NextResponse.json({ error: "Invalid flags value." }, { status: 400 });
    }

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
    const folder = await getMediaFolderBySiteAndId(site.id, space.id, folderId);
    if (!folder) {
      return NextResponse.json({ error: "Media Folder not found." }, { status: 404 });
    }

    /*
     * A locked Folder takes one change: its flags, which is how it is unlocked again. A Folder also
     * does not move into a locked Folder or out of one, because that changes what the locked one holds.
     */
    const changesMoreThanFlags = Object.hasOwn(payload, "name") ||
      Object.hasOwn(payload, "parentId") ||
      Object.hasOwn(payload, "sortOrder");
    const lockedSelf = (folder.flags & PhiMediaFolderFlags.Locked) !== 0 && changesMoreThanFlags;
    const lockedMove = parentId !== undefined && parentId !== folder.parentId &&
      await hasLockedMediaFolder(site.id, space.id, [parentId, folder.parentId]);
    if (lockedSelf || lockedMove) {
      return NextResponse.json(
        { error: "media_folder_locked", message: "The Media Folder is locked." },
        { status: 409 },
      );
    }

    const updated = await updateMediaFolder({
      siteId: site.id,
      spaceId: space.id,
      folderId,
      parentId,
      name: Object.hasOwn(payload, "name") ? normalizeString(payload.name) : undefined,
      sortOrder: sortOrder ?? undefined,
      flags: flags ?? undefined,
    });

    if (!updated) {
      return NextResponse.json({ error: "Media Folder not found." }, { status: 404 });
    }

    clearSiteConfigCache(site.id);

    return NextResponse.json({
      folder: updated,
    });
  } catch (error) {
    logRuntimeEvent("error", "media.folder.update_failed", {
      message: error instanceof Error ? error.message : "Media Folder update failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
    });
    return NextResponse.json(
      { error: "media_folder_update_failed", message: "Media Folder update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  let siteKey: string | null = null;
  const { site, session, siteWide, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  siteKey = site.key;

  try {
    const resolvedParams = await Promise.resolve(params);
    const folderId = parsePositiveInt(resolvedParams.id);
    if (!folderId) {
      return NextResponse.json({ error: "Missing Folder id." }, { status: 400 });
    }

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
    const folder = await getMediaFolderBySiteAndId(site.id, space.id, folderId);
    if (!folder) {
      return NextResponse.json({ error: "Media Folder not found." }, { status: 404 });
    }

    // Deleting a Folder deletes its branch, and takes it out of its parent.
    if (
      await hasLockedMediaFolderInBranch(site.id, space.id, folderId) ||
      await hasLockedMediaFolder(site.id, space.id, [folder.parentId])
    ) {
      return NextResponse.json(
        { error: "media_folder_locked", message: "The Media Folder is locked." },
        { status: 409 },
      );
    }

    const deleted = await deleteMediaFolderBySite(site.id, space.id, folderId);
    if (deleted) {
      clearSiteConfigCache(site.id);
    }

    return NextResponse.json({
      ok: deleted,
    });
  } catch (error) {
    logRuntimeEvent("error", "media.folder.delete_failed", {
      message: error instanceof Error ? error.message : "Media Folder delete failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
    });
    return NextResponse.json(
      { error: "media_folder_delete_failed", message: "Media Folder delete failed." },
      { status: 500 },
    );
  }
}
