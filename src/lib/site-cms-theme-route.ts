import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  deleteSiteThemeDraftRevision,
  getSiteCurrentThemeDraft,
  getSiteThemeScope,
  normalizeSiteThemeScopeKey,
  publishSiteThemeRevision,
  saveSiteThemeDraftRevision,
} from "@/db/site-theme";
import { getSiteRuntimeConfig } from "@/db/sites";
import {
  requireSiteBuilderApiContext,
  requireSitePublisherApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  readSiteCmsRequestJson,
  readSiteCmsRequestSearchParam,
  readSiteCmsRevisionId,
} from "@/lib/helpers/site-cms-route";
import {
  logSiteCmsKeyedAuditEvent,
  runSiteCmsKeyedRouteAction,
  SITE_CMS_KEYED_ROUTES,
} from "@/lib/site-cms-revision-route";

const ROUTE = SITE_CMS_KEYED_ROUTES.theme;

export async function handleSiteCmsThemeRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = normalizeSiteThemeScopeKey(readSiteCmsRequestSearchParam(request, "key"));

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "read", { key }, async () => {
    const [runtime, draft, scope] = await Promise.all([
      getSiteRuntimeConfig(context!.site!.id),
      getSiteCurrentThemeDraft(context!.site!.id, { key }),
      getSiteThemeScope(context!.site!.id, { key }),
    ]);

    return NextResponse.json({
      key,
      published: runtime?.theme ?? {},
      draft,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
    });
  });
}

export async function handleSiteCmsThemeDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = normalizeSiteThemeScopeKey(readSiteCmsRequestSearchParam(request, "key"));

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "draft_read", { key }, async () => {
    const draft = await getSiteCurrentThemeDraft(context!.site!.id, { key });
    if (!draft) {
      return NextResponse.json({ error: "CMS theme draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      key: draft.theme.key,
      revisionId: draft.revisionId,
      theme: draft.theme,
    });
  });
}

export async function handleSiteCmsThemeWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as
    | { key?: unknown; label?: unknown; theme?: unknown; message?: unknown }
    | null;
  const key = typeof payload?.key === "string" ? payload.key : null;
  const label = typeof payload?.label === "string" ? payload.label : null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  if (!payload || !payload.theme || typeof payload.theme !== "object" || Array.isArray(payload.theme)) {
    return NextResponse.json({ error: "theme must be provided as an object." }, { status: 400 });
  }

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "write", { key }, async () => {
    const draft = await saveSiteThemeDraftRevision(
      context!.site!.id,
      {
        key,
        label,
        message,
        theme: payload.theme,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
      },
    );

    logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "draftSaved", {
      key: draft.theme.key,
      revisionId: draft.revisionId,
    });

    return NextResponse.json({
      key: draft.theme.key,
      revisionId: draft.revisionId,
      theme: draft.theme,
    });
  });
}

export async function handleSiteCmsThemeDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ??
    (typeof payload?.key === "string" ? payload.key : null);

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "delete", { key }, async () => {
    const result = await deleteSiteThemeDraftRevision(context!.site!.id, { key });
    const themeKey = normalizeSiteThemeScopeKey(key);
    if (result.deleted) {
      logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "draftDeleted", { key: themeKey });
    }
    return NextResponse.json({
      key: themeKey,
      deleted: result.deleted,
    });
  });
}

export async function handleSiteCmsThemePublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown; revisionId?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ??
    (typeof payload?.key === "string" ? payload.key : null);
  const revisionId =
    readSiteCmsRevisionId(readSiteCmsRequestSearchParam(request, "revisionId")) ??
    readSiteCmsRevisionId(payload?.revisionId);

  const log = { key, meta: { revisionId } };
  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "publish", log, async () => {
    const result = await publishSiteThemeRevision(context!.site!.id, {
      key,
      revisionId,
    });

    logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "published", {
      key: result.theme.key,
      revisionId: result.revisionId,
    });

    return NextResponse.json({
      key: result.theme.key,
      revisionId: result.revisionId,
      theme: result.theme,
    });
  });
}
