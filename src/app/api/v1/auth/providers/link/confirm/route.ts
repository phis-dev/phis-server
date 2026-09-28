import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { recordUserSiteLogin } from "@/db/user-site-memberships";
import {
  AUTH_LINK_COOKIE_NAME,
  clearAreaCookie,
  clearAuthLinkCookie,
  createCsrfToken,
  readRequestIp,
  readRequestUserAgent,
  resolveSignedInLocale,
  setAreaCookie,
  setCsrfCookie,
  setLocaleCookie,
  setSessionCookie,
  verifyCsrfRequest,
} from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { beginSiteAuthenticationSession } from "@/lib/site-auth/assurance";
import { PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { confirmExternalIdentityLink } from "@/lib/site-auth/identity-link-flow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";
import { resolvePhiUserArea } from "@/lib/user-area";

export const dynamic = "force-dynamic";

function errorResponse(error: string, code: string, status: number) {
  const response = NextResponse.json({ error, code, returnToLogin: true }, { status });
  clearAuthLinkCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) return siteContext.error;
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  const token = request.cookies.get(AUTH_LINK_COOKIE_NAME)?.value?.trim() ?? "";
  const payload = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = typeof payload?.password === "string" ? payload.password : "";
  if (!token || !password) {
    return errorResponse(
      "Provider link confirmation expired. Sign in normally or start the provider login again.",
      "link_confirmation_expired",
      400,
    );
  }

  try {
    const confirmed = await confirmExternalIdentityLink({
      siteId: siteContext.site.id,
      token,
      password,
    });
    const session = await beginSiteAuthenticationSession({
      userId: confirmed.user.id,
      siteId: siteContext.site.id,
      coreRoleFlags: confirmed.authorization.coreRoleFlags,
      authMethodKeys: [confirmed.methodKey, "password"],
      nextPath: confirmed.nextPath,
      ipAddress: readRequestIp(request),
      userAgent: readRequestUserAgent(request),
    });
    const complete = session.authState === PHI_AUTH_SESSION_STATES.complete;
    if (complete) {
      await recordUserSiteLogin(confirmed.user.id, siteContext.site.id);
    }
    const area = resolvePhiUserArea({
      authenticated: true,
      roleClaims: confirmed.authorization.roleClaims,
    });
    const runtime = await getSiteRuntimeConfig(siteContext.site.id);
    const locale = resolveSignedInLocale(request, {
      user: confirmed.user,
      defaultLocale: runtime?.defaultLocale ?? siteContext.site.defaultLocale,
      availableLocales: runtime?.availableLocales.map((option) => option.code) ?? [siteContext.site.defaultLocale],
    });
    const response = NextResponse.json({
      complete,
      next: confirmed.nextPath,
      ...(complete ? { area } : {
        workflow: {
          state: session.authState === PHI_AUTH_SESSION_STATES.factorEnrollmentRequired
            ? "factor-enrollment-required"
            : "factor-challenge-required",
          methodKey: "totp",
          next: confirmed.nextPath,
        },
      }),
    });
    const csrfToken = createCsrfToken();
    setSessionCookie(response, session.id, session.secret, session.expiresAt);
    setCsrfCookie(response, csrfToken);
    clearAuthLinkCookie(response);
    if (complete) {
      setAreaCookie(response, area, session.expiresAt);
    } else {
      clearAreaCookie(response);
    }
    setLocaleCookie(response, locale, session.expiresAt);
    logRuntimeEvent("info", complete ? "auth.provider.linked" : "auth.provider.linked_factor_required", {
      message: complete
        ? "Provider identity linked and login succeeded."
        : "Provider identity linked and requires another factor.",
      siteKey: siteContext.site.key,
      userId: confirmed.user.id,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { provider: confirmed.methodKey },
    });
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "AUTH_LINK_FAILED";
    logRuntimeEvent("warn", "auth.provider.link_failed", {
      message: "Provider identity link confirmation failed.",
      siteKey: siteContext.site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      error: normalizeLogThrowable(error),
      meta: { reason },
    });
    if (reason === "AUTH_LINK_INVALID_CREDENTIALS") {
      return errorResponse(
        "The password is incorrect. The login provider was not linked.",
        "link_confirmation_invalid_credentials",
        401,
      );
    }
    if (reason === "AUTH_LINK_ACCOUNT_DISABLED") {
      return errorResponse("Account disabled.", "account_disabled", 403);
    }
    if (reason === "AUTH_LINK_PASSWORD_UNAVAILABLE") {
      return errorResponse(
        "This account cannot confirm linking with a password.",
        "link_confirmation_password_unavailable",
        409,
      );
    }
    return errorResponse(
      "Provider link confirmation expired. Sign in normally or start the provider login again.",
      "link_confirmation_expired",
      410,
    );
  }
}
