import { NextRequest, NextResponse } from "next/server";

import {
  getUserAccountByEmail,
} from "@/db/user-accounts";
import { getSiteRuntimeConfig } from "@/db/sites";
import { getEffectiveUserSiteAuthorization, recordUserSiteLogin } from "@/db/user-site-memberships";
import { deleteExpiredUserSessions } from "@/db/user-sessions";
import {
  setAreaCookie,
  clearAreaCookie,
  readRequestIp,
  readRequestUserAgent,
  setCsrfCookie,
  setSessionCookie,
  verifyCsrfRequest,
  createCsrfToken,
} from "@/lib/auth";
import { resolveSiteLocale } from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { verifyPasswordHash } from "@/lib/password";
import { requireSiteFromRequest } from "@/lib/site-context";
import { resolvePhiUserArea } from "@/lib/user-area";
import { isUserAccountEnabled } from "@/lib/user-flags";
import { beginSiteAuthenticationSession } from "@/lib/site-auth/assurance";
import { normalizeAuthNextPath, PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";

type LoginPayload = {
  email?: unknown;
  password?: unknown;
  next?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  if (!verifyCsrfRequest(request)) {
    logRuntimeEvent("warn", "auth.login.csrf_failed", {
      message: "Login rejected because CSRF validation failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  let payload: LoginPayload = {};
  try {
    payload = (await request.json()) as LoginPayload;
  } catch {
    logRuntimeEvent("warn", "auth.login.invalid_payload", {
      message: "Login rejected because the payload is invalid.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = normalize(payload.email).toLowerCase();
  const password = normalize(payload.password);

  if (!email || !password) {
    logRuntimeEvent("warn", "auth.login.failed", {
      message: "Login failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email: email || null,
        reason: "missing_email_or_password",
      },
    });
    return NextResponse.json({ error: "Missing email or password." }, { status: 400 });
  }

  const user = await getUserAccountByEmail(email, site.id);

  if (!user || !user.siteIds.includes(site.id) || !user.passwordHash) {
    logRuntimeEvent("warn", "auth.login.failed", {
      message: "Login failed.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email,
        reason: "invalid_credentials",
      },
    });
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }
  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);

  try {
    const validPassword = await verifyPasswordHash(user.passwordHash, password);
    if (!validPassword) {
      logRuntimeEvent("warn", "auth.login.failed", {
        message: "Login failed.",
        siteKey: site.key,
        userId: user.id,
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          email: user.emailNormalized,
          reason: "invalid_credentials",
        },
      });
      return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
    }
    if (!isUserAccountEnabled(user.flags) || !siteRole.enabled) {
      logRuntimeEvent("warn", "auth.login.account_disabled", {
        message: "Login blocked for disabled account.",
        siteKey: site.key,
        userId: user.id,
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          email: user.emailNormalized,
          reason: "account_disabled",
        },
      });
      return NextResponse.json(
        {
          code: "account_disabled",
          error: "Account disabled.",
        },
        { status: 403 },
      );
    }

    const session = await beginSiteAuthenticationSession({
      userId: user.id,
      siteId: site.id,
      coreRoleFlags: siteRole.coreRoleFlags,
      authMethodKeys: ["password"],
      nextPath: normalizeAuthNextPath(payload.next),
      ipAddress: readRequestIp(request),
      userAgent: readRequestUserAgent(request),
    });
    const complete = session.authState === PHI_AUTH_SESSION_STATES.complete;
    if (complete) {
      await recordUserSiteLogin(user.id, site.id);
    }

    try {
      await deleteExpiredUserSessions();
    } catch (error) {
      logRuntimeEvent("error", "auth.login.session_cleanup_failed", {
        message: "Expired session cleanup failed after login.",
        siteKey: site.key,
        userId: user.id,
        method: request.method,
        path: request.nextUrl.pathname,
        error: normalizeLogThrowable(error),
      });
    }

    const area = resolvePhiUserArea({
      authenticated: true,
      roleClaims: siteRole.roleClaims,
    });

    logRuntimeEvent("info", complete ? "auth.login.success" : "auth.login.factor_required", {
      message: complete ? "Login succeeded." : "Primary authentication requires another factor.",
      siteKey: site.key,
      userId: user.id,
      area,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email: user.emailNormalized,
        sessionExpiresAt: session.expiresAt.toISOString(),
      },
    });

    const csrfToken = createCsrfToken();
    const runtimeConfig = await getSiteRuntimeConfig(site.id);
    const preferredLocale = resolveSiteLocale({
      userPreferredLocale: user.preferredLocale,
      defaultLocale: runtimeConfig?.defaultLocale ?? site.defaultLocale,
      availableLocales: runtimeConfig?.availableLocales.map((option) => option.code) ?? [site.defaultLocale],
    }).locale;
    const response = NextResponse.json({
      complete,
      ...(complete ? { area } : {}),
      ...(!complete ? {
        workflow: {
          state: session.authState === PHI_AUTH_SESSION_STATES.factorEnrollmentRequired
            ? "factor-enrollment-required"
            : "factor-challenge-required",
          methodKey: "totp",
          next: normalizeAuthNextPath(payload.next),
        },
      } : {}),
      user: {
        id: user.id,
        email: user.emailNormalized,
        name: user.emailNormalized,
        flags: user.flags,
      },
    });

    setSessionCookie(response, session.id, session.secret, session.expiresAt);
    setCsrfCookie(response, csrfToken);
    if (complete) {
      setAreaCookie(response, area, session.expiresAt);
    } else {
      clearAreaCookie(response);
    }
    response.cookies.set("phis_locale", preferredLocale, {
      path: "/",
      sameSite: "lax",
      expires: session.expiresAt,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed.";
    logRuntimeEvent("error", "auth.login.failed", {
      message,
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email,
        reason: "exception",
      },
      error: normalizeLogThrowable(error),
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
