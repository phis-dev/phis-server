import { NextRequest, NextResponse } from "next/server";
import { PHI_SEARCH_INDEXED_AREA_MASK } from "@phis/contracts/search";

import {
  getSiteAreaDraftRevisionPreview,
  getSiteAreaLiveRead,
  getSiteAreaRevisionReview,
  listSitePublishedPageAddresses,
  type SiteAreaRead,
} from "@/db/site-pages";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveCmsPath } from "@/lib/helpers/access";
import { requireSiteCmsPreviewApiContext } from "@/lib/guards/site-admin-api";
import { resolveSiteReadLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { readSiteCmsRevisionId } from "@/lib/helpers/site-cms-route";

/** Both or neither: `undefined` when one is named without the other. */
function resolveAreaPresetIdentity(url: URL) {
  const ownerModuleId = url.searchParams.get("ownerModuleId")?.trim() ?? "";
  const presetKey = url.searchParams.get("presetKey")?.trim() ?? "";
  if (!ownerModuleId && !presetKey) {
    return null;
  }
  return ownerModuleId && presetKey ? { ownerModuleId, presetKey } : undefined;
}

const PUBLISHED_PAGES_INCLUDE = "publishedPages";

/**
 * The answer every branch gives. `modules` is the Area's Module selection -- `{ revisionId, config:
 * { modules } }`, or null when none is stored -- whatever shell identity was named. `preset` is the
 * stored structure: with `ownerModuleId` and `presetKey` only when they name the identity it is stored
 * under, without them whatever it is stored under. `sourcePreset` is that structure's own identity (with
 * its `sourcePresetVersion`), null without one.
 */
function buildAreaReadBody(areaMask: number, read: SiteAreaRead) {
  return {
    areaMask,
    sourcePreset: read.preset?.sourcePreset ?? null,
    preset: read.preset,
    modules: read.modules,
  };
}

export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
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
  const locale = resolveSiteReadLocale(request);
  const resolvedPath = resolveCmsPath(rawPath);
  /*
   * The identity is optional. The Module selection decides which shell an Area takes, so a page view
   * reads both at once without one and drops a structure whose `sourcePreset` is not the shell its
   * selection chose; with one the structure comes back only if it is stored under it.
   */
  const sourcePreset = resolveAreaPresetIdentity(url);
  if (sourcePreset === undefined) {
    return NextResponse.json(
      { error: "ownerModuleId and presetKey must be provided together." },
      { status: 400 },
    );
  }
  /*
   * `include=publishedPages` adds the Area's published Pages, as the candidates of the Site's sitemap.
   *
   * On this read because the sitemap already asks it -- the Area's `index` and `sitemap` switches are
   * in the preset -- so one request answers both. Opt-in, because this is the live read every page
   * view pays for. Public and App only: they are the two Areas anything indexes -- a crawler the
   * first, the Site's own search (SEARCH.md) both -- and a list of the staff Areas' addresses is what
   * the Site keeps out of its robots.txt. Live only: a sitemap never reads a draft. Pages can be
   * published before their Area is; `preset` is then null, as on every live read of such an Area.
   */
  const include = url.searchParams.get("include")?.trim() ?? "";
  if (include && include !== PUBLISHED_PAGES_INCLUDE) {
    return NextResponse.json({ error: `include must be "${PUBLISHED_PAGES_INCLUDE}".` }, { status: 400 });
  }
  const includePublishedPages = include === PUBLISHED_PAGES_INCLUDE;
  if (includePublishedPages && (resolvedPath.areaMask & PHI_SEARCH_INDEXED_AREA_MASK) !== resolvedPath.areaMask) {
    return NextResponse.json({ error: "publishedPages is answered for the Public and App Areas only." }, { status: 400 });
  }
  if (includePublishedPages && (revisionValue != null || reviewRevisionValue != null)) {
    return NextResponse.json({ error: "publishedPages is answered on the live read only." }, { status: 400 });
  }
  if (reviewRevisionValue != null) {
    const revisionId = readSiteCmsRevisionId(reviewRevisionValue);
    if (revisionId == null) {
      return NextResponse.json({ error: "reviewRevision must be a positive integer." }, { status: 400 });
    }

    const { context, error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }

    // The reviewed revision stands in for its own half -- a structure for the structure, a Modules
    // revision for the selection -- and the other half is what is live.
    const review = await getSiteAreaRevisionReview(context!.site!.id, revisionId, {
      areaMask: resolvedPath.areaMask,
      sourcePreset,
    });
    if (review) {
      return createJsonResponse(request, {
        ...buildAreaReadBody(resolvedPath.areaMask, review),
        revisionId,
      });
    }

    return NextResponse.json({ error: "Area revision not found." }, { status: 404 });
  }

  if (revisionValue != null) {
    const revisionId = readSiteCmsRevisionId(revisionValue);
    if (revisionId == null) {
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
        ...buildAreaReadBody(resolvedPath.areaMask, preview),
        revisionId,
      });
    }
    // Asked for a draft and there is none: 404, as the review branch above answers, not the published Area.
    return NextResponse.json({ error: "Area revision not found." }, { status: 404 });
  }

  /*
   * `stage=current` is the published Area as an editor reads it: its Widgets' current content and the
   * version each builds on, the base of the next draft (CONTENT.md). Drafts are not public.
   */
  const stage = url.searchParams.get("stage") === "current" ? "current" : "published";
  if (stage === "current") {
    const { error } = await requireSiteCmsPreviewApiContext(request);
    if (error) {
      return error;
    }
  }
  const read = await getSiteAreaLiveRead(site.id, resolvedPath.areaMask, { locale, sourcePreset, stage });

  if (includePublishedPages) {
    const publishedPages = await listSitePublishedPageAddresses(site.id, resolvedPath.areaMask);
    return createJsonResponse(request, {
      ...buildAreaReadBody(resolvedPath.areaMask, read),
      publishedPages,
    });
  }

  // Nothing stored is an answer, not a miss: the Area runs on its code-owned shell and its default
  // Modules, and the caller needs the selection's absence as much as its presence.
  return createJsonResponse(request, buildAreaReadBody(resolvedPath.areaMask, read));
}
