import { NextRequest, NextResponse } from "next/server";

import {
  getResolvedSitePageTree,
  getSitePageDraftRevisionPreview,
  getSitePageRevisionReview,
  type SitePageScopeAddress,
} from "@/db/site-pages";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveCmsPath } from "@/lib/helpers/access";
import { requireSiteCmsPreviewApiContext } from "@/lib/guards/site-admin-api";
import { normalizeLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";

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

function resolvePageScopeAddress(url: URL, path: string): SitePageScopeAddress | null {
  const ownerModuleId = url.searchParams.get("ownerModuleId")?.trim() ?? "";
  const presetKey = url.searchParams.get("presetKey")?.trim() ?? "";
  if (ownerModuleId || presetKey) {
    return ownerModuleId && presetKey
      ? { kind: "preset", ownerModuleId, presetKey }
      : null;
  }
  return { kind: "path", path };
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
  const reviewRevisionValue = reviewKind === "page" ? url.searchParams.get("reviewRevision") : null;
  const locale = resolveRequestLocale(request);
  const resolvedPath = resolveCmsPath(rawPath);
  const address = resolvePageScopeAddress(url, resolvedPath.path);
  if (!address) {
    return NextResponse.json(
      { error: "ownerModuleId and presetKey must be provided together." },
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

    const review = await getSitePageRevisionReview(context!.site!.id, revisionId, {
      areaMask: resolvedPath.areaMask,
      address,
      locale,
    });
    if (review) {
      return createJsonResponse(request, {
        areaMask: resolvedPath.areaMask,
        path: resolvedPath.path,
        revisionId,
        sourcePreset: review.tree.sourcePreset,
        page: review.tree,
      });
    }

    return NextResponse.json({ error: "Page revision not found." }, { status: 404 });
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

    const preview = await getSitePageDraftRevisionPreview(context!.site!.id, revisionId, {
      areaMask: resolvedPath.areaMask,
      address,
      locale,
    });
    if (preview) {
      return createJsonResponse(request, {
        areaMask: resolvedPath.areaMask,
        path: resolvedPath.path,
        revisionId,
        sourcePreset: preview.tree.sourcePreset,
        page: preview.tree,
      });
    }
  }

  /*
   * `stage=current` is the published Page as an editor reads it: its Widgets' current content and the
   * version each builds on, the base of the next draft (CONTENT.md). Drafts are not public.
   */
  const stage = url.searchParams.get("stage") === "current" ? "current" : "published";
  if (stage === "current") {
    const { error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }
  }
  const tree = await getResolvedSitePageTree(site.id, resolvedPath.areaMask, address, locale, stage);

  if (!tree) {
    return NextResponse.json({ error: "Page not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    areaMask: resolvedPath.areaMask,
    path: resolvedPath.path,
    sourcePreset: tree.sourcePreset,
    page: tree,
  });
}
