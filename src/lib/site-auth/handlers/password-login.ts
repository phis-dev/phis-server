import { NextRequest, NextResponse } from "next/server";

import {
  getUserAccountByEmail,
} from "@/db/user-accounts";
import { getSiteRuntimeConfig } from "@/db/sites";
import { getEffectiveUserSiteAuthorization, recordUserSiteLogin } from "@/db/user-site-memberships";
import {
  setAreaCookie,
  clearAreaCookie,
  readRequestIp,
  readRequestUserAgent,
  resolveSignedInLocale,
  setCsrfCookie,
  setLocaleCookie,
  setSessionCookie,
  setThemeModeCookie,
  createCsrfToken,
} from "@/lib/auth";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { verifyPasswordHash } from "@/lib/password";
import { resolvePhiUserArea } from "@/lib/user-area";
import { isUserAccountEnabled, resolveUserThemeModeName } from "@/lib/user-flags";
import { beginSiteAuthenticationSession } from "@/lib/site-auth/assurance";
import { requireCsrfCheckedSite } from "@/lib/site-auth/authenticated-site-user";
import { normalizeAuthNextPath, PHI_AUTH_SESSION_STATES } from "@/lib/site-auth/contracts";
import { checkAuthAttemptLimit, tooManyAttemptsResponse } from "@/lib/site-auth/attempt-limit";
import {
  isSitePasswordMethodEnabled,
  PASSWORD_METHOD_DISABLED_RESPONSE,
} from "@/lib/site-auth/password-method";
import { normalizeString } from "@/lib/helpers/request";

type LoginPayload = {
  email?: unknown;
  password?: unknown;
  next?: unknown;
};

export async function POST(request: NextRequest) {
  const checked = await requireCsrfCheckedSite(request);
  if (!checked.ok) {
    if ("site" in checked) {
      logRuntimeEvent("warn", "auth.login.csrf_failed", {
        message: "Login rejected because CSRF validation failed.",
        siteKey: checked.site.key,
        method: request.method,
        path: request.nextUrl.pathname,
      });
    }
    return checked.response;
  }
  const { site } = checked;

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

  // Before the credentials are even looked at: a method that is switched off answers nobody.
  if (!await isSitePasswordMethodEnabled(site.id)) {
    logRuntimeEvent("warn", "auth.login.method_disabled", {
      message: "Login rejected because the password method is disabled.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
    });
    return NextResponse.json(PASSWORD_METHOD_DISABLED_RESPONSE, { status: 403 });
  }

  const email = normalizeString(payload.email).toLowerCase();
  const password = normalizeString(payload.password);

  // Measured per account, because the internal token this route arrives with is exempt from the
  // per-address limit and nothing else counted the guesses.
  const retryAfter = email ? await checkAuthAttemptLimit(request, [`login:${site.id}:${email}`]) : null;
  if (retryAfter !== null) {
    logRuntimeEvent("warn", "auth.login.throttled", {
      message: "Login throttled after too many attempts.",
      siteKey: site.key,
      method: request.method,
      path: request.nextUrl.pathname,
      meta: { email },
    });
    return tooManyAttemptsResponse(retryAfter);
  }

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
    return NextResponse.json(
      {
        code: "invalid_credentials",
        error: "Invalid credentials.",
      },
      { status: 401 },
    );
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
      return NextResponse.json(
        {
          code: "invalid_credentials",
          error: "Invalid credentials.",
        },
        { status: 401 },
      );
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
      request,
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

    const area = resolvePhiUserArea({
      authenticated: true,
      roleClaims: siteRole.roleClaims,
      accountFlags: user.flags,
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
    const preferredLocale = resolveSignedInLocale(request, {
      user,
      defaultLocale: runtimeConfig?.defaultLocale ?? site.defaultLocale,
      availableLocales: runtimeConfig?.availableLocales.map((option) => option.code) ?? [site.defaultLocale],
    });
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
      },
    });

    setSessionCookie(response, session.id, session.secret, session.expiresAt);
    setCsrfCookie(response, csrfToken);
    if (complete) {
      setAreaCookie(response, area, session.expiresAt);
    } else {
      clearAreaCookie(response);
    }
    setLocaleCookie(response, preferredLocale, session.expiresAt);
    // Signing in on a browser this account has not used before is exactly when the mirror earns its
    // keep, and withdrawing the choice has to clear a cookie that browser may already carry.
    setThemeModeCookie(response, resolveUserThemeModeName(user.flags), session.expiresAt);
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
    // The real cause stays in the log. Its message can name a table, a constraint or a host, and none
    // of that belongs in an answer to whoever is trying to sign in.
    return NextResponse.json({ error: "Login failed." }, { status: 500 });
  }
}
