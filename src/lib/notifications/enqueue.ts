import "server-only";

import {
  enqueuePhiNotification,
  PHI_NOTIFICATION_FLAG_SENT,
  type PhiNotificationRecipient,
} from "@/db/notifications";
import { getUserSiteMembership } from "@/db/user-site-memberships";
import { hasUserSiteFlag, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

import { attemptPhiNotificationNow, type PhiNotificationOccasion } from "./deliver";

/**
 * The one way anything in Core sends a message to a person.
 *
 * Nothing calls `sendTemplatedEmail` directly any more, and that is the point: a message that is written
 * down before it is sent gets a retry, a record, and one place where consent is checked. The row is the
 * receipt -- what happens to it afterwards is the drain's business.
 *
 * `immediate` is what keeps a confirmation mail as fast as it was. The request that wrote the row tries it
 * once itself and waits for that attempt, exactly as it waited for SMTP before; what is new is that a
 * failure is now a row that stays due instead of a message nobody will ever send again. A bulk run passes
 * `false`, because five hundred attempts inside one request is the timeout this design exists to avoid.
 *
 * Answers the row's id, or `null` when nothing was written -- a `dedupeKey` that was already used, or a
 * sent-class message to somebody who has not consented. Neither is an error, and neither leaves a trace:
 * a circular that was never owed is not a dropped row, it is nothing at all.
 */
export async function notifyPhiPerson(input: {
  siteId: number;
  occasion: PhiNotificationOccasion;
  recipient: PhiNotificationRecipient;
  params?: Record<string, unknown>;
  dedupeKey?: string | null;
  /** True for a message somebody decided to send; false for one the person's own action asked for. */
  sent?: boolean;
  immediate?: boolean;
}) {
  const isSentClass = input.sent === true;

  if (isSentClass) {
    if (!("userId" in input.recipient)) {
      // A circular owes a way out, and a way out needs a membership whose flag it can clear. Refusing
      // here rather than at the drain keeps the impossible case out of the table entirely.
      throw new Error("A sent-class notification needs an account, not a bare address.");
    }

    const membership = await getUserSiteMembership(input.recipient.userId, input.siteId);
    if (
      !membership ||
      !membership.enabled ||
      !hasUserSiteFlag(membership.siteFlags, USER_SITE_FLAG_NEWSLETTER_OPT_IN)
    ) {
      return null;
    }
  }

  const id = await enqueuePhiNotification({
    siteId: input.siteId,
    occasion: input.occasion,
    recipient: input.recipient,
    flags: isSentClass ? PHI_NOTIFICATION_FLAG_SENT : 0,
    params: input.params,
    dedupeKey: input.dedupeKey,
  });

  if (id && input.immediate !== false) {
    await attemptPhiNotificationNow(id);
  }

  return id;
}
