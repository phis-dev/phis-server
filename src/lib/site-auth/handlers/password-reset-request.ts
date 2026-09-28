import { NextRequest, NextResponse } from "next/server";

import { createUserPasswordResetToken } from "@/db/user-password-reset-tokens";
import { getUserAccountByEmail } from "@/db/user-accounts";
import { getUserProfileByUserId } from "@/db/user-profiles";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { buildPasswordResetUrlForRequest } from "@/lib/email";
import { sendTemplatedEmail } from "@/lib/email-templates";
import { verifyCsrfRequest } from "@/lib/auth";
import { getSiteMailConfig } from "@/lib/form-config";
import { normalizeLocale } from "@/lib/locale";
import { logRuntimeEvent } from "@/lib/log";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  isSitePasswordMethodEnabled,
  PASSWORD_METHOD_DISABLED_RESPONSE,
} from "@/lib/site-auth/password-method";
import { isUserAccountEnabled } from "@/lib/user-flags";

type RequestPayload = {
  email?: unknown;
  locale?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function buildRecipientName(firstName: string, lastName: string) {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ").trim();
}

export async function POST(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }
  // The same token every other `/api/v1/auth` write asks for. Without it a cross-site `text/plain`
  // POST -- no preflight -- could have reset mail sent in a visitor's name; the relay in phis-ui
  // fetches the token first, as it does for the link confirmation.
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  if (!await isSitePasswordMethodEnabled(site.id)) {
    return NextResponse.json(PASSWORD_METHOD_DISABLED_RESPONSE, { status: 403 });
  }

  let payload: RequestPayload = {};
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = normalize(payload.email).toLowerCase();
  const locale = normalizeLocale(normalize(payload.locale) || site.defaultLocale);

  // Always return success for unknown/invalid input to avoid account enumeration.
  if (!email || !isValidEmail(email)) {
    return NextResponse.json({});
  }

  const user = await getUserAccountByEmail(email, site.id);
  if (!user || !user.siteIds.includes(site.id) || !user.passwordHash) {
    return NextResponse.json({});
  }
  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!isUserAccountEnabled(user.flags) || !siteRole.enabled) {
    return NextResponse.json({});
  }

  const resetToken = await createUserPasswordResetToken({
    userId: user.id,
    siteId: site.id,
  });

  const siteConfig = await getSiteMailConfig(site.id);
  const resetUrl = buildPasswordResetUrlForRequest(
    request.headers,
    siteConfig.publicBaseUrl,
    resetToken.token,
    locale,
  );
  const profile = await getUserProfileByUserId(user.id);
  const recipientName =
    profile ? buildRecipientName(profile.firstName, profile.lastName) || user.emailNormalized : user.emailNormalized;

  try {
    const messageId = await sendTemplatedEmail({
      to: user.emailNormalized,
      site,
      siteConfig,
      locale,
      template: "password_reset",
      recipientName,
      verificationUrl: resetUrl,
    });

    logRuntimeEvent("info", "auth.password.reset.requested", {
      message: "Password reset email sent.",
      siteKey: site.key,
      userId: user.id,
      meta: {
        email: user.emailNormalized,
        messageId,
      },
    });
  } catch (error) {
    logRuntimeEvent("error", "auth.password.reset.request_failed", {
      message: "Password reset email failed.",
      siteKey: site.key,
      userId: user.id,
      meta: {
        email: user.emailNormalized,
      },
      error,
    });
  }

  return NextResponse.json({});
}
