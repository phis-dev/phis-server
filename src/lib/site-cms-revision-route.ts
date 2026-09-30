import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SiteCmsDraftConflictError } from "@/db/site-revision-scopes";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import type { SiteAdminApiContext } from "@/lib/guards/site-admin-api";
import { readSiteCmsErrorMessage } from "@/lib/helpers/site-cms-route";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

/*
 * The part of the Navigation and Theme routes that is the same for both: how a failed call is logged
 * and answered, and how a saved, discarded or published Draft is audited. Both kinds name their events,
 * messages and target types after one noun, so the noun and the meta field their key is logged under
 * are all that tells them apart here. What each route reads from the request and answers stays with
 * the route, because that is where the two kinds really differ.
 */

export type SiteCmsKeyedRoute = {
  noun: "navigation" | "theme";
  keyMeta: "navKey" | "themeKey";
  events: {
    draftSaved: PhiCmsAuditEvent;
    draftDeleted: PhiCmsAuditEvent;
    published: PhiCmsAuditEvent;
  };
};

export const SITE_CMS_KEYED_ROUTES = {
  navigation: {
    noun: "navigation",
    keyMeta: "navKey",
    events: {
      draftSaved: PhiCmsAuditEvent.NavigationDraftSaved,
      draftDeleted: PhiCmsAuditEvent.NavigationDraftDeleted,
      published: PhiCmsAuditEvent.NavigationPublished,
    },
  },
  theme: {
    noun: "theme",
    keyMeta: "themeKey",
    events: {
      draftSaved: PhiCmsAuditEvent.ThemeDraftSaved,
      draftDeleted: PhiCmsAuditEvent.ThemeDraftDeleted,
      published: PhiCmsAuditEvent.ThemePublished,
    },
  },
} as const satisfies Record<SiteCmsKeyedRoute["noun"], SiteCmsKeyedRoute>;

export type SiteCmsKeyedRouteAction = "read" | "draft_read" | "write" | "delete" | "publish";

/** The log event, log message, target type and answer of a failed call, per action. */
function describeSiteCmsKeyedRouteFailure(route: SiteCmsKeyedRoute, action: SiteCmsKeyedRouteAction) {
  const noun = route.noun;
  switch (action) {
    case "read":
    case "draft_read": {
      const message = `CMS ${noun} ${action === "read" ? "read" : "draft read"} failed.`;
      return {
        event: `cms.${noun}_${action}.failed`,
        message,
        targetType: `cms-${noun}-${action.replace("_", "-")}`,
        answer: message,
      };
    }
    case "write":
      return {
        event: `cms.${noun}_write.failed`,
        message: `CMS ${noun} write failed.`,
        targetType: `cms-${noun}-draft`,
        answer: `CMS ${noun} save failed.`,
      };
    case "delete":
      return {
        event: `cms.${noun}_delete.failed`,
        message: `CMS ${noun} delete failed.`,
        targetType: `cms-${noun}`,
        answer: `CMS ${noun} delete failed.`,
      };
    case "publish":
      return {
        event: `cms.${noun}_publish.failed`,
        message: `CMS ${noun} publish failed.`,
        targetType: `cms-${noun}-publish`,
        answer: `CMS ${noun} publish failed.`,
      };
  }
}

/**
 * Runs one action of a keyed CMS route and turns what it throws into the logged error answer. A Draft
 * conflict answers 409, since the caller acted on a Draft that is no longer the one it named; anything
 * else is the server's failure. `key` is logged as the request gave it, under the route's key field.
 */
export async function runSiteCmsKeyedRouteAction(
  request: NextRequest,
  context: SiteAdminApiContext,
  route: SiteCmsKeyedRoute,
  action: SiteCmsKeyedRouteAction,
  log: { key: string | null; meta?: Record<string, unknown> },
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await run();
  } catch (routeError) {
    const failure = describeSiteCmsKeyedRouteFailure(route, action);
    logRuntimeEvent("error", failure.event, {
      message: failure.message,
      siteKey: context.site!.key,
      userId: context.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: failure.targetType,
      error: normalizeLogThrowable(routeError),
      meta: { [route.keyMeta]: log.key, ...log.meta },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(routeError, failure.answer),
      },
      { status: routeError instanceof SiteCmsDraftConflictError ? 409 : 500 },
    );
  }
}

/**
 * Audits a Draft saved, a Draft discarded or a publish. A discard names no revision: the one it removed
 * is gone, and the audit says which scope lost its Draft.
 */
export function logSiteCmsKeyedAuditEvent(
  request: NextRequest,
  context: SiteAdminApiContext,
  route: SiteCmsKeyedRoute,
  event: keyof SiteCmsKeyedRoute["events"],
  target: { key: string; revisionId?: number },
) {
  logSiteCmsAuditEvent(route.events[event], {
    request,
    siteKey: context.site!.key,
    userId: context.session?.userId ?? null,
    targetType: event === "published" ? `cms-${route.noun}` : `cms-${route.noun}-draft`,
    targetId: target.key,
    meta: event === "draftDeleted"
      ? { [route.keyMeta]: target.key }
      : { [route.keyMeta]: target.key, revisionId: target.revisionId },
  });
}
