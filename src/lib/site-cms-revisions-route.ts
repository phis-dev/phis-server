import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  buildSiteNavigationScopeKeyFromArea,
  deleteSiteRevisionHistoryEntries,
  deleteSiteRevisionHistoryEntry,
  isSiteRevisionConflictError,
  isSiteRevisionNotFoundError,
  listSiteRevisionHistory,
  restoreSiteRevision,
  type SiteRevisionScopeInput,
} from "@/db/site-revisions";
import type { SiteRevisionKind } from "@/db/site-revision-scopes";
import { resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import {
  requireSiteBuilderApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  readSiteCmsErrorMessage,
  readSiteCmsRequestJson,
  readSiteCmsRequestSearchParam,
  readSiteCmsRevisionId,
  readSiteCmsRevisionIds,
} from "@/lib/helpers/site-cms-route";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

function readRevisionKind(value: unknown): SiteRevisionKind | null {
  return value === "area" || value === "page" || value === "navigation" || value === "theme" ? value : null;
}

function resolveRevisionScopeInput(
  source: {
    kind: unknown;
    area: unknown;
    path?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
    navKey?: unknown;
    themeKey?: unknown;
    key?: unknown;
  },
): SiteRevisionScopeInput {
  const kind = readRevisionKind(source.kind);
  if (!kind) {
    throw new Error("kind must be one of area, page, navigation, or theme.");
  }

  if (kind === "theme") {
    const key =
      typeof source.themeKey === "string"
        ? source.themeKey.trim()
        : typeof source.key === "string"
          ? source.key.trim()
          : null;
    return {
      kind,
      key,
    };
  }

  const areaValue = typeof source.area === "string" ? source.area.trim().toLowerCase() : "";
  if (!areaValue) {
    throw new Error("area must be provided.");
  }

  const areaMask = resolvePhisCmsAreaMask(areaValue);
  const ownerModuleId = typeof source.ownerModuleId === "string" ? source.ownerModuleId.trim() : "";
  const presetKey = typeof source.presetKey === "string" ? source.presetKey.trim() : "";
  if (kind === "area") {
    if (!ownerModuleId || !presetKey) {
      throw new Error("ownerModuleId and presetKey must be provided for area revisions.");
    }
    return {
      kind,
      areaMask,
      sourcePreset: { ownerModuleId, presetKey },
    };
  }

  if (kind === "page") {
    const path = typeof source.path === "string" ? source.path.trim() : "";
    if ((ownerModuleId || presetKey) && (!ownerModuleId || !presetKey)) {
      throw new Error("ownerModuleId and presetKey must be provided together for page revisions.");
    }
    if (!path && !ownerModuleId) {
      throw new Error("path or ownerModuleId plus presetKey must be provided for page revisions.");
    }

    return {
      kind,
      areaMask,
      address: ownerModuleId
        ? { kind: "preset", ownerModuleId, presetKey }
        : { kind: "path", path },
    };
  }

  const navKey = typeof source.navKey === "string" ? source.navKey.trim() : "";
  if (!navKey) {
    throw new Error("navKey must be provided for navigation revisions.");
  }

  return {
    kind,
    key: buildSiteNavigationScopeKeyFromArea(areaMask, navKey),
  };
}

export async function handleSiteCmsRevisionsRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  try {
    const scope = resolveRevisionScopeInput({
      kind: readSiteCmsRequestSearchParam(request, "kind"),
      area: readSiteCmsRequestSearchParam(request, "area"),
      path: readSiteCmsRequestSearchParam(request, "path"),
      ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId"),
      presetKey: readSiteCmsRequestSearchParam(request, "presetKey"),
      navKey: readSiteCmsRequestSearchParam(request, "navKey"),
      themeKey: readSiteCmsRequestSearchParam(request, "themeKey"),
      key: readSiteCmsRequestSearchParam(request, "key"),
    });

    const result = await listSiteRevisionHistory(context!.site!.id, scope);
    return NextResponse.json({
      kind: result.scope.kind,
      scope: {
        area: result.scope.area,
        path: result.scope.path,
        navKey: result.scope.navKey,
        themeKey: result.scope.themeKey,
      },
      current: {
        publishedRevisionId: result.scope.publishedRevisionId,
        workingDraftRevisionId: result.scope.workingDraftRevisionId,
      },
      rows: result.rows,
    });
  } catch (routeError) {
    logRuntimeEvent("error", "cms.revisions_read.failed", {
      message: "CMS revision history read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-revisions-read",
      error: normalizeLogThrowable(routeError),
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS revision history read failed."),
      },
      { status: 400 },
    );
  }
}

