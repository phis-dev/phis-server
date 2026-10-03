import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest, touchSession } from "@/db/user-sessions";
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
    | Awaited<ReturnType<typeof getSessionFromRequest>>
    | null;
  siteRole:
    | Awaited<ReturnType<typeof getEffectiveUserSiteAuthorization>>
    | null;
};

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
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return refuse(guardError);
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return refuse(NextResponse.json({ error: "Site not found." }, { status: 404 }));
  }

  const tokenMode = getApiV1TokenMode(request);
  const session = await getSessionFromRequest(request, site.id);
  if (!session) {
    return refuse(NextResponse.json({ error: "Authentication required." }, { status: 401 }));
  }

  const siteRole = await getEffectiveUserSiteAuthorization(session.userId, site.id);
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
): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  const { context, error } = await resolveSiteRoleApiContext(request, options);
  // A refused actor is not handed out: the caller of a plain guard reads a context as a pass.
  return error ? { context: null, error } : { context, error: null };
}

export async function requireSiteAdminOnlyApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_SITE_ADMIN,
    missingRoleMessage: "Site admin role required.",
  });
}

export async function requireSiteDeveloperApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_DEVELOPER_TOOLS,
    missingRoleMessage: "Site developer or admin role required.",
  });
}

export async function requireSiteAuthorApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_CONTENT_EDITING,
    missingRoleMessage: "Site author, publisher, developer, or admin role required.",
  });
}

export async function requireSiteBuilderApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
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

export async function requireSiteMediaApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, PHI_SITE_MEDIA_API_POLICY);
}

export async function requireSiteSupportApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_SUPPORT,
    missingRoleMessage: "Site supporter, developer, or admin role required.",
  });
}

export async function requireSitePublisherApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: PHI_ACCESS_PUBLISHING,
    missingRoleMessage: "Site publisher, developer, or admin role required.",
  });
}

export async function requireSiteReviewApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
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

export async function requireSiteCmsPreviewApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteReviewApiContext(request);
}

/**
 * Every enabled Site user, with no Core role required.
 *
 * Group administration is authorized by membership rather than by a Site role, so the role gate has to
 * pass before the group level can be looked at. The session, Site, and enablement checks still run.
 */
export async function requireSiteAuthenticatedApiContext(request: NextRequest): Promise<{
  context: SiteAdminApiContext | null;
  error: NextResponse | null;
}> {
  return requireSiteRoleApiContext(request, {
    policy: { access: "authenticated" },
    missingRoleMessage: "Authentication required.",
  });
}
