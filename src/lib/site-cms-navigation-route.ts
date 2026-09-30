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
import { readSiteCmsRequestJson, readSiteCmsRequestSearchParam } from "@/lib/helpers/site-cms-route";
import {
  logSiteCmsKeyedAuditEvent,
  runSiteCmsKeyedRouteAction,
  SITE_CMS_KEYED_ROUTES,
} from "@/lib/site-cms-revision-route";

const ROUTE = SITE_CMS_KEYED_ROUTES.navigation;

export async function handleSiteCmsNavigationRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const key = readSiteCmsRequestSearchParam(request, "key");
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "read", { key }, async () => {
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
  });
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

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "draft_read", { key }, async () => {
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
  });
}

export async function handleSiteCmsNavigationWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as
    | { key?: unknown; overlay?: unknown; nextNodeSequence?: unknown; baseRevisionId?: unknown }
    | null;
  const key = typeof payload?.key === "string" ? payload.key : null;
  const overlay = payload?.overlay;
  if (!key || !overlay || payload?.nextNodeSequence == null) {
    return NextResponse.json(
      { error: "key, overlay, and nextNodeSequence must be provided." },
      { status: 400 },
    );
  }

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "write", { key }, async () => {
    const draft = await saveSiteNavigationDraftRevision(
      context!.site!.id,
      {
        key,
        overlay,
        nextNodeSequence: payload.nextNodeSequence,
        baseRevisionId: payload.baseRevisionId,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
      },
    );

    logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "draftSaved", {
      key: draft.overlay.navKey,
      revisionId: draft.revisionId,
    });

    return NextResponse.json({
      key: draft.overlay.navKey,
      revisionId: draft.revisionId,
      nextNodeSequence: draft.nextNodeSequence,
      overlay: draft.overlay,
      // The other Navigations of the Area this save carried a folder target into, with their new Drafts.
      carriedOver: draft.carriedOver,
    });
  });
}

export async function handleSiteCmsNavigationDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ??
    (typeof payload?.key === "string" ? payload.key : null);
  if (!key) {
    return NextResponse.json({ error: "key must be provided." }, { status: 400 });
  }

  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "delete", { key }, async () => {
    const result = await deleteSiteNavigationDraftRevision(context!.site!.id, { key });
    if (result.deleted) {
      logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "draftDeleted", { key });
    }
    return NextResponse.json({
      key,
      deleted: result.deleted,
    });
  });
}

export async function handleSiteCmsNavigationPublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as { key?: unknown; revisionId?: unknown } | null;
  const key = readSiteCmsRequestSearchParam(request, "key") ??
    (typeof payload?.key === "string" ? payload.key : null);
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

  const log = { key, meta: { revisionId } };
  return runSiteCmsKeyedRouteAction(request, context!, ROUTE, "publish", log, async () => {
    const result = await publishSiteNavigationRevision(context!.site!.id, {
      key,
      revisionId,
    });

    logSiteCmsKeyedAuditEvent(request, context!, ROUTE, "published", {
      key: result.overlay.navKey,
      revisionId: result.revisionId,
    });

    return NextResponse.json({
      key: result.overlay.navKey,
      revisionId: result.revisionId,
      nextNodeSequence: result.nextNodeSequence,
      overlay: result.overlay,
    });
  });
}
