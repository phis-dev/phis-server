import "server-only";

import {
  claimDuePhiNotifications,
  claimPhiNotificationById,
  ensurePhiNotificationLinkSalt,
  markPhiNotificationDropped,
  markPhiNotificationFailed,
  markPhiNotificationSent,
  PHI_NOTIFICATION_FLAG_SENT,
  type PhiNotificationRow,
} from "@/db/notifications";
import { getSiteConfigBySiteId } from "@/db/site-config";
import { getSiteByKey, getSiteIdentityById } from "@/db/sites";
import { getUserAccountById } from "@/db/user-accounts";
import { getUserProfileByUserId } from "@/db/user-profiles";
import { getUserSiteMembership } from "@/db/user-site-memberships";
import { sendTemplatedEmail, type SupportedEmailTemplate } from "@/lib/email-templates";
import { logRuntimeEvent } from "@/lib/log";
import { isUserAccountEnabled } from "@/lib/user-flags";
import { hasUserSiteFlag, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";
import {
  buildPhiUnsubscribeToken,
  buildPhiUnsubscribeUrl,
  createPhiNotificationLinkSalt,
} from "./links";

/**
 * Which words render each occasion Core declares itself.
 *
 * The ids are the template names rather than new ones, because inventing a second vocabulary for the same
 * four messages would only create something to keep in step. An Add-on's occasion will not be in here:
 * its words come from its manifest, and `provider_id` on the row says whose they are.
 */
const CORE_OCCASION_TEMPLATES: Record<string, SupportedEmailTemplate> = {
  registration_verify: "registration_verify",
  registration_welcome: "registration_welcome",
  registration_account_exists: "registration_account_exists",
  password_reset: "password_reset",
};

export type PhiNotificationOccasion = keyof typeof CORE_OCCASION_TEMPLATES;

/** What the drain did with one row, as the three outcomes the table can hold. */
type DeliveryOutcome = "sent" | "dropped" | "failed";

class DropError extends Error {}

function buildRecipientName(firstName: string, lastName: string) {
  return [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(" ");
}

function readStringParam(params: Record<string, unknown>, key: string) {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

/**
 * Who this row goes to, in the language they read, under the name they are greeted by.
 *
 * The address is resolved here rather than carried on the row, which is the point of storing an id: a
 * corrected address is used, and a membership that has gone takes the message with it. A withdrawal of
 * consent between the enqueue and the drain lands here too, and it is a drop rather than a failure --
 * nobody wanted this message by the time it was due.
 */
async function resolveRecipient(
  row: PhiNotificationRow,
  site: { defaultLocale: string },
) {
  if (row.recipientUserId === null) {
    if (!row.recipientAddress) {
      throw new DropError("The row carries neither an account nor an address.");
    }
    if ((row.flags & PHI_NOTIFICATION_FLAG_SENT) !== 0) {
      // A circular owes a way out, and a way out needs a membership whose flag it can clear.
      throw new DropError("A sent message cannot go to an address without an account.");
    }
    return {
      address: row.recipientAddress,
      locale: row.locale || site.defaultLocale,
      name: row.recipientAddress,
      userId: null,
    };
  }

  const [account, membership] = await Promise.all([
    getUserAccountById(row.recipientUserId, row.siteId),
    getUserSiteMembership(row.recipientUserId, row.siteId),
  ]);

  if (!account || !membership) {
    throw new DropError("The account this message was for is gone.");
  }
  if (!isUserAccountEnabled(account.flags) || !membership.enabled) {
    throw new DropError("The account this message was for is disabled.");
  }
  if (
    (row.flags & PHI_NOTIFICATION_FLAG_SENT) !== 0 &&
    !hasUserSiteFlag(membership.siteFlags, USER_SITE_FLAG_NEWSLETTER_OPT_IN)
  ) {
    throw new DropError("Consent for sent messages was withdrawn before this one was due.");
  }

  const profile = await getUserProfileByUserId(account.id);
  const name = profile ? buildRecipientName(profile.firstName, profile.lastName) : "";

  return {
    address: account.emailNormalized,
    locale: account.preferredLocale || site.defaultLocale,
    name: name || account.emailNormalized,
    userId: account.id,
  };
}

/**
 * Renders and sends one claimed row, and records which of the three things happened to it.
 *
 * Never throws: the caller is a drain working through a list, and one unreachable transport must not stop
 * the rest. What it cannot do it writes down.
 */
export async function deliverPhiNotification(row: PhiNotificationRow): Promise<DeliveryOutcome> {
  try {
    const identity = await getSiteIdentityById(row.siteId);
    const site = identity ? await getSiteByKey(identity.key) : null;
    if (!site) {
      throw new Error(`Site ${row.siteId} is not active.`);
    }

    const siteConfig = await getSiteConfigBySiteId(row.siteId);
    if (!siteConfig) {
      throw new Error(`Site ${site.key} has no mail configuration.`);
    }

    const template = CORE_OCCASION_TEMPLATES[row.occasion];
    if (!template) {
      throw new Error(`Occasion ${row.occasion} of ${row.providerId} has no words here.`);
    }

    const recipient = await resolveRecipient(row, site);
    const isSentClass = (row.flags & PHI_NOTIFICATION_FLAG_SENT) !== 0;

    let unsubscribeUrl: string | undefined;
    if (isSentClass && recipient.userId !== null) {
      const salt = await ensurePhiNotificationLinkSalt(
        recipient.userId,
        row.siteId,
        createPhiNotificationLinkSalt(),
      );
      if (!salt) {
        throw new Error("No link salt could be established for the recipient.");
      }
      unsubscribeUrl = buildPhiUnsubscribeUrl({
        publicBaseUrl: siteConfig.publicBaseUrl,
        locale: recipient.locale,
        token: buildPhiUnsubscribeToken({ siteId: row.siteId, userId: recipient.userId, salt }),
      });
    }

    const messageId = await sendTemplatedEmail({
      to: recipient.address,
      site,
      siteConfig,
      locale: recipient.locale,
      template,
      recipientName: recipient.name,
      verificationUrl: readStringParam(row.params, "verificationUrl"),
      // A circular answers to Support. A system mail answers nowhere, which is what a no-reply is for.
      replyTo: isSentClass ? siteConfig.supportEmail : undefined,
      unsubscribeUrl,
    });

    await markPhiNotificationSent(row.id, messageId);
    logRuntimeEvent("info", "mail.sent", {
      message: "Notification sent.",
      siteKey: site.key,
      userId: recipient.userId ?? undefined,
      meta: { occasion: row.occasion, notificationId: row.id, messageId, attempts: row.attempts },
    });
    return "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown delivery error.";

    if (error instanceof DropError) {
      await markPhiNotificationDropped(row.id, reason);
      logRuntimeEvent("info", "mail.dropped", {
        message: "Notification settled without being sent.",
        meta: { occasion: row.occasion, notificationId: row.id, reason },
      });
      return "dropped";
    }

    await markPhiNotificationFailed(row.id, reason);
    logRuntimeEvent("error", "mail.failed", {
      message: "Notification could not be sent.",
      meta: { occasion: row.occasion, notificationId: row.id, attempts: row.attempts },
      error: error instanceof Error ? error : new Error(reason),
    });
    return "failed";
  }
}

/**
 * Works through what is due, oldest first, and answers with what happened.
 *
 * Bounded by `limit` because a handler is raced against a timeout and a maintenance run should finish: what
 * it does not reach stays due and is reached next time.
 */
export async function drainPhiNotifications(limit = 100) {
  const rows = await claimDuePhiNotifications(limit);
  const outcomes = { sent: 0, dropped: 0, failed: 0 };

  for (const row of rows) {
    outcomes[await deliverPhiNotification(row)] += 1;
  }

  return { claimed: rows.length, ...outcomes };
}

/**
 * The one attempt the request that wrote a row makes itself, so an expected mail is not waiting for the
 * next maintenance run.
 *
 * Best effort by construction: it answers nothing and throws nothing, because the row is already the
 * record. A failure here is a row that stays due, which is exactly what the drain is for.
 */
export async function attemptPhiNotificationNow(id: string) {
  try {
    const row = await claimPhiNotificationById(id);
    if (row) {
      await deliverPhiNotification(row);
    }
  } catch (error) {
    logRuntimeEvent("warn", "mail.immediate_attempt_failed", {
      message: "The immediate attempt at a notification did not run.",
      meta: { notificationId: id },
      error: error instanceof Error ? error : undefined,
    });
  }
}
