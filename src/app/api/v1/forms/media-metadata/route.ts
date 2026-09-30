import { NextRequest, NextResponse } from "next/server";

import { PhiMediaAssetFlags } from "@/lib/constants/media";
import { logRuntimeEvent } from "@/lib/log";
import { serializeMediaAssetForDetail } from "@/lib/media-response";
import {
  MediaAssetUpdateError,
  updateSiteMediaAssetMetadataFromForm,
} from "@/lib/media-asset-update";
import { requireSiteMediaApiContext } from "@/lib/guards/site-admin-api";
import { normalizeNullableString, readJsonObjectBody } from "@/lib/helpers/request";

const MEDIA_ASSET_FLAG_VALUES = new Set<number>(Object.values(PhiMediaAssetFlags));

function normalizeFlags(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  let flags = 0;
  for (const entry of value) {
    const normalized = typeof entry === "number"
      ? entry
      : typeof entry === "string" && entry.trim()
        ? Number(entry)
        : Number.NaN;
    if (!Number.isInteger(normalized) || !MEDIA_ASSET_FLAG_VALUES.has(normalized)) {
      return null;
    }
    flags |= normalized;
  }

  return flags;
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

  const body = await readJsonObjectBody(request);
  const assetId = Number(body?.assetId);
  if (!body || !Number.isInteger(assetId) || assetId <= 0) {
    return NextResponse.json(
      { ok: false, error: "A positive assetId is required." },
      { status: 400 },
    );
  }

  const folderId = body.folderId == null ? null : Number(body.folderId);
  if (folderId != null && (!Number.isInteger(folderId) || folderId <= 0)) {
    return NextResponse.json(
      { ok: false, error: "A valid folderId is required." },
      { status: 400 },
    );
  }

  const presentationFlags = normalizeFlags(body.presentationFlags);
  if (presentationFlags === null) {
    return NextResponse.json(
      { ok: false, error: "Invalid media flags." },
      { status: 400 },
    );
  }

  try {
    const updated = await updateSiteMediaAssetMetadataFromForm({
      siteId: site.id,
      assetId,
      folderId,
      title: normalizeNullableString(body.title),
      altText: normalizeNullableString(body.altText),
      presentationFlags,
      ...(Object.hasOwn(body, "focalRect")
        ? { focalRect: body.focalRect ?? null }
        : {}),
    });

    return NextResponse.json({
      ok: true,
      asset: serializeMediaAssetForDetail(updated),
    });
  } catch (updateError) {
    if (updateError instanceof MediaAssetUpdateError) {
      return NextResponse.json(
        { ok: false, error: updateError.message },
        { status: updateError.status },
      );
    }

    logRuntimeEvent("error", "media.asset.form_update_failed", {
      message: updateError instanceof Error
        ? updateError.message
        : "Media asset Form update failed.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      error: updateError,
    });
    return NextResponse.json(
      { ok: false, error: "Media asset update failed." },
      { status: 500 },
    );
  }
}
