import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getSiteRequestActorFromRequest } from "@/db/site-request-actor";
import { touchSession } from "@/db/user-sessions";
import { getApiV1TokenMode, guardApiV1 } from "@/lib/api-v1-guard";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";
import {
  canPhiViewerAccess,
  PHI_ACCESS_CONTENT_EDITING,
  PHI_ACCESS_DEVELOPER_TOOLS,
  PHI_ACCESS_PUBLISHING,
  PHI_ACCESS_SITE_ADMIN,
  PHI_ACCESS_SITE_MEDIA,
  PHI_ACCESS_STRUCTURE_AUTHORING,
  PHI_ACCESS_SUPPORT,
  PHI_CORE_ROLE_PROVIDER_ID,
  type PhiViewerAccessPolicy,
} from "@/lib/authorization";
import { requireSiteFromRequest } from "@/lib/site-context";

export type SiteAdminApiContext = {
  site: Awaited<ReturnType<typeof requireSiteFromRequest>>;
  tokenMode: ReturnType<typeof getApiV1TokenMode>;
  session:
    | NonNullable<Awaited<ReturnType<typeof getSiteRequestActorFromRequest>>>["session"]
    | null;
  siteRole:
    | NonNullable<Awaited<ReturnType<typeof getSiteRequestActorFromRequest>>>["siteRole"]
    | null;
};

/** A context the guard let through: the Site, the session and the authorization are all present. */
export type SiteAdminApiGuardedContext = SiteAdminApiContext & {
  site: NonNullable<SiteAdminApiContext["site"]>;
  session: NonNullable<SiteAdminApiContext["session"]>;
  siteRole: NonNullable<SiteAdminApiContext["siteRole"]>;
};

/**
 * What a `require*` guard answers: a context or an error, never neither and never both.
 *
 * The two used to be independently nullable, and every route re-checked after `if (error) return error`
 * that the context, its Site and its session were there -- forty routes, a hundred lines, all of them
 * dead. Stated as a union, `if (error) return error` leaves a context the types vouch for.
 */
export type SiteAdminApiGuard =
  | { context: SiteAdminApiGuardedContext; error: null }
  | { context: null; error: NextResponse };

export type SiteRoleApiResolution = {
  /** The signed-in, enabled actor -- present also when the policy refused them. */
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
  /** The error is the policy's refusal of an actor that is otherwise signed in and enabled. */
  refusedByPolicy: boolean;
};

/**
 * The guard chain once, with the policy's answer beside the actor rather than instead of it.
 *
 * A Media route that is refused Media authority goes on to ask whether the actor may act on this one
 * Space or Asset. Asking that through a second guard ran the whole chain -- session, membership, roles,
 * groups, snapshot -- a second time in the same request. Here the actor stays available after the
 * refusal, so the follow-up question is asked of what was already read.
 */
export async function resolveSiteRoleApiContext(
  request: NextRequest,
  options: {
    policy: PhiViewerAccessPolicy;
    missingRoleMessage: string;
  },
): Promise<SiteRoleApiResolution> {
  const refuse = (error: NextResponse) => ({ context: null, error, refusedByPolicy: false });
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return refuse(guardError);
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return refuse(NextResponse.json({ error: "Site not found." }, { status: 404 }));
  }

  const tokenMode = getApiV1TokenMode(request);
  // Session and authorization from one statement (`getSiteRequestActorFromRequest`).
  const actor = await getSiteRequestActorFromRequest(request, site.id);
  if (!actor) {
    return refuse(NextResponse.json({ error: "Authentication required." }, { status: 401 }));
  }

  const { session, siteRole } = actor;
  if (!siteRole.enabled) {
    return refuse(NextResponse.json({ error: "Site access disabled." }, { status: 403 }));
  }

  await touchSession(session);
  const context = { site, tokenMode, session, siteRole };

  if (!canPhiViewerAccess({
    authenticated: true,
    roleClaims: siteRole.roleClaims,
    groupClaims: siteRole.groupClaims,
  }, options.policy)) {
    return {
      context,
      error: NextResponse.json({ error: options.missingRoleMessage }, { status: 403 }),
      refusedByPolicy: true,
    };
  }

  return { context, error: null, refusedByPolicy: false };
}

async function requireSiteRoleApiContext(
  request: NextRequest,
  options: {
    policy: PhiViewerAccessPolicy;
    missingRoleMessage: string;
  },
): Promise<SiteAdminApiGuard> {
  const { context, error } = await resolveSiteRoleApiContext(request, options);
  // A refused actor is not handed out: the caller of a plain guard reads a context as a pass.
  if (error) {
    return { context: null, error };
  }
  // The resolution above returns a context only with its Site, session and authorization read.
  return { context: context as SiteAdminApiGuardedContext, error: null };
}

export async function requireSiteAdminOnlyApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_SITE_ADMIN,
    missingRoleMessage: "Site admin role required.",
  });
}

export async function requireSiteDeveloperApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_DEVELOPER_TOOLS,
    missingRoleMessage: "Site developer or admin role required.",
  });
}

export async function requireSiteAuthorApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_CONTENT_EDITING,
    missingRoleMessage: "Site author, publisher, developer, or admin role required.",
  });
}

export async function requireSiteBuilderApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_STRUCTURE_AUTHORING,
    missingRoleMessage: "Site builder, developer, or admin role required.",
  });
}

/**
 * Guards every Site Media management surface: Asset listing and detail, Folder trees, uploads, and
 * Asset mutations. Delivery is deliberately not guarded here — it runs on the Asset's own lifecycle
 * and delivery policy, so a public page keeps rendering without a session.
 */
export const PHI_SITE_MEDIA_API_POLICY = {
  policy: PHI_ACCESS_SITE_MEDIA,
  missingRoleMessage: "Site builder, author, publisher, developer, or admin role required.",
} as const;

export async function requireSiteMediaApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, PHI_SITE_MEDIA_API_POLICY);
}

export async function requireSiteSupportApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_SUPPORT,
    missingRoleMessage: "Site supporter, developer, or admin role required.",
  });
}

export async function requireSitePublisherApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_PUBLISHING,
    missingRoleMessage: "Site publisher, developer, or admin role required.",
  });
}

export async function requireSiteReviewApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: {
      access: "roles",
      providerId: PHI_CORE_ROLE_PROVIDER_ID,
      allowedRoleFlags:
        PhiBaseRole.Developer |
        PhiBaseRole.Builder |
        PhiBaseRole.Author |
        PhiBaseRole.Publisher,
    },
    missingRoleMessage: "Site builder, author, publisher, developer, or admin role required.",
  });
}

export async function requireSiteCmsPreviewApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteReviewApiContext(request);
}

/**
 * Every enabled Site user, with no Core role required.
 *
 * Group administration is authorized by membership rather than by a Site role, so the role gate has to
 * pass before the group level can be looked at. The session, Site, and enablement checks still run.
 */
export async function requireSiteAuthenticatedApiContext(request: NextRequest): Promise<SiteAdminApiGuard> {
  return requireSiteRoleApiContext(request, {
    policy: { access: "authenticated" },
    missingRoleMessage: "Authentication required.",
  });
}
