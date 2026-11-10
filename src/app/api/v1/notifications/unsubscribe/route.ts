import { NextResponse, type NextRequest } from "next/server";

import {
  readPhiNotificationLinkSalt,
  touchPhiNotificationLinkSalt,
} from "@/db/notifications";
import { changeUserSiteFlags, getUserSiteMembership } from "@/db/user-site-memberships";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import {
  readPhiUnsubscribeTokenSubject,
  verifyPhiUnsubscribeToken,
} from "@/lib/notifications/links";
import { requireSiteFromRequest } from "@/lib/site-context";
import { hasUserSiteFlag, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

export const dynamic = "force-dynamic";

/**
 * Leaving a Site's circulars, from a link in one of them.
 *
 * Two methods, and the split is the whole point. Mail clients and security scanners fetch the links in a
 * message before a person has seen them, so a `GET` that acted would unsubscribe people who never clicked.
 * `GET` therefore only reports what the link is and what pressing would do; `POST` does it.
 *
 * No session and no CSRF: whoever holds the link is who it was issued to, and the signature is what says
 * so. Nothing else is on offer here -- it clears one flag on one membership of one Site.
 */

type Outcome = "unsubscribed" | "already" | "invalid";

/*
 * A link that does not hold is answered as a failure, not as a quiet outcome with a 200.
 *
 * The page that shows this is a Form, and a Form reads the status: answering "invalid" with 200 would have
 * it report success and tell somebody they had been unsubscribed when nothing happened.
 */
const INVALID = {
  error: "This unsubscribe link is not valid. It may have been replaced by a newer one.",
  outcome: "invalid" satisfies Outcome,
} as const;

async function resolveOutcome(request: NextRequest, token: string, act: boolean) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return { status: 404 as const, body: { error: "Site not found." } };
  }

  const subject = token ? readPhiUnsubscribeTokenSubject(token) : null;
  if (!subject) {
    return { status: 422 as const, body: INVALID };
  }

  const salt = await readPhiNotificationLinkSalt(subject.userId, site.id);
  if (
    !salt ||
    !verifyPhiUnsubscribeToken({
      siteId: site.id,
      userId: subject.userId,
      salt,
      signature: subject.signature,
    })
  ) {
    // A link whose membership is gone and a link that does not hold get the same answer: there is nothing
    // to tell apart, and neither is something the holder can act on.
    return { status: 422 as const, body: INVALID };
  }

  const membership = await getUserSiteMembership(subject.userId, site.id);
  if (!membership) {
    return { status: 422 as const, body: INVALID };
  }

  if (!hasUserSiteFlag(membership.siteFlags, USER_SITE_FLAG_NEWSLETTER_OPT_IN)) {
    // Already out. Saying so is friendlier than reporting a success that changed nothing, and it is what a
    // second press of the same button should say.
    return { status: 200 as const, body: { outcome: "already" satisfies Outcome } };
  }

  if (!act) {
    return { status: 200 as const, body: { outcome: "unsubscribed" satisfies Outcome, pending: true } };
  }

  const updated = await changeUserSiteFlags(subject.userId, site.id, {
    clear: USER_SITE_FLAG_NEWSLETTER_OPT_IN,
  });
  if (!updated) {
    return { status: 500 as const, body: { error: "The preference could not be changed." } };
  }

  await touchPhiNotificationLinkSalt(subject.userId, site.id);
  logRuntimeEvent("info", "mail.unsubscribed", {
    message: "A circular's recipient unsubscribed.",
    siteKey: site.key,
    userId: subject.userId,
  });

  return { status: 200 as const, body: { outcome: "unsubscribed" satisfies Outcome } };
}

/** What the link is, without doing anything about it, so a page can be drawn from it. */
export async function GET(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const { status, body } = await resolveOutcome(request, token, false);
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const payload = await request.json().catch(() => null) as { token?: unknown } | null;
  const fromQuery = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const token = typeof payload?.token === "string" ? payload.token.trim() : fromQuery;

  const { status, body } = await resolveOutcome(request, token, true);
  return NextResponse.json(body, { status });
}
