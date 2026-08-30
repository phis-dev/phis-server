import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  deleteSiteNavigationDraftRevision,
  getPublishedSiteNavigationRevision,
  getSiteCurrentNavigationDraft,
  projectSiteNavigationOverlayTargets,
  publishSiteNavigationRevision,
  saveSiteNavigationDraftRevision,
} from "@/db/site-navigation";
import {
  requireSiteBuilderApiContext,
  requireSitePublisherApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  readSiteCmsErrorMessage,
  readSiteCmsRequestJson,
  readSiteCmsRequestSearchParam,
} from "@/lib/helpers/site-cms-route";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

export async function handleSiteCmsNavigationRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = readSiteCmsRequestSearchParam(request, "key");
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  try {
    const navigation = await getPublishedSiteNavigationRevision(context!.site!.id, key);
    if (!navigation) {
      return NextResponse.json({ error: "CMS navigation not found." }, { status: 404 });
    }

    return NextResponse.json({
      key: navigation.overlay.navKey,
      revisionId: navigation.revisionId,
      nextNodeSequence: navigation.nextNodeSequence,
      overlay: await projectSiteNavigationOverlayTargets(context!.site!.id, navigation.overlay),
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.navigation_read.failed", {
      message: "CMS navigation read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-navigation-read",
      error: normalizeLogThrowable(routeError),
      meta: { navKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS navigation read failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsNavigationDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = readSiteCmsRequestSearchParam(request, "key");
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  try {
    const draft = await getSiteCurrentNavigationDraft(context!.site!.id, { key });
    if (!draft) {
      return NextResponse.json({ error: "CMS navigation draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      key: draft.overlay.navKey,
      revisionId: draft.revisionId,
      nextNodeSequence: draft.nextNodeSequence,
      overlay: await projectSiteNavigationOverlayTargets(context!.site!.id, draft.overlay),
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.navigation_draft_read.failed", {
      message: "CMS navigation draft read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-navigation-draft-read",
      error: normalizeLogThrowable(routeError),
      meta: { navKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS navigation draft read failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsNavigationWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as
    | { key?: unknown; overlay?: unknown; nextNodeSequence?: unknown }
    | null;
  const key = typeof payload?.key === "string" ? payload.key : null;
  const overlay = payload?.overlay;
  if (!key || !overlay || payload?.nextNodeSequence == null) {
    return NextResponse.json(
      { error: "key, overlay, and nextNodeSequence must be provided." },
      { status: 400 },
    );
  }

  try {
    const draft = await saveSiteNavigationDraftRevision(
      context!.site!.id,
      {
        key,
        overlay,
        nextNodeSequence: payload.nextNodeSequence,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
      },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.NavigationDraftSaved, {
      request,
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      targetType: "cms-navigation-draft",
      targetId: draft.overlay.navKey,
      meta: {
        navKey: draft.overlay.navKey,
        revisionId: draft.revisionId,
      },
    });

    return NextResponse.json({
      key: draft.overlay.navKey,
      revisionId: draft.revisionId,
      nextNodeSequence: draft.nextNodeSequence,
      overlay: draft.overlay,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.navigation_write.failed", {
      message: "CMS navigation write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-navigation-draft",
      error: normalizeLogThrowable(routeError),
      meta: { navKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS navigation save failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsNavigationDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ?? (typeof payload?.key === "string" ? payload.key : null);
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  try {
    const result = await deleteSiteNavigationDraftRevision(context!.site!.id, { key });
    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.NavigationDraftDeleted, {
        request,
        siteKey: context!.site!.key,
        userId: context!.session?.userId ?? null,
        targetType: "cms-navigation-draft",
        targetId: key,
        meta: { navKey: key },
      });
    }
    return NextResponse.json({
      key,
      deleted: result.deleted,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.navigation_delete.failed", {
      message: "CMS navigation delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-navigation",
      error: normalizeLogThrowable(routeError),
      meta: { navKey: key },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS navigation delete failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsNavigationPublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown; revisionId?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ?? (typeof payload?.key === "string" ? payload.key : null);
  const revisionIdValue =
    readSiteCmsRequestSearchParam(request, "revisionId") ??
    (typeof payload?.revisionId === "number" || typeof payload?.revisionId === "string"
      ? String(payload.revisionId)
      : null);
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  const revisionId =
    revisionIdValue && Number.isInteger(Number(revisionIdValue)) ? Number(revisionIdValue) : null;

  try {
    const result = await publishSiteNavigationRevision(context!.site!.id, {
      key,
      revisionId,
    });

    logSiteCmsAuditEvent(PhiCmsAuditEvent.NavigationPublished, {
      request,
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      targetType: "cms-navigation",
      targetId: result.overlay.navKey,
      meta: {
        navKey: result.overlay.navKey,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      key: result.overlay.navKey,
      revisionId: result.revisionId,
      nextNodeSequence: result.nextNodeSequence,
      overlay: result.overlay,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.navigation_publish.failed", {
      message: "CMS navigation publish failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-navigation-publish",
      error: normalizeLogThrowable(routeError),
      meta: {
        navKey: key,
        revisionId,
      },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS navigation publish failed."),
      },
      { status: 500 },
    );
  }
}
