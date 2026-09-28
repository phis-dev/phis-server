import { NextRequest, NextResponse } from "next/server";

import { getUserAccountById } from "@/db/user-accounts";
import { getSiteRuntimeConfig } from "@/db/sites";
import { getEffectiveUserSiteAuthorization, recordUserSiteLogin } from "@/db/user-site-memberships";
import {
  createCsrfToken,
  setAuthLinkCookie,
  clearAreaCookie,
  readRequestIp,
  readRequestUserAgent,
  resolveSignedInLocale,
  setAreaCookie,
  setCsrfCookie,
  setLocaleCookie,
  setSessionCookie,
  setThemeModeCookie,
} from "@/lib/auth";
import { resolveUserThemeModeName } from "@/lib/user-flags";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeProviderKey } from "@/lib/site-auth/contracts";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { beginSiteAuthenticationSession } from "@/lib/site-auth/assurance";
import { resolveExternalLogin } from "@/lib/site-auth/external-login";
import { createExternalIdentityLinkChallenge } from "@/lib/site-auth/identity-link-flow";
import { completeProviderAuthentication } from "@/lib/site-auth/provider-flow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";
import { resolvePhiUserArea } from "@/lib/user-area";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string }> };

function failureRedirect(publicUrl: string, code: string) {
  const url = new URL("/login", publicUrl);
  url.searchParams.set("auth", code.toLowerCase());
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest, context: Context) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) {
    return siteContext.error;
  }
  const runtime = await getSiteRuntimeConfig(siteContext.site.id);
  if (!runtime) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }
  const methodKey = normalizeProviderKey((await context.params).provider);
  if (!methodKey) {
    return failureRedirect(runtime.publicUrl, "provider_unknown");
  }

  try {
    const completed = await completeProviderAuthentication({
      siteId: siteContext.site.id,
      sitePublicUrl: runtime.publicUrl,
      methodKey,
      requestUrl: request.url,
    });
    const resolution = await resolveExternalLogin({
      siteId: siteContext.site.id,
      identity: completed.identity,
      trustedForAutoLink: completed.trustedForAutoLink,
    });
    if (!resolution.ok) {
      if (resolution.code === "link_required") {
        const challenge = await createExternalIdentityLinkChallenge({
          siteId: siteContext.site.id,
          userId: resolution.userId,
          methodKey,
          providerInstallationKey: completed.providerInstallationKey,
          identity: completed.identity,
          nextPath: completed.nextPath,
        });
        const destination = new URL("/login", runtime.publicUrl);
        destination.searchParams.set("auth", "link_required");
        destination.searchParams.set("next", completed.nextPath);
        const response = NextResponse.redirect(destination);
        setAuthLinkCookie(response, challenge.token, challenge.expiresAt);
        return response;
      }
      return failureRedirect(runtime.publicUrl, resolution.code);
    }
    const authorization = await getEffectiveUserSiteAuthorization(resolution.userId, siteContext.site.id);
    if (!authorization.enabled) {
      return failureRedirect(runtime.publicUrl, "account_disabled");
    }
    const session = await beginSiteAuthenticationSession({
      userId: resolution.userId,
      siteId: siteContext.site.id,
      coreRoleFlags: authorization.coreRoleFlags,
      authMethodKeys: [methodKey],
      nextPath: completed.nextPath,
      ipAddress: readRequestIp(request),
      userAgent: readRequestUserAgent(request),
    });
    const complete = session.authState === PHI_AUTH_SESSION_STATES.complete;
    if (complete) {
      await recordUserSiteLogin(resolution.userId, siteContext.site.id);
    }
    const area = resolvePhiUserArea({ authenticated: true, roleClaims: authorization.roleClaims });
    const destination = complete
      ? new URL(completed.nextPath, runtime.publicUrl)
      : new URL("/login", runtime.publicUrl);
    if (!complete) {
      destination.searchParams.set("auth", "continue");
      destination.searchParams.set("next", completed.nextPath);
    }
    const response = NextResponse.redirect(destination);
    const csrfToken = createCsrfToken();
    const user = await getUserAccountById(resolution.userId, siteContext.site.id);
    const locale = resolveSignedInLocale(request, {
      user,
      defaultLocale: runtime.defaultLocale,
      availableLocales: runtime.availableLocales.map((option) => option.code),
    });
    setSessionCookie(response, session.id, session.secret, session.expiresAt);
    setCsrfCookie(response, csrfToken);
    if (complete) {
      setAreaCookie(response, area, session.expiresAt);
    } else {
      clearAreaCookie(response);
    }
    setLocaleCookie(response, locale, session.expiresAt);
    setThemeModeCookie(response, resolveUserThemeModeName(user?.flags), session.expiresAt);
    logRuntimeEvent("info", complete ? "auth.provider.success" : "auth.provider.factor_required", {
      message: complete ? "Provider login succeeded." : "Provider login requires another factor.",
      siteKey: siteContext.site.key,
      userId: resolution.userId,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { provider: methodKey, created: resolution.created, linked: resolution.linked },
    });
    return response;
  } catch (error) {
    const code = error instanceof Error ? error.message : "AUTH_PROVIDER_CALLBACK_FAILED";
    logRuntimeEvent("warn", "auth.provider.failed", {
      message: "Provider login failed.",
      siteKey: siteContext.site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { provider: methodKey, reason: code },
    });
    return failureRedirect(runtime.publicUrl, "provider_failed");
  }
}
