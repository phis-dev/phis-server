import { NextResponse } from "next/server";

import { createRegistrationIntent } from "@/db/registration-intents";
import { ensureUserAccount, getUserAccountByEmail } from "@/db/user-accounts";
import { getSiteAuthPolicy } from "@/db/site-auth";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { upsertUserSiteMembership } from "@/db/user-site-memberships";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { buildVerificationUrlForLocale } from "@/lib/email";
import { notifyPhiPerson } from "@/lib/notifications/enqueue";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { normalizeLocale } from "@/lib/locale";
import { logRuntimeEvent } from "@/lib/log";
import { requireSiteFromRequest } from "@/lib/site-context";
import { getFormGuardSecret, getFormTimingWindow, getSiteMailConfig } from "@/lib/form-config";
import { logFormAbuse } from "@/lib/form-abuse-log";
import { verifyFormGuard } from "@/lib/form-guard";
import { verifyPasswordHash } from "@/lib/password";
import { checkAuthAttemptLimit } from "@/lib/site-auth/attempt-limit";
import { isSitePasswordMethodEnabled } from "@/lib/site-auth/password-method";
import { isUserAccountEnabled } from "@/lib/user-flags";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

import { PhiUserEmailSource } from "@phis/contracts/access";
import { normalizeString } from "@/lib/helpers/request";
import { isPhiEmailAddress } from "@/lib/helpers/normalize";

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

function countLetters(value: string) {
  return value.match(/\p{L}/gu)?.length ?? 0;
}

/** What every registration that is not an immediate link answers: look in your inbox. */
function REGISTRATION_ACCEPTED() {
  return NextResponse.json({ ok: true, status: "pending_verification" });
}

/**
 * Tells the owner of an address that somebody tried to register it. Held to a few a minute, so the
 * form cannot be turned into a way of filling somebody's inbox; the form answers the same either way.
 */
async function notifyExistingAccountOwner(
  request: Request,
  site: NonNullable<Awaited<ReturnType<typeof requireSiteFromRequest>>>,
  email: string,
  locale: string,
) {
  if (checkAuthAttemptLimit(request, [`register-notice:${site.id}:${email}`], 3) !== null) {
    return;
  }
  try {
    // Addressed rather than resolved on purpose: looking the account up here to get its id would make this
    // notice depend on the account existing in a way the form's own answer deliberately does not.
    await notifyPhiPerson({
      siteId: site.id,
      occasion: "registration_account_exists",
      recipient: { address: email, locale },
    });
  } catch (error) {
    logRuntimeEvent("error", "registration.account_exists_notice_failed", {
      message: "Account-exists notice could not be sent.",
      siteKey: site.key,
      error,
    });
  }
}

export async function POST(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  let payload: RegistrationPayload = {};
  try {
    payload = (await request.json()) as RegistrationPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const firstName = normalizeString(payload.firstName);
  const lastName = normalizeString(payload.lastName);
  const company = normalizeString(payload.company);
  const email = normalizeString(payload.email);
  const password = normalizeString(payload.password);
  const confirmPassword = normalizeString(payload.confirmPassword);
  const locale = normalizeLocale(normalizeString(payload.locale) || site.defaultLocale);
  const website = normalizeString(payload.website);
  const issuedAt = normalizeString(payload.issuedAt);
  const formToken = normalizeString(payload.formToken);
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

  if (!isPhiEmailAddress(email)) {
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

  /*
   * One answer for every address. It used to say which addresses have an account -- ok, 409 or 401 --
   * so the form was a lookup anyone could run. An address with an account now gets the answer a new
   * registration gets, and its owner a mail saying somebody tried; only the one case that proves the
   * account is theirs, its password, answers differently.
   */
  if (existingUser) {
    const mayLink =
      !existingUser.siteIds.includes(site.id) &&
      authPolicy.existingAccountLinking !== "disabled" &&
      Boolean(existingUser.passwordHash) &&
      await isSitePasswordMethodEnabled(site.id);
    // Linking verifies a password, so it is a place to guess at one: measured like the login, and a
    // guess past the limit is simply not believed.
    const withinLimit = mayLink &&
      checkAuthAttemptLimit(request, [`login:${site.id}:${email}`]) === null;
    const linked = withinLimit &&
      isUserAccountEnabled(existingUser.flags) &&
      await verifyPasswordHash(existingUser.passwordHash!, password);
    if (!linked) {
      await notifyExistingAccountOwner(request, site, existingUser.emailNormalized, locale);
      return REGISTRATION_ACCEPTED();
    }

    const user = await ensureUserAccount({
      email: existingUser.emailNormalized,
      siteId: site.id,
      emailSource: PhiUserEmailSource.Registration,
      medusaCustomerId: existingUser.medusaCustomerId,
      passwordHash: null,
      // Left unanswered here too, for the reason the confirm route states: `locale` is the language this
      // form was read in, and that reaches this person through the cookie without being stored as a
      // choice they never made.
      preferredLocale: null,
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
    // Registered between the lookup above and this write: the same answer as everywhere else.
    if (error instanceof Error && error.message === "ACCOUNT_EXISTS") {
      await notifyExistingAccountOwner(request, site, email, locale);
      return REGISTRATION_ACCEPTED();
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
  const verificationUrl = buildVerificationUrlForLocale(
    siteMailConfig.publicBaseUrl,
    intent.verificationToken,
    intent.locale,
  );

  // No account exists yet, so the address and the name travel with the row; the name is what was typed
  // into this form, which is the only place it is known.
  const notificationId = await notifyPhiPerson({
    siteId: site.id,
    occasion: "registration_verify",
    recipient: { address: intent.email, locale: intent.locale },
    params: { verificationUrl, recipientName: intent.fullName || intent.email },
  });

  logRuntimeEvent("info", "registration.verification_queued", {
    message: "Registration verification email queued.",
    siteKey: site.key,
    meta: { intentId: intent.id, notificationId },
  });

  return REGISTRATION_ACCEPTED();
}
