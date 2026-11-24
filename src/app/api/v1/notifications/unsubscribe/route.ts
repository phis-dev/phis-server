import { NextResponse, type NextRequest } from "next/server";

import {
  hasPhiNotificationOptOut,
  readPhiNotificationLinkSalt,
  recordPhiNotificationOptOut,
  touchPhiNotificationLinkSalt,
} from "@/db/notifications";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import {
  readPhiUnsubscribeTokenSubject,
  verifyPhiUnsubscribeToken,
} from "@/lib/notifications/links";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Leaving a Site's circulars, from a link in one of them.
 *
 * Two methods, and the split is the whole point. Mail clients and security scanners fetch the links in a
 * message before a person has seen them, so a `GET` that acted would unsubscribe people who never clicked.
 * `GET` therefore only reports what the link is and what pressing would do; `POST` does it.
 *
 * No session and no CSRF: whoever holds the link is who it was issued to, and the signature is what says
 * so. Nothing else is on offer here -- it records that one membership of one Site left one occasion
 * (`phis.notification_opt_outs`). Core holds no consent to clear: the Add-on that sends the occasion
 * does, and learns of the opt-out from Core (design/NOTIFICATIONS.md section 9). The drain skips the
 * occasion for this person from then on.
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
      occasion: subject.occasion,
      signature: subject.signature,
    })
  ) {
    // A link whose membership is gone and a link that does not hold get the same answer: there is nothing
    // to tell apart, and neither is something the holder can act on.
    return { status: 422 as const, body: INVALID };
  }

  const optOut = { userId: subject.userId, siteId: site.id, ...subject.occasion };

  if (!act) {
    // Already out is friendlier to say than a success that would change nothing, and it is what a second
    // visit to the same link should say.
    return await hasPhiNotificationOptOut(optOut)
      ? { status: 200 as const, body: { outcome: "already" satisfies Outcome } }
      : { status: 200 as const, body: { outcome: "unsubscribed" satisfies Outcome, pending: true } };
  }

  const recorded = await recordPhiNotificationOptOut(optOut);
  await touchPhiNotificationLinkSalt(subject.userId, site.id);
  if (!recorded) {
    return { status: 200 as const, body: { outcome: "already" satisfies Outcome } };
  }

  logRuntimeEvent("info", "mail.unsubscribed", {
    message: "A circular's recipient unsubscribed.",
    siteKey: site.key,
    userId: subject.userId,
    meta: { providerId: subject.occasion.providerId, occasion: subject.occasion.occasion },
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
