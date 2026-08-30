import { NextRequest, NextResponse } from "next/server";

import { getExactSiteAreaPresetTree, getSiteAreaDraftRevisionPreview, getSiteAreaRevisionReview } from "@/db/site-pages";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveCmsPath } from "@/lib/helpers/access";
import { requireSiteCmsPreviewApiContext } from "@/lib/guards/site-admin-api";
import { normalizeLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";

function resolveAreaPresetIdentity(url: URL) {
  const ownerModuleId = url.searchParams.get("ownerModuleId")?.trim() ?? "";
  const presetKey = url.searchParams.get("presetKey")?.trim() ?? "";
  return ownerModuleId && presetKey ? { ownerModuleId, presetKey } : null;
}

function resolveRequestLocale(request: Request) {
  const url = new URL(request.url);
  const rawLocale =
    url.searchParams.get("locale") ??
    request.headers.get("x-locale") ??
    request.headers.get("accept-language");

  if (!rawLocale?.trim()) {
    return null;
  }

  return normalizeLocale(rawLocale);
}

export async function GET(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path") ?? "/";
  const revisionValue = url.searchParams.get("revision");
  const reviewKind = url.searchParams.get("reviewKind")?.trim().toLowerCase() ?? "";
  const reviewRevisionValue = reviewKind === "area" ? url.searchParams.get("reviewRevision") : null;
  const locale = resolveRequestLocale(request);
  const resolvedPath = resolveCmsPath(rawPath);
  const sourcePreset = resolveAreaPresetIdentity(url);
  if (!sourcePreset) {
    return NextResponse.json(
      { error: "ownerModuleId and presetKey must be provided." },
      { status: 400 },
    );
  }
  if (reviewRevisionValue != null) {
    const revisionId = Number(reviewRevisionValue);
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
      return NextResponse.json({ error: "reviewRevision must be a positive integer." }, { status: 400 });
    }

    const { context, error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }

    const review = await getSiteAreaRevisionReview(context!.site!.id, revisionId, {
      areaMask: resolvedPath.areaMask,
      sourcePreset,
    });
    if (review) {
      return createJsonResponse(request, {
        areaMask: resolvedPath.areaMask,
        revisionId,
        sourcePreset: review.preset.sourcePreset,
        preset: review.preset,
      });
    }

    return NextResponse.json({ error: "Area revision not found." }, { status: 404 });
  }

  if (revisionValue != null) {
    const revisionId = Number(revisionValue);
    if (!Number.isInteger(revisionId) || revisionId <= 0) {
      return NextResponse.json({ error: "revision must be a positive integer." }, { status: 400 });
    }

    const { context, error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }

    const preview = await getSiteAreaDraftRevisionPreview(context!.site!.id, revisionId, {
      areaMask: resolvedPath.areaMask,
      sourcePreset,
    });
    if (preview) {
      return createJsonResponse(request, {
        areaMask: resolvedPath.areaMask,
        revisionId,
        sourcePreset: preview.preset.sourcePreset,
        preset: preview.preset,
      });
    }
  }

  const preset = await getExactSiteAreaPresetTree(
    site.id,
    resolvedPath.areaMask,
    0,
    locale,
    sourcePreset,
  );

  if (!preset) {
    return NextResponse.json({ error: "Area preset override not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    areaMask: resolvedPath.areaMask,
    sourcePreset: preset.sourcePreset,
    preset,
  });
}
