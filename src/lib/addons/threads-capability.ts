import "server-only";

import type { PhisThreadsCapabilityV1 } from "./contract.ts";
import {
  addThreadMessage,
  addThreadParticipants,
  createThread,
  findThreadByExternalRef,
  getThreadDetail,
  listThreadsForUser,
  markThreadRead,
  setThreadStatus,
  type ThreadReader,
} from "@/db/threads";

export class PhisAddonThreadsError extends Error {}

/**
 * Thread facts and thread writes, bounded by whoever is behind the call.
 *
 * **With an actor** the rule is the one `groups:v1` states: an Add-on sees what its actor sees. Every
 * read goes through the same visibility predicate Core's own thread routes go through, so there is no
 * listing here a person could not have obtained themselves.
 *
 * **Without one** -- a job, a verified hook, an event -- the Add-on reaches the threads it owns and the
 * ones a person linked it to, and nothing else. The link was written by somebody who could see the
 * thread, which is what makes it consent rather than a standing permission; unlinking ends the reach.
 *
 * What is withheld either way: `Internal` messages never reach an Add-on, and a `Confidential` one
 * arrives with its text removed and its flag set, so an interface can say why there is nothing to show.
 */
export function buildPhisAddonThreadsCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
}): PhisThreadsCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  const reader: ThreadReader = actorUserId != null
    ? { kind: "user", userId: actorUserId }
    : { kind: "provider", providerId: addonId };

  /*
   * An inbox needs somebody to be an inbox for.
   *
   * Ownership and links answer "may I touch this one" and never "what is there", so a listing for an
   * Add-on acting as itself would have to invent an order over a Site's conversations -- the walk this
   * capability exists to prevent. It finds its threads by the reference it recorded instead.
   */
  const requireActor = (call: string) => {
    if (actorUserId == null) {
      throw new PhisAddonThreadsError(
        `${addonId} called threads.${call} with no acting user; without one an Add-on reaches only the threads it owns or is linked to, by id or by external reference.`,
      );
    }
    return actorUserId;
  };

  return Object.freeze({
    async list(options = {}) {
      const userId = requireActor("list");
      const result = await listThreadsForUser(siteId, userId, {
        page: options.page,
        pageSize: options.pageSize,
        unreadOnly: options.unreadOnly,
      });
      return result.rows;
    },

    async get(threadId, options = {}) {
      return getThreadDetail(siteId, reader, threadId, {
        messageLimit: options.messageLimit,
        beforeMessageId: options.beforeMessageId,
      });
    },

    async create(createInput) {
      const detail = await createThread({
        siteId,
        kind: createInput.kind,
        subject: createInput.subject ?? null,
        message: createInput.message,
        messageMarkdown: createInput.messageMarkdown ?? null,
        messageFlags: createInput.messageFlags,
        participantUserIds: createInput.participantUserIds,
        participantGroupIds: createInput.participantGroupIds,
        createdByUserId: actorUserId,
        // With nobody behind the call the thread is the Add-on's own, which is what makes it reachable
        // again: an integration that could open a thread and never return to it could not hold a
        // conversation open at all.
        ownerProviderId: actorUserId == null ? addonId : null,
        externalRef: createInput.externalRef ?? null,
        externalAuthor: createInput.externalAuthor ?? null,
      });
      if (!detail) {
        throw new PhisAddonThreadsError(`${addonId} could not open a thread on site ${siteId}.`);
      }
      return detail;
    },

    async reply(replyInput) {
      return addThreadMessage({
        siteId,
        threadId: replyInput.threadId,
        reader,
        message: replyInput.message,
        messageMarkdown: replyInput.messageMarkdown ?? null,
        messageFlags: replyInput.messageFlags,
        externalRef: replyInput.externalRef ?? null,
        externalAuthor: replyInput.externalAuthor ?? null,
      });
    },

    async addParticipants(participantInput) {
      return addThreadParticipants({
        siteId,
        threadId: participantInput.threadId,
        reader,
        participantUserIds: participantInput.participantUserIds,
        participantGroupIds: participantInput.participantGroupIds,
      });
    },

    async setStatus(statusInput) {
      return setThreadStatus({
        siteId,
        threadId: statusInput.threadId,
        reader,
        status: statusInput.status,
      });
    },

    async markRead(readInput) {
      const userId = requireActor("markRead");
      return markThreadRead(siteId, userId, readInput.threadId, readInput.messageId ?? null);
    },

    async findByExternalRef(externalRef) {
      return findThreadByExternalRef({ siteId, providerId: addonId, externalRef });
    },
  } satisfies PhisThreadsCapabilityV1);
}
