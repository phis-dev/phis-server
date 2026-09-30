import { NextRequest, NextResponse } from "next/server";

import {
  createCsrfToken,
  setAreaCookie,
  setCsrfCookie,
  verifyCsrfRequest,
} from "@/lib/auth";
import { isBootstrapEnabled } from "@/lib/config";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";
import {
  buildOperatorSessionExpiresAt,
  setOperatorSessionCookie,
} from "@/lib/operator-auth";
import { verifyPasswordHash } from "@/lib/password";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { warmTranslationLocaleSourceOptions } from "@/lib/translation-locale-options";
import { normalizeString } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

type OperatorLoginPayload = {
  email?: unknown;
  password?: unknown;
};

export async function POST(request: NextRequest) {
  if (isBootstrapEnabled()) {
    logRuntimeEvent("warn", "operator.login.blocked", {
      message: "Operator login rejected because bootstrap is still active.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        reason: "bootstrap_active",
      },
    });
    return NextResponse.json(
      { error: "Bootstrap is still active. Operator login is not available yet." },
      { status: 423 },
    );
  }

  if (!verifyCsrfRequest(request)) {
    logRuntimeEvent("warn", "operator.login.csrf_failed", {
      message: "Operator login rejected because CSRF validation failed.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  let payload: OperatorLoginPayload = {};
  try {
    payload = (await request.json()) as OperatorLoginPayload;
  } catch {
    logRuntimeEvent("warn", "operator.login.invalid_payload", {
      message: "Operator login rejected because the payload is invalid.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
    });
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = normalizeString(payload.email).toLowerCase();
  const password = normalizeString(payload.password);

  if (!email || !password) {
    logRuntimeEvent("warn", "operator.login.failed", {
      message: "Operator login failed.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email: email || null,
        reason: "missing_email_or_password",
      },
    });
    return NextResponse.json({ error: "Missing email or password." }, { status: 400 });
  }

  const runtimeConfig = readPhiRuntimeConfigSync();
  const operator = (runtimeConfig.platformSuperUsers ?? []).find(
    (entry) => entry.email.trim().toLowerCase() === email,
  );

  if (!operator || operator.enabled === false || !operator.passwordHash?.trim()) {
    logRuntimeEvent("warn", "operator.login.failed", {
      message: "Operator login failed.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email,
        reason: operator?.enabled === false ? "account_disabled" : "invalid_credentials",
      },
    });
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  try {
    const validPassword = await verifyPasswordHash(operator.passwordHash, password);
    if (!validPassword) {
      logRuntimeEvent("warn", "operator.login.failed", {
        message: "Operator login failed.",
        area: "operator",
        method: request.method,
        path: request.nextUrl.pathname,
        meta: {
          email: operator.email.trim().toLowerCase(),
          reason: "invalid_credentials",
        },
      });
      return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
    }

    const response = NextResponse.json({
      operator: {
        email: operator.email,
        displayName: operator.displayName?.trim() || operator.email,
      },
    });
    const expiresAt = buildOperatorSessionExpiresAt();
    const csrfToken = createCsrfToken();

    setOperatorSessionCookie(response, {
      email: operator.email,
      displayName: operator.displayName?.trim() || operator.email,
      expiresAt,
    });
    setCsrfCookie(response, csrfToken);
    setAreaCookie(response, "operator", expiresAt);
    await warmTranslationLocaleSourceOptions().catch(() => {});
    logRuntimeEvent("info", "operator.login.success", {
      message: "Operator login succeeded.",
      area: "operator",
      method: request.method,
      path: request.nextUrl.pathname,
      meta: {
        email: operator.email.trim().toLowerCase(),
        expiresAt: expiresAt.toISOString(),
      },
    });

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operator login failed.";
    logRuntimeEvent("error", "operator.login.failed", {
      message,
      area: "operator",
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
    return NextResponse.json({ error: "Operator login failed." }, { status: 500 });
  }
}
