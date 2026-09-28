import { NextRequest, NextResponse } from "next/server";

import { createRegistrationIntent } from "@/db/registration-intents";
import { getSiteRuntimeConfig } from "@/db/sites";
import { getUserAccountById, getUserAccountByEmail } from "@/db/user-accounts";
import { getUserProfileByUserId } from "@/db/user-profiles";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { resolveSignedInLocale, verifyCsrfRequest } from "@/lib/auth";
import { buildVerificationUrlForRequest } from "@/lib/email";
import { sendTemplatedEmail } from "@/lib/email-templates";
import { getSiteMailConfig } from "@/lib/form-config";
import { logRuntimeEvent } from "@/lib/log";
import { verifyPasswordHash } from "@/lib/password";
import { requireSiteFromRequest } from "@/lib/site-context";

type ProfileEmailRequestPayload = {
  email?: unknown;
  currentPassword?: unknown;
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

  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  const session = await getSessionFromRequest(request, site.id);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await getUserAccountById(session.userId);
  if (!user || !user.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!siteRole.enabled) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: ProfileEmailRequestPayload = {};
  try {
    payload = (await request.json()) as ProfileEmailRequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = normalize(payload.email).toLowerCase();
  const currentPassword = normalize(payload.currentPassword);
  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  }

  if (!currentPassword) {
    return NextResponse.json({ error: "Missing current password." }, { status: 400 });
  }

  if (!user.passwordHash) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const validPassword = await verifyPasswordHash(user.passwordHash, currentPassword);
  if (!validPassword) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  if (email === user.emailNormalized) {
    return NextResponse.json({
      status: "unchanged",
      email,
    });
  }

  const conflictingAccount = await getUserAccountByEmail(email);
  if (conflictingAccount && conflictingAccount.id !== user.id) {
    return NextResponse.json(
      { error: "This email address is already in use." },
      { status: 409 },
    );
  }

  const runtimeConfig = await getSiteRuntimeConfig(site.id);
  const intent = await createRegistrationIntent({
    siteId: site.id,
    userId: user.id,
    email,
    /*
     * The language this request was made in, which for somebody who has saved one is that, and otherwise
     * the language their browser is reading. It used to be `preferred_locale` or the Site default, and
     * now that the column is empty until somebody answers, that would have sent a German reader a
     * confirmation mail in English while they sat on the German page that asked for it.
     */
    locale: resolveSignedInLocale(request, {
      user,
      defaultLocale: runtimeConfig?.defaultLocale ?? site.defaultLocale,
      availableLocales: runtimeConfig?.availableLocales.map((option) => option.code)
        ?? [site.defaultLocale],
    }),
    newsletterOptIn: false,
  });

  const siteMailConfig = await getSiteMailConfig(site.id);
  const verificationUrl = buildVerificationUrlForRequest(
    request.headers,
    siteMailConfig.publicBaseUrl,
    intent.verificationToken,
    intent.locale,
  );

  const profile = await getUserProfileByUserId(user.id);
  const recipientName =
    (profile ? buildRecipientName(profile.firstName, profile.lastName) : "") || user.emailNormalized;

  const messageId = await sendTemplatedEmail({
    to: intent.email,
    site,
    siteConfig: siteMailConfig,
    locale: intent.locale,
    template: "registration_verify",
    recipientName,
    verificationUrl,
  });

  logRuntimeEvent("info", "auth.profile.email.change_requested", {
    message: "Profile email verification sent.",
    siteKey: site.key,
    userId: user.id,
    meta: {
      intentId: intent.id,
      email: intent.email,
      messageId,
    },
  });

  return NextResponse.json({
    status: "verification_sent",
    email: intent.email,
  });
}
