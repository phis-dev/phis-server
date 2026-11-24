import "server-only";

import { enqueuePhiNotification, type PhiNotificationRecipient } from "@/db/notifications";

import { attemptPhiNotificationNow, type PhiNotificationOccasion } from "./deliver";

/**
 * The one way anything in Core sends a message to a person.
 *
 * Nothing calls `sendTemplatedEmail` directly any more, and that is the point: a message that is written
 * down before it is sent gets a retry, a record, and one place where its class is decided. The row is the
 * receipt -- what happens to it afterwards is the drain's business.
 *
 * `immediate` is what keeps a confirmation mail as fast as it was. The request that wrote the row tries it
 * once itself and waits for that attempt, exactly as it waited for SMTP before; what is new is that a
 * failure is now a row that stays due instead of a message nobody will ever send again. A bulk run passes
 * `false`, because five hundred attempts inside one request is the timeout this design exists to avoid.
 *
 * Answers the row's id, or `null` when a `dedupeKey` was already used, which is not an error.
 *
 * A sent-class message (a circular) is refused outright. Its consent used to be a Core bit, the newsletter
 * opt-in on the membership, and Core keeps no such consent any more (owner, 2026-11-24): the Add-on that
 * sends a circular holds the consent for it and names the recipients it holds it for. Until that protocol
 * exists (design/NOTIFICATIONS.md section 9) nothing may be sent in this class, and nothing in Core asks
 * to.
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
  if (input.sent === true) {
    throw new Error(
      "A circular needs the consent of the Add-on that sends it, and Core cannot take one yet; see design/NOTIFICATIONS.md section 9.",
    );
  }

  const id = await enqueuePhiNotification({
    siteId: input.siteId,
    occasion: input.occasion,
    recipient: input.recipient,
    flags: 0,
    params: input.params,
    dedupeKey: input.dedupeKey,
  });

  if (id && input.immediate !== false) {
    await attemptPhiNotificationNow(id);
  }

  return id;
}
