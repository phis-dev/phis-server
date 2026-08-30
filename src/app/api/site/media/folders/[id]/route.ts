import { NextRequest, NextResponse } from "next/server";

import { deleteMediaFolderBySite, getMediaFolderBySiteAndId, updateMediaFolder } from "@/db/media";
import { clearSiteConfigCache } from "@/db/site-config";
import {
  readRequestedMediaSpaceId,
  requireMediaManagementSiteContext,
} from "@/lib/guards/site-media-api";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { resolveAuthorizedMediaSpace } from "@/db/media-spaces";
import { nextMediaSpaceError } from "@/lib/media-response";
import { normalizeString, parsePositiveInt } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeNullableInt(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

function normalizeFlags(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  return null;
}

async function readJsonBody(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

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

    const payload = await readJsonBody(request);
    if (!payload) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (Object.hasOwn(payload, "name") && !normalizeString(payload.name)) {
      return NextResponse.json({ error: "Folder name cannot be empty." }, { status: 400 });
    }

    const sortOrder = Object.hasOwn(payload, "sortOrder") ? normalizeNullableInt(payload.sortOrder) : undefined;
    const flags = Object.hasOwn(payload, "flags") ? normalizeFlags(payload.flags) : undefined;
    const parentId = Object.hasOwn(payload, "parentId") ? normalizeNullableInt(payload.parentId) : undefined;
    if (Object.hasOwn(payload, "parentId") && parentId === 0) {
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
