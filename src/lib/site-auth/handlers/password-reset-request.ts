import { after, NextRequest, NextResponse } from "next/server";

import { createUserPasswordResetToken } from "@/db/user-password-reset-tokens";
import { getUserAccountByEmail } from "@/db/user-accounts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { buildPasswordResetUrlForLocale } from "@/lib/email";
import { notifyPhiPerson } from "@/lib/notifications/enqueue";
import { getSiteMailConfig } from "@/lib/form-config";
import { normalizeLocale } from "@/lib/locale";
import { logRuntimeEvent } from "@/lib/log";
import { requireCsrfCheckedSite } from "@/lib/site-auth/authenticated-site-user";
import { checkAuthAttemptLimit, tooManyAttemptsResponse } from "@/lib/site-auth/attempt-limit";
import {
  isSitePasswordMethodEnabled,
  PASSWORD_METHOD_DISABLED_RESPONSE,
} from "@/lib/site-auth/password-method";
import { isUserAccountEnabled } from "@/lib/user-flags";
import { normalizeString } from "@/lib/helpers/request";
import { isPhiEmailAddress, normalizePhiEmail } from "@/lib/helpers/normalize";

type RequestPayload = {
  email?: unknown;
  locale?: unknown;
};

export async function POST(request: NextRequest) {
  // The same token every other `/api/v1/auth` write asks for. Without it a cross-site `text/plain`
  // POST -- no preflight -- could have reset mail sent in a visitor's name; the relay in phis-ui
  // fetches the token first, as it does for the link confirmation.
  const checked = await requireCsrfCheckedSite(request);
  if (!checked.ok) {
    return checked.response;
  }
  const { site } = checked;
  if (!await isSitePasswordMethodEnabled(site.id)) {
    return NextResponse.json(PASSWORD_METHOD_DISABLED_RESPONSE, { status: 403 });
  }

  let payload: RequestPayload = {};
  try {
    payload = (await request.json()) as RequestPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const email = normalizePhiEmail(normalizeString(payload.email));
  const locale = normalizeLocale(normalizeString(payload.locale) || site.defaultLocale);

  // Always return success for unknown/invalid input to avoid account enumeration.
  if (!email || !isPhiEmailAddress(email)) {
    return NextResponse.json({});
  }
  // A reset mail per request is a mailbox somebody else can fill; ten a minute per address is enough
  // for anybody who is really waiting for one.
  const retryAfter = await checkAuthAttemptLimit(request, [`reset:${site.id}:${email}`]);
  if (retryAfter !== null) {
    return tooManyAttemptsResponse(retryAfter);
  }

  // Whether there is an account to reset is decided after the answer is out. Looking it up, issuing the
  // token and queueing the mail take time only when the account exists, so doing them before answering
  // would tell anybody with a stopwatch which addresses have one.
  after(async () => {
    try {
      await issuePasswordReset({ site, email, locale });
    } catch (error) {
      logRuntimeEvent("error", "auth.password.reset.request_failed", {
        message: "Password reset could not be issued.",
        siteKey: site.key,
        error,
      });
    }
  });

  return NextResponse.json({});
}

async function issuePasswordReset({
  site,
  email,
  locale,
}: {
  site: { id: number; key: string };
  email: string;
  locale: string;
}) {
  const user = await getUserAccountByEmail(email, site.id);
  if (!user || !user.siteIds.includes(site.id) || !user.passwordHash) {
    return;
  }
  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!isUserAccountEnabled(user.flags) || !siteRole.enabled) {
    return;
  }

  const resetToken = await createUserPasswordResetToken({
    userId: user.id,
    siteId: site.id,
  });

  const siteConfig = await getSiteMailConfig(site.id);
  const resetUrl = buildPasswordResetUrlForLocale(
    siteConfig.publicBaseUrl,
    resetToken.token,
    locale,
  );
  // The address and the name are not passed: the outbox resolves both when it sends, so a corrected
  // address is used and the greeting comes from one place. The locale is, because it is the one this
  // request was made in, and the link above was built with it.
  const notificationId = await notifyPhiPerson({
    siteId: site.id,
    occasion: "password_reset",
    recipient: { userId: user.id, locale },
    params: { verificationUrl: resetUrl },
  });

  logRuntimeEvent("info", "auth.password.reset.requested", {
    message: "Password reset email queued.",
    siteKey: site.key,
    userId: user.id,
    meta: { notificationId },
  });
}
