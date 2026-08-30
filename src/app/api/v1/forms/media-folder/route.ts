import { NextRequest, NextResponse } from "next/server";

import { createMediaFolder, findMediaFolderPathId } from "@/db/media";
import { clearSiteConfigCache } from "@/db/site-config";
import { requireSiteMediaApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { ensureSiteMediaSpace } from "@/db/media-spaces";

function normalizeFolderPath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function readDatabaseErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteMediaApiContext(request);
  if (error) {
    return error;
  }
  if (!context?.site) {
    return NextResponse.json(
      { ok: false, error: "Site Builder context is unavailable." },
      { status: 500 },
    );
  }
  const site = context.site;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const parentPath = normalizeFolderPath(body?.parentPath);

  if (!name || name.length > 160 || name.includes("/")) {
    return NextResponse.json(
      { ok: false, error: "A valid Folder name with at most 160 characters is required." },
      { status: 400 },
    );
  }
  if (parentPath === null) {
    return NextResponse.json(
      { ok: false, error: "A valid parentPath is required." },
      { status: 400 },
    );
  }

  try {
    const { space } = await ensureSiteMediaSpace(site.id);
    const parentId = parentPath.length > 0
      ? await findMediaFolderPathId(site.id, space.id, parentPath)
      : null;
    if (parentPath.length > 0 && parentId == null) {
      return NextResponse.json(
        { ok: false, error: "Parent Media Folder not found." },
        { status: 404 },
      );
    }

    const folder = await createMediaFolder({
      siteId: site.id,
      spaceId: space.id,
      parentId,
      name,
      sortOrder: 0,
      flags: 0,
    });
    if (!folder) {
      throw new Error("Media Folder creation returned no record.");
    }
    clearSiteConfigCache(site.id);
    return NextResponse.json({ ok: true, folder });
  } catch (createError) {
    if (readDatabaseErrorCode(createError) === "23505") {
      return NextResponse.json(
        { ok: false, error: "A Media Folder with this name already exists below the selected parent." },
        { status: 409 },
      );
    }
    logRuntimeEvent("error", "media.folder.form_create_failed", {
      message: createError instanceof Error ? createError.message : "Media Folder Form creation failed.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(createError),
      meta: { name, parentPath },
    });
    return NextResponse.json(
      { ok: false, error: "Media Folder creation failed." },
      { status: 500 },
    );
  }
}