export async function handleSiteCmsRevisionRestore(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as
    | {
        kind?: unknown;
        area?: unknown;
        path?: unknown;
        ownerModuleId?: unknown;
        presetKey?: unknown;
        navKey?: unknown;
        themeKey?: unknown;
        key?: unknown;
        revisionId?: unknown;
        revisionIds?: unknown;
      }
    | null;

  try {
    const scope = resolveRevisionScopeInput({
      kind: payload?.kind,
      area: payload?.area,
      path: payload?.path,
      ownerModuleId: payload?.ownerModuleId,
      presetKey: payload?.presetKey,
      navKey: payload?.navKey,
      themeKey: payload?.themeKey,
      key: payload?.key,
    });
    const revisionId = readSiteCmsRevisionId(payload?.revisionId);
    if (!revisionId) {
      return NextResponse.json({ error: "revisionId must be provided." }, { status: 400 });
    }

    const result = await restoreSiteRevision(context!.site!.id, {
      ...scope,
      revisionId,
      createdByUserId: context!.session?.userId ?? null,
    });

    logSiteCmsAuditEvent(PhiCmsAuditEvent.RevisionRestored, {
      request,
      siteKey: context!.site!.key,
      area: result.scope.area,
      userId: context!.session?.userId ?? null,
      targetType: `cms-${result.scope.kind}-revision`,
      targetId: result.restoredFromRevisionId,
      meta: {
        kind: result.scope.kind,
        cmsPath: result.scope.path,
        navKey: result.scope.navKey,
        themeKey: result.scope.themeKey,
        restoredFromRevisionId: result.restoredFromRevisionId,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      kind: result.scope.kind,
      scope: {
        area: result.scope.area,
        path: result.scope.path,
        navKey: result.scope.navKey,
        themeKey: result.scope.themeKey,
      },
      restoredFromRevisionId: result.restoredFromRevisionId,
      revisionId: result.revisionId,
    });
  } catch (routeError) {
    const status = isSiteRevisionNotFoundError(routeError) ? 404 : 400;
    logRuntimeEvent("error", "cms.revision_restore.failed", {
      message: "CMS revision restore failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-revision-restore",
      error: normalizeLogThrowable(routeError),
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS revision restore failed."),
      },
      { status },
    );
  }
}

export async function handleSiteCmsRevisionDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as
    | {
        kind?: unknown;
        area?: unknown;
        path?: unknown;
        ownerModuleId?: unknown;
        presetKey?: unknown;
        navKey?: unknown;
        themeKey?: unknown;
        key?: unknown;
        revisionId?: unknown;
        revisionIds?: unknown;
      }
    | null;

  try {
    const scope = resolveRevisionScopeInput({
      kind: readSiteCmsRequestSearchParam(request, "kind") ?? payload?.kind,
      area: readSiteCmsRequestSearchParam(request, "area") ?? payload?.area,
      path: readSiteCmsRequestSearchParam(request, "path") ?? payload?.path,
      ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId") ?? payload?.ownerModuleId,
      presetKey: readSiteCmsRequestSearchParam(request, "presetKey") ?? payload?.presetKey,
      navKey: readSiteCmsRequestSearchParam(request, "navKey") ?? payload?.navKey,
      themeKey: readSiteCmsRequestSearchParam(request, "themeKey") ?? payload?.themeKey,
      key: readSiteCmsRequestSearchParam(request, "key") ?? payload?.key,
    });
    const revisionIdsValue =
      readSiteCmsRequestSearchParam(request, "revisionIds") ?? payload?.revisionIds ?? null;
    const revisionIds = readSiteCmsRevisionIds(revisionIdsValue);
    if (revisionIds.length > 0) {
      const result = await deleteSiteRevisionHistoryEntries(context!.site!.id, {
        ...scope,
        revisionIds,
      });

      if (result.deletedCount > 0) {
        logSiteCmsAuditEvent(PhiCmsAuditEvent.RevisionDeleted, {
          request,
          siteKey: context!.site!.key,
          area: result.scope.area,
          userId: context!.session?.userId ?? null,
          targetType: `cms-${result.scope.kind}-revision`,
          meta: {
            kind: result.scope.kind,
            cmsPath: result.scope.path,
            navKey: result.scope.navKey,
            themeKey: result.scope.themeKey,
            revisionIds: result.revisionIds,
            deletedCount: result.deletedCount,
          },
        });
      }

      return NextResponse.json({
        kind: result.scope.kind,
        scope: {
          area: result.scope.area,
          path: result.scope.path,
          navKey: result.scope.navKey,
          themeKey: result.scope.themeKey,
        },
        revisionIds: result.revisionIds,
        deletedCount: result.deletedCount,
      });
    }

    const revisionId = readSiteCmsRevisionId(
      readSiteCmsRequestSearchParam(request, "revisionId") ?? payload?.revisionId,
    );
    if (!revisionId) {
      return NextResponse.json({ error: "revisionId must be provided." }, { status: 400 });
    }

    const result = await deleteSiteRevisionHistoryEntry(context!.site!.id, {
      ...scope,
      revisionId,
    });

    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.RevisionDeleted, {
        request,
        siteKey: context!.site!.key,
        area: result.scope.area,
        userId: context!.session?.userId ?? null,
        targetType: `cms-${result.scope.kind}-revision`,
        targetId: result.revisionId,
        meta: {
          kind: result.scope.kind,
          cmsPath: result.scope.path,
          navKey: result.scope.navKey,
          themeKey: result.scope.themeKey,
          revisionId: result.revisionId,
        },
      });
    }

    return NextResponse.json({
      kind: result.scope.kind,
      scope: {
        area: result.scope.area,
        path: result.scope.path,
        navKey: result.scope.navKey,
        themeKey: result.scope.themeKey,
      },
      revisionId: result.revisionId,
      deleted: result.deleted,
    });
  } catch (routeError) {
    const status = isSiteRevisionConflictError(routeError)
      ? 409
      : isSiteRevisionNotFoundError(routeError)
        ? 404
        : 400;
    logRuntimeEvent("error", "cms.revision_delete.failed", {
      message: "CMS revision delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-revision-delete",
      error: normalizeLogThrowable(routeError),
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, "CMS revision delete failed."),
      },
      { status },
    );
  }
}
