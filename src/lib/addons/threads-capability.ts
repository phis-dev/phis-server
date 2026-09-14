import "server-only";

import type {
  PhisThreadDetail,
  PhisThreadMessage,
  PhisThreadSummary,
  PhisThreadsCapabilityV1,
} from "./contract.ts";
import {
  SUPPORT_THREAD_STATUS_ARCHIVED,
  addSupportThreadMessage,
  addSupportThreadRecipients,
  createSupportThread,
  getSupportThreadDetail,
  listSupportThreadsForUser,
  markSupportThreadRead,
  updateSupportThread,
  type SupportThreadDetailRecord,
  type SupportThreadMessageRecord,
  type SupportThreadRecord,
} from "@/db/support";

export class PhisAddonThreadsError extends Error {}

/**
 * Thread facts and thread writes, bounded by the acting user.
 *
 * The rule is the one `groups:v1` states: **an Add-on sees what its actor sees.** Every read below
 * goes through the same visibility predicate the Site's own thread routes go through -- created it,
 * named in it, or in a team named in it -- so there is no listing here that a person could not have
 * obtained themselves, and no way to turn a Site's threads into something an Add-on can walk.
 *
 * A message body is handed over as it was written. Threads are internal support messaging, not a
 * customer-facing record, and the projection an Add-on gets of an author is the same three fields
 * `groups:v1` discloses -- never an address.
 */

function projectThread(record: SupportThreadRecord): PhisThreadSummary {
  return {
    id: record.id,
    subject: record.subject,
    status: record.status,
    type: record.type,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    latestMessageAt: record.latestMessageCreatedAt,
    unread: record.unread,
  };
}

function projectMessage(record: SupportThreadMessageRecord): PhisThreadMessage {
  return {
    id: record.id,
    bodyText: record.bodyText,
    bodyMarkdown: record.bodyMarkdown,
    author: record.authorUserId == null
      ? null
      : {
        userId: record.authorUserId,
        displayName: record.authorDisplayName,
        companyName: record.authorCompanyName,
      },
    createdAt: record.createdAt,
  };
}

function projectDetail(record: SupportThreadDetailRecord): PhisThreadDetail {
  return {
    thread: projectThread(record.thread),
    messages: record.messages.map(projectMessage),
    hasMoreMessages: record.hasMoreMessages,
    recipientUserIds: record.recipients
      .map((recipient) => recipient.userId)
      .filter((value): value is number => value != null),
    recipientTeamIds: record.recipients
      .map((recipient) => recipient.teamId)
      .filter((value): value is number => value != null),
  };
}

export function buildPhisAddonThreadsCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
}): PhisThreadsCapabilityV1 {
  const { siteId, actorUserId } = input;

  /*
   * Everything but `create` needs somebody to be bounded by.
   *
   * Thread visibility is made of membership, and an Add-on running as itself -- in a job, in a hook --
   * is a member of nothing. The alternative would be a listing that steps around the predicate, which
   * is the one thing this capability exists to prevent, so the call is refused instead of quietly
   * answering with everything or with nothing.
   */
  const requireActor = (call: string) => {
    if (actorUserId == null) {
      throw new PhisAddonThreadsError(
        `${input.addonId} called threads.${call} with no acting user; only threads.create is available without one.`,
      );
    }
    return actorUserId;
  };

  return Object.freeze({
    async list(options = {}) {
      const userId = requireActor("list");
      const result = await listSupportThreadsForUser(siteId, userId, {
        page: options.page,
        pageSize: options.pageSize,
        unreadOnly: options.unreadOnly,
      });
      return result.rows.map(projectThread);
    },

    async get(threadId, options = {}) {
      const userId = requireActor("get");
      const detail = await getSupportThreadDetail(siteId, userId, threadId, {
        messageLimit: options.messageLimit,
        beforeMessageId: options.beforeMessageId,
      });
      return detail ? projectDetail(detail) : null;
    },

    async create(createInput) {
      const detail = await createSupportThread({
        siteId,
        subject: createInput.subject ?? null,
        message: createInput.message,
        messageMarkdown: createInput.messageMarkdown ?? null,
        recipientUserIds: createInput.recipientUserIds,
        recipientTeamIds: createInput.recipientTeamIds,
        createdByUserId: actorUserId,
      });
      if (!detail) {
        throw new PhisAddonThreadsError(`${input.addonId} could not open a thread on site ${siteId}.`);
      }
      return projectDetail(detail);
    },

    async reply(replyInput) {
      const userId = requireActor("reply");
      const detail = await addSupportThreadMessage({
        siteId,
        threadId: replyInput.threadId,
        bodyText: replyInput.message,
        bodyMarkdown: replyInput.messageMarkdown ?? null,
        authorUserId: userId,
      });
      return detail ? projectDetail(detail) : null;
    },

    async addRecipients(recipientInput) {
      const userId = requireActor("addRecipients");
      const detail = await addSupportThreadRecipients({
        siteId,
        threadId: recipientInput.threadId,
        actingUserId: userId,
        recipientUserIds: recipientInput.recipientUserIds,
        recipientTeamIds: recipientInput.recipientTeamIds,
      });
      return detail ? projectDetail(detail) : null;
    },

    async archive(threadId) {
      const userId = requireActor("archive");
      const detail = await updateSupportThread({
        siteId,
        threadId,
        actingUserId: userId,
        status: SUPPORT_THREAD_STATUS_ARCHIVED,
      });
      return detail != null;
    },

    async markRead(readInput) {
      const userId = requireActor("markRead");
      const detail = await markSupportThreadRead(
        siteId,
        userId,
        readInput.threadId,
        readInput.messageId ?? null,
      );
      return detail != null;
    },
  } satisfies PhisThreadsCapabilityV1);
}
