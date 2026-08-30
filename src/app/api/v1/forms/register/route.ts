import { NextResponse } from "next/server";

import { createRegistrationIntent } from "@/db/registration-intents";
import { ensureUserAccount, getUserAccountByEmail } from "@/db/user-accounts";
import { getSiteAuthPolicy } from "@/db/site-auth";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { upsertUserSiteMembership } from "@/db/user-site-memberships";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { buildVerificationUrlForRequest } from "@/lib/email";
import { sendTemplatedEmail } from "@/lib/email-templates";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { logRuntimeEvent } from "@/lib/log";
import { requireSiteFromRequest } from "@/lib/site-context";
import { getFormGuardSecret, getFormTimingWindow, getSiteMailConfig } from "@/lib/form-config";
import { logFormAbuse } from "@/lib/form-abuse-log";
import { verifyFormGuard } from "@/lib/form-guard";
import { verifyPasswordHash } from "@/lib/password";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

type RegistrationPayload = {
  firstName?: unknown;
  lastName?: unknown;
  company?: unknown;
  email?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
  termsAccepted?: unknown;
  newsletter?: unknown;
  locale?: unknown;
  website?: unknown;
  issuedAt?: unknown;
  formToken?: unknown;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function countLetters(value: string) {
  return value.match(/\p{L}/gu)?.length ?? 0;
}

export async function POST(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  let payload: RegistrationPayload = {};
  try {
    payload = (await request.json()) as RegistrationPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const firstName = normalize(payload.firstName);
  const lastName = normalize(payload.lastName);
  const company = normalize(payload.company);
  const email = normalize(payload.email);
  const password = normalize(payload.password);
  const confirmPassword = normalize(payload.confirmPassword);
  const locale = normalize(payload.locale) || site.defaultLocale;
  const website = normalize(payload.website);
  const issuedAt = normalize(payload.issuedAt);
  const formToken = normalize(payload.formToken);
  const termsAccepted = payload.termsAccepted === true;
  const newsletter = payload.newsletter === true;
  const registrationSiteConfig = await getSiteConfigBySiteId(site.id);
  const usesMedusaCustomer = Boolean(
    registrationSiteConfig?.medusaBaseUrl && registrationSiteConfig.medusaPublishableKey,
  );

  const guardResult = verifyFormGuard({
    form: "@phis/ui/modules/auth/forms/registration",
    siteKey: site.key,
    secret: await getFormGuardSecret(site.id),
    honeypotValue: website,
    issuedAt,
    formToken,
    ...getFormTimingWindow("registration"),
  });

  if (!guardResult.ok) {
    logFormAbuse(request, "@phis/ui/modules/auth/forms/registration", guardResult.reason, {
      ageMs: guardResult.ageMs ?? null,
      field: guardResult.reason === "honeypot" ? "website" : null,
      siteKey: site.key,
    });

    if (guardResult.reason === "expired") {
      return NextResponse.json(
        { error: "The form expired. Please reload the page and try again.", code: "form_expired" },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true });
  }

  if (!firstName || !lastName || !email || !password || !confirmPassword) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
  }

  if (countLetters(firstName) < 3) {
    return NextResponse.json(
      { error: "First name must contain at least 3 letters." },
      { status: 400 },
    );
  }

  if (countLetters(lastName) < 3) {
    return NextResponse.json(
      { error: "Last name must contain at least 3 letters." },
      { status: 400 },
    );
  }

  if (password.length < 10) {
    return NextResponse.json({ error: "Password is too short." }, { status: 400 });
  }

  if (password !== confirmPassword) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 });
  }

  if (!termsAccepted) {
    return NextResponse.json({ error: "Terms must be accepted." }, { status: 400 });
  }

  const authPolicy = await getSiteAuthPolicy(site.id);
  if (authPolicy?.registrationMode !== "automatic") {
    return NextResponse.json(
      { error: "Registration is not available.", code: "registration_disabled" },
      { status: 403 },
    );
  }
  const existingUser = await getUserAccountByEmail(email);

  if (existingUser && !existingUser.siteIds.includes(site.id)) {
    if (authPolicy.existingAccountLinking === "disabled") {
      return NextResponse.json(
        { error: "Account linking is not available.", code: "linking_disabled" },
        { status: 409 },
      );
    }
    if (!existingUser.passwordHash) {
      return NextResponse.json(
        { error: "Account already exists.", code: "account_exists" },
        { status: 409 },
      );
    }

    const validPassword = await verifyPasswordHash(existingUser.passwordHash, password);
    if (!validPassword) {
      return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
    }

    const user = await ensureUserAccount({
      email: existingUser.emailNormalized,
      siteId: site.id,
      medusaCustomerId: existingUser.medusaCustomerId,
      passwordHash: null,
      preferredLocale: locale,
      flags: 0,
      reuseExisting: true,
    });

    const existingProfile = await getUserProfileByUserId(user.id);
    if (!usesMedusaCustomer && !existingProfile) {
      await upsertUserProfile({
        userId: user.id,
        firstName,
        lastName,
        companyName: company || null,
      });
      logRuntimeEvent("info", "registration.profile_upserted", {
        message: "Registration profile persisted locally.",
        siteKey: site.key,
        userId: user.id,
        meta: {
          email: existingUser.emailNormalized,
          persistSource: "user_profiles",
        },
      });
    }

    if (newsletter) {
      await upsertUserSiteMembership({
        userId: user.id,
        siteId: site.id,
        userSiteFlags: USER_SITE_FLAG_NEWSLETTER_OPT_IN,
      });
    }

    return NextResponse.json({
      ok: true,
      status: "confirmed",
      linkedExistingAccount: true,
      email: existingUser.emailNormalized,
    });
  }

  let intent;
  try {
    intent = await createRegistrationIntent({
    siteId: site.id,
    email,
    firstName,
    lastName,
    companyName: company || null,
    password,
    locale,
      newsletterOptIn: newsletter,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_EXISTS") {
      return NextResponse.json(
        { error: "Account already exists.", code: "account_exists" },
        { status: 409 },
      );
    }
    throw error;
  }

  logRuntimeEvent("info", "registration.intent.created", {
    message: "Registration intent created.",
    siteKey: site.key,
    meta: {
      intentId: intent.id,
      email: intent.email,
      firstName: intent.firstName,
      lastName: intent.lastName,
      locale: intent.locale,
      company: company || null,
      newsletter,
    },
  });

  const siteMailConfig = await getSiteMailConfig(site.id);
  const verificationUrl = buildVerificationUrlForRequest(
    request.headers,
    siteMailConfig.publicBaseUrl,
    intent.verificationToken,
    intent.locale,
  );

  const messageId = await sendTemplatedEmail({
    to: intent.email,
    site,
    siteConfig: siteMailConfig,
    locale: intent.locale,
    template: "registration_verify",
    recipientName: intent.fullName || intent.email,
    verificationUrl,
  });

  logRuntimeEvent("info", "mail.sent", {
    message: "Registration verification email sent.",
    siteKey: site.key,
    meta: {
      intentId: intent.id,
      email: intent.email,
      messageId,
      template: "registration_verify",
    },
  });

  return NextResponse.json({ ok: true, intentId: intent.id });
}
