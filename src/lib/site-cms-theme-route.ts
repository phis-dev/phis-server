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
  readSiteCmsErrorMessage,
  readSiteCmsRequestJson,
  readSiteCmsRequestSearchParam,
  readSiteCmsRevisionId,
} from "@/lib/helpers/site-cms-route";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

export async function handleSiteCmsThemeRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = normalizeSiteThemeScopeKey(readSiteCmsRequestSearchParam(request, "key"));

  try {
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
  } catch (routeError) {
    logRuntimeEvent("error", "cms.theme_read.failed", {
      message: "CMS theme read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-theme-read",
      error: normalizeLogThrowable(routeError),
      meta: { themeKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS theme read failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsThemeDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = normalizeSiteThemeScopeKey(readSiteCmsRequestSearchParam(request, "key"));

  try {
    const draft = await getSiteCurrentThemeDraft(context!.site!.id, { key });
    if (!draft) {
      return NextResponse.json({ error: "CMS theme draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      key: draft.theme.key,
      revisionId: draft.revisionId,
      theme: draft.theme,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.theme_draft_read.failed", {
      message: "CMS theme draft read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-theme-draft-read",
      error: normalizeLogThrowable(routeError),
      meta: { themeKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS theme draft read failed."),
      },
      { status: 500 },
    );
  }
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

  try {
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

    logSiteCmsAuditEvent(PhiCmsAuditEvent.ThemeDraftSaved, {
      request,
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      targetType: "cms-theme-draft",
      targetId: draft.theme.key,
      meta: {
        themeKey: draft.theme.key,
        revisionId: draft.revisionId,
      },
    });

    return NextResponse.json({
      key: draft.theme.key,
      revisionId: draft.revisionId,
      theme: draft.theme,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.theme_write.failed", {
      message: "CMS theme write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-theme-draft",
      error: normalizeLogThrowable(routeError),
      meta: { themeKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS theme save failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsThemeDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ?? (typeof payload?.key === "string" ? payload.key : null);

  try {
    const result = await deleteSiteThemeDraftRevision(context!.site!.id, { key });
    const themeKey = normalizeSiteThemeScopeKey(key);
    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.ThemeDraftDeleted, {
        request,
        siteKey: context!.site!.key,
        userId: context!.session?.userId ?? null,
        targetType: "cms-theme-draft",
        targetId: themeKey,
        meta: { themeKey },
      });
    }
    return NextResponse.json({
      key: themeKey,
      deleted: result.deleted,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.theme_delete.failed", {
      message: "CMS theme delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-theme",
      error: normalizeLogThrowable(routeError),
      meta: { themeKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS theme delete failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsThemePublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown; revisionId?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ?? (typeof payload?.key === "string" ? payload.key : null);
  const revisionId =
    readSiteCmsRevisionId(readSiteCmsRequestSearchParam(request, "revisionId")) ?? readSiteCmsRevisionId(payload?.revisionId);

  try {
    const result = await publishSiteThemeRevision(context!.site!.id, {
      key,
      revisionId,
    });

    logSiteCmsAuditEvent(PhiCmsAuditEvent.ThemePublished, {
      request,
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      targetType: "cms-theme",
      targetId: result.theme.key,
      meta: {
        themeKey: result.theme.key,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      key: result.theme.key,
      revisionId: result.revisionId,
      theme: result.theme,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.theme_publish.failed", {
      message: "CMS theme publish failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-theme-publish",
      error: normalizeLogThrowable(routeError),
      meta: {
        themeKey: key,
        revisionId,
      },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS theme publish failed."),
      },
      { status: 500 },
    );
  }
}
