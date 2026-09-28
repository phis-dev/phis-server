import { NextResponse } from "next/server";

import {
  claimRegistrationIntent,
  consumeRegistrationIntent,
  releaseRegistrationIntentClaim,
  getRegistrationIntentByVerificationToken,
  markRegistrationIntentExpired,
  REGISTRATION_INTENT_STATUS_CONSUMED,
  REGISTRATION_INTENT_STATUS_PENDING,
  REGISTRATION_INTENT_STATUS_VERIFIED,
} from "@/db/registration-intents";
import { ensureUserAccount, getUserAccountById, getUserAccountByEmail, updateUserAccountProfileFields } from "@/db/user-accounts";
import { upsertUserSiteMembership } from "@/db/user-site-memberships";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { sendTemplatedEmail } from "@/lib/email-templates";
import { getSiteMailConfig } from "@/lib/form-config";
import { createMedusaCustomer } from "@/lib/medusa";
import { logRuntimeEvent } from "@/lib/log";
import { hashPassword } from "@/lib/password";
import { decryptRegistrationPassword } from "@/lib/registration-secret";
import { requireSiteFromRequest } from "@/lib/site-context";
import { USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

import { PhiUserEmailSource } from "@phis/contracts/access";

type ConfirmPayload = {
  token?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isIsoDateInPast(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function formatCustomerNumber(prefix: string, id: number) {
  return `${prefix}-${String(id).padStart(7, "0")}`;
}

function buildRecipientName(firstName: string, lastName: string) {
  return [firstName.trim(), lastName.trim()].filter(Boolean).join(" ").trim();
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

  let payload: ConfirmPayload = {};
  try {
    payload = (await request.json()) as ConfirmPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const token = normalize(payload.token);
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return NextResponse.json({ error: "Invalid verification token." }, { status: 400 });
  }

  const intent = await getRegistrationIntentByVerificationToken(site.id, token);
  if (!intent) {
    logRuntimeEvent("warn", "registration.confirm_failed", {
      message: "Registration confirm failed.",
      siteKey: site.key,
      meta: {
        reason: "invalid_token",
      },
    });
    return NextResponse.json(
      { ok: false, code: "invalid_token", error: "The verification link is invalid." },
      { status: 404 },
    );
  }

  if (
    intent.status === REGISTRATION_INTENT_STATUS_CONSUMED ||
    intent.status === REGISTRATION_INTENT_STATUS_VERIFIED
  ) {
    logRuntimeEvent("info", "registration.confirmed", {
      message: "Registration already confirmed.",
      siteKey: site.key,
      meta: {
        intentId: intent.id,
        email: intent.email,
        status: "already_confirmed",
      },
    });
    return NextResponse.json({ ok: true, status: "already_confirmed" });
  }

  if (intent.status !== REGISTRATION_INTENT_STATUS_PENDING) {
    logRuntimeEvent("warn", "registration.confirm_failed", {
      message: "Registration confirm failed.",
      siteKey: site.key,
      meta: {
        intentId: intent.id,
        email: intent.email,
        reason: "invalid_state",
        status: intent.status,
      },
    });
    return NextResponse.json(
      { ok: false, code: "invalid_state", error: "This verification link can no longer be used." },
      { status: 409 },
    );
  }

  if (isIsoDateInPast(intent.verificationTokenExpiresAt)) {
    await markRegistrationIntentExpired(intent.id);
    logRuntimeEvent("warn", "registration.confirm_failed", {
      message: "Registration confirm failed.",
      siteKey: site.key,
      meta: {
        intentId: intent.id,
        email: intent.email,
        reason: "expired",
      },
    });
    return NextResponse.json(
      { ok: false, code: "expired", error: "This verification link has expired." },
      { status: 410 },
    );
  }

  if (!await claimRegistrationIntent(intent.id)) {
    // Another confirmation of the same link got here first.
    return NextResponse.json({ ok: true, status: "already_confirmed" });
  }

  try {
    const siteConfig = await getSiteMailConfig(site.id);
    const usesMedusaCustomer = Boolean(siteConfig.medusaBaseUrl && siteConfig.medusaPublishableKey);
    const customerNumberPrefix = siteConfig.customerNumberPrefix?.trim().toUpperCase() ?? "";
    const normalizedEmail = intent.email?.trim() ?? "";
    if (!normalizedEmail) {
      return NextResponse.json(
        { ok: false, code: "invalid_state", error: "This verification link can no longer be used." },
        { status: 409 },
      );
    }

    if (intent.userId) {
      const existingAccount = await getUserAccountById(intent.userId);
      if (!existingAccount || !existingAccount.siteIds.includes(site.id)) {
        return NextResponse.json(
          { ok: false, code: "invalid_state", error: "This verification link can no longer be used." },
          { status: 409 },
        );
      }

      const conflictingAccount = await getUserAccountByEmail(normalizedEmail);
      if (conflictingAccount && conflictingAccount.id !== existingAccount.id) {
        return NextResponse.json(
          { ok: false, code: "invalid_state", error: "This email address is already in use." },
          { status: 409 },
        );
      }

      await updateUserAccountProfileFields(existingAccount.id, {
        email: normalizedEmail,
        emailSource: PhiUserEmailSource.Self,
      });
      await consumeRegistrationIntent(intent.id, existingAccount.id);
      logRuntimeEvent("info", "auth.profile.email.confirmed", {
        message: "Profile email change confirmed.",
        siteKey: site.key,
        userId: existingAccount.id,
        meta: {
          intentId: intent.id,
          email: normalizedEmail,
          status: "confirmed",
          kind: "email_change",
        },
      });

      return NextResponse.json({
        ok: true,
        status: "confirmed",
        email: normalizedEmail,
      });
    }

    if (!intent.passwordCiphertext || !intent.passwordIv || !intent.passwordAuthTag) {
      return NextResponse.json(
        { ok: false, code: "invalid_state", error: "This verification link can no longer be used." },
        { status: 409 },
      );
    }

    const password = decryptRegistrationPassword({
      ciphertextHex: intent.passwordCiphertext,
      ivHex: intent.passwordIv,
      authTagHex: intent.passwordAuthTag,
    });
    const passwordHash = await hashPassword(password);

    let medusaCustomerId: string | null = null;
    let medusaCustomerEmail: string | null = null;
    let medusaCustomerFirstName: string | null = null;
    let medusaCustomerLastName: string | null = null;
    const shouldCreateMedusaCustomer =
      Boolean(siteConfig.medusaBaseUrl && siteConfig.medusaPublishableKey);
    if (shouldCreateMedusaCustomer) {
      try {
        const customer = await createMedusaCustomer(siteConfig, {
          email: normalizedEmail,
          password,
          firstName: intent.firstName ?? "",
          lastName: intent.lastName ?? "",
          companyName: intent.companyName ?? "",
        });

        medusaCustomerId = customer.id;
        medusaCustomerEmail = customer.email;
        medusaCustomerFirstName = customer.firstName;
        medusaCustomerLastName = customer.lastName;
        logRuntimeEvent("info", "registration.profile_source", {
          message: "Registration profile resolved from Medusa.",
          siteKey: site.key,
          meta: {
            intentId: intent.id,
            email: normalizedEmail,
            userId: null,
            persistSource: "medusa",
            medusaCustomerId: customer.id,
          },
        });
      } catch (error) {
        logRuntimeEvent("error", "registration.medusa_create_failed", {
          message: "Registration Medusa customer creation failed.",
          siteKey: site.key,
          meta: {
            intentId: intent.id,
            email: intent.email,
            reason: "medusa_create_customer_failed",
          },
          error,
        });
      }
    }

    const user = await ensureUserAccount({
      email: normalizedEmail,
      siteId: site.id,
      emailSource: PhiUserEmailSource.Registration,
      medusaCustomerId,
      passwordHash,
      /*
       * Not `intent.locale`, although that is the language this person registered in.
       *
       * `preferred_locale` is the answer to "which language do you want", and its absence is how the
       * rest of the system knows nobody has answered yet: then the cookie the language switch wrote, and
       * the browser's own preference, decide -- which for this person is the very language they
       * registered in, reached without writing anything down. The intent keeps its locale, because the
       * confirmation mail has to be written in some language and nobody is signed in to ask.
       */
      preferredLocale: null,
      flags: 0,
    });
    await upsertUserSiteMembership({
      userId: user.id,
      siteId: site.id,
      userSiteFlags: intent.newsletterOptIn ? USER_SITE_FLAG_NEWSLETTER_OPT_IN : 0,
    });
    if (!usesMedusaCustomer) {
      await upsertUserProfile({
        userId: user.id,
        firstName: intent.firstName ?? "",
        lastName: intent.lastName ?? "",
        companyName: intent.companyName ?? null,
      });
      logRuntimeEvent("info", "registration.profile_upserted", {
        message: "Registration profile persisted locally.",
        siteKey: site.key,
        userId: user.id,
        meta: {
          intentId: intent.id,
          email: normalizedEmail,
          persistSource: "user_profiles",
        },
      });
    } else {
      logRuntimeEvent("info", "registration.profile_source", {
        message: "Registration profile resolved from Medusa.",
        siteKey: site.key,
        userId: user.id,
        meta: {
          intentId: intent.id,
          email: normalizedEmail,
          persistSource: "medusa",
          medusaCustomerId,
        },
      });
    }
    const customerNumber = customerNumberPrefix
      ? formatCustomerNumber(customerNumberPrefix, user.id)
      : null;
    const profile = await getUserProfileByUserId(user.id);
    const profileRecipientName = profile
      ? buildRecipientName(profile.firstName, profile.lastName)
      : "";
    const medusaRecipientName = buildRecipientName(
      medusaCustomerFirstName ?? "",
      medusaCustomerLastName ?? "",
    );
    const recipientName = usesMedusaCustomer
      ? medusaRecipientName || intent.fullName || normalizedEmail
      : profileRecipientName || intent.fullName || normalizedEmail;

    await consumeRegistrationIntent(intent.id, user.id);
    logRuntimeEvent("info", "registration.confirmed", {
      message: "Registration confirmed.",
      siteKey: site.key,
      userId: user.id,
      meta: {
        intentId: intent.id,
        email: intent.email,
        customerId: medusaCustomerId,
        customerNumber,
        status: "confirmed",
      },
    });

    try {
      const messageId = await sendTemplatedEmail({
        to: normalizedEmail,
        site,
        siteConfig,
        locale: intent.locale,
        template: "registration_welcome",
        recipientName,
      });

      logRuntimeEvent("info", "mail.sent", {
        message: "Registration welcome email sent.",
        siteKey: site.key,
        userId: user.id,
        meta: {
          intentId: intent.id,
          email: intent.email,
          messageId,
          template: "registration_welcome",
        },
      });
    } catch (error) {
      logRuntimeEvent("error", "mail.failed", {
        message: "Registration welcome email failed.",
        siteKey: site.key,
        userId: user.id,
        meta: {
          intentId: intent.id,
          email: intent.email,
          template: "registration_welcome",
        },
        error,
      });
    }

    return NextResponse.json({
      ok: true,
      status: "confirmed",
      customerId: medusaCustomerId,
      email: medusaCustomerEmail ?? normalizedEmail,
      customerNumber,
    });
  } finally {
    // A no-op once the intent is consumed; otherwise the link works again, as it did before the claim.
    await releaseRegistrationIntentClaim(intent.id);
  }
}
