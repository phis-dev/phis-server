import { NextRequest, NextResponse } from "next/server";

import {
  deleteMediaAssetBySite,
  deleteImageAssetVariantsByAssetId,
  getMediaAssetBySiteAndId,
  pruneEmptyMediaFolderBranch,
} from "@/db/media";
import { clearSiteConfigCache } from "@/db/site-config";
import { getSessionFromRequest } from "@/db/user-sessions";
import { requireMediaAssetContext } from "@/lib/guards/site-media-api";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { collectMediaAssetDeleteReferences } from "@/lib/media-delete-guard";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaAssetForDetail } from "@/lib/media-response";
import { PHI_SERVER_CMS_AREA_KEYS, resolvePhiServerCmsAreaKey } from "@/lib/constants/cms-areas";
import { MediaAssetUpdateError, updateSiteMediaAsset } from "@/lib/media-asset-update";
import { parsePositiveInt } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeAreaKey(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return PHI_SERVER_CMS_AREA_KEYS.includes(normalized as (typeof PHI_SERVER_CMS_AREA_KEYS)[number])
    ? normalized
    : null;
}

function resolveRequestArea(request: NextRequest) {
  return normalizeAreaKey(request.headers.get("x-phi-area"));
}

async function readJsonBody(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

async function deleteStoredMediaAsset(asset: Awaited<ReturnType<typeof getMediaAssetBySiteAndId>>) {
  if (!asset) {
    return false;
  }

  const deletedVariants = await deleteImageAssetVariantsByAssetId(asset.id);
  await Promise.all(deletedVariants.map(async (variant) => {
    const profile = await getMediaStorageProfile(asset.siteId, variant.storageProfileId);
    if (!profile) return;
    const storage = await createPhisMediaStorageServiceForProfile(profile);
    await storage.deleteObject(variant.storageKey).catch(() => {});
  }));
  const profile = await getMediaStorageProfile(asset.siteId, asset.storageProfileId);
  if (profile) {
    const storage = await createPhisMediaStorageServiceForProfile(profile);
    await storage.deleteObject(asset.storageKey).catch(() => {});
  }
  return deleteMediaAssetBySite(asset.siteId, asset.spaceId, asset.id);
}

function describeMediaAssetReference(reference: Awaited<ReturnType<typeof collectMediaAssetDeleteReferences>>[number]) {
  const parts: string[] = [];
  if (reference.areaMask != null) {
    parts.push(`area=${resolvePhiServerCmsAreaKey(reference.areaMask)}`);
  }

  if (reference.pagePath) {
    parts.push(reference.pagePath.startsWith("navigation:") ? reference.pagePath : `page=${reference.pagePath}`);
  }

  if (reference.regionKey) {
    parts.push(`region=${reference.regionKey}`);
  }

  if (reference.widgetType) {
    parts.push(`widget=${reference.widgetType}`);
  }

  if (reference.widgetId != null) {
    parts.push(`id=${reference.widgetId}`);
  } else if (reference.layoutNodeId != null) {
    parts.push(`layout=${reference.layoutNodeId}`);
  } else if (reference.contentId != null) {
    parts.push(`content=${reference.contentSlug ?? `#${reference.contentId}`}`);
  }

  if (parts.length > 0) {
    return parts.join(", ");
  }

  return `${reference.scope} (${reference.fieldPath})`;
}

function buildMediaAssetInUseMessage(references: Awaited<ReturnType<typeof collectMediaAssetDeleteReferences>>) {
  const preview = references.slice(0, 4).map(describeMediaAssetReference);
  const suffix = references.length > preview.length ? `, and ${references.length - preview.length} more` : "";
  return `Media asset is still referenced by: ${preview.join("; ")}${suffix}.`;
}

function resolveMediaAssetDeleteErrorMessage(error: unknown) {
  const typedError = error as { constraint?: unknown; code?: unknown } | null;
  if (typedError?.constraint === "site_content_asset_id_fkey" || typedError?.code === "23503") {
    return "Media asset is still referenced and cannot be deleted.";
  }

  return "Media asset delete failed.";
}

export async function GET(
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

    const { site, error } = await requireMediaAssetContext(request, assetId, "read");
    if (error) {
      return error;
    }
    siteKey = site.key;

    const asset = await getMediaAssetBySiteAndId(site.id, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
    }

    return NextResponse.json({
      asset: serializeMediaAssetForDetail(asset),
    });
  } catch (error) {
    logRuntimeEvent("error", "media.asset.read_failed", {
      message: error instanceof Error ? error.message : "Media asset read failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json(
      { error: "media_asset_read_failed", message: "Media asset read failed." },
      { status: 500 },
    );
  }
}

export async function PATCH(
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

    const { site, error } = await requireMediaAssetContext(request, assetId, "update");
    if (error) {
      return error;
    }
    siteKey = site.key;

    const payload = await readJsonBody(request);
    if (!payload) {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const updated = await updateSiteMediaAsset({ siteId: site.id, assetId, payload });

    return NextResponse.json({
      asset: serializeMediaAssetForDetail(updated),
    });
  } catch (error) {
    if (error instanceof MediaAssetUpdateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logRuntimeEvent("error", "media.asset.update_failed", {
      message: error instanceof Error ? error.message : "Media asset update failed.",
      siteKey,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json(
      { error: "media_asset_update_failed", message: "Media asset update failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  let siteKey: string | null = null;
  let userId: number | null = null;
  const area = resolveRequestArea(request);
  try {
    const resolvedParams = await Promise.resolve(params);
    const assetId = parsePositiveInt(resolvedParams.id);
    if (!assetId) {
      return NextResponse.json({ error: "Missing asset id." }, { status: 400 });
    }

    const { site, error } = await requireMediaAssetContext(request, assetId, "delete");
    if (error) {
      return error;
    }
    siteKey = site.key;
    const session = await getSessionFromRequest(request, site.id);
    userId = session?.userId ?? null;

    const asset = await getMediaAssetBySiteAndId(site.id, assetId);
    if (!asset) {
      return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
    }

    const references = await collectMediaAssetDeleteReferences(site.id, asset);
    if (references.length > 0) {
      logRuntimeEvent("warn", "media.asset.delete_blocked", {
        siteKey,
        area,
        userId,
        targetType: "media-asset",
        targetId: asset.id,
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          referenceCount: references.length,
        },
      });

      return NextResponse.json(
        {
          error: "media_asset_in_use",
          message: buildMediaAssetInUseMessage(references),
          asset: serializeMediaAssetForDetail(asset),
          references,
        },
        { status: 409 },
      );
    }

    const deleted = await deleteStoredMediaAsset(asset);
    if (deleted) {
      if (asset.folderId != null) {
        await pruneEmptyMediaFolderBranch(site.id, asset.spaceId, asset.folderId);
      }
      clearSiteConfigCache(site.id);
    }

    return NextResponse.json({
      ok: deleted,
    });
  } catch (error) {
    const message = resolveMediaAssetDeleteErrorMessage(error);
    logRuntimeEvent("error", "media.asset.delete_failed", {
      message: error instanceof Error ? error.message : message,
      siteKey,
      area,
      userId,
      method: request.method,
      path: request.nextUrl.pathname,
      error,
    });
    return NextResponse.json(
      { error: "media_asset_delete_failed", message },
      { status: 500 },
    );
  }
}
