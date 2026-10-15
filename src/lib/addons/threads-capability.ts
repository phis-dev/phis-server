import "server-only";

import type { PhisThreadsCapabilityV1 } from "./contract.ts";
import {
  addThreadMessage,
  addThreadParticipants,
  amendImportedThreadMessage,
  createThread,
  findThreadByExternalRef,
  findThreadMessageExport,
  getThreadDetail,
  listThreadsForUser,
  markThreadRead,
  recordThreadMessageExport,
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
 * **From an unverified hook** it reads and writes nothing at all. A request nobody signed is a request
 * from whoever found the address, and an integration's own thread is exactly what such a caller would
 * want to write into.
 *
 * What is withheld either way: `Internal` messages never reach an Add-on, and a `Confidential` one
 * arrives with its text removed and its flag set, so an interface can say why there is nothing to show.
 */
export function buildPhisAddonThreadsCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisThreadsCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  /*
   * Reads are refused here too, which `data:v1` does not do.
   *
   * A public row an Add-on chose to expose is one thing; a thread is somebody's conversation, and the
   * reach an actorless Add-on has over one rests on a link a person wrote as consent. Handing that
   * reach to whoever found an unsigned address would make the consent meaningless.
   */
  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonThreadsError(
        `${addonId} called threads.${call} from an unverified hook; a hook that touches threads declares how its caller can be believed.`,
      );
    }
  };

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
      requireBelievableCaller("get");
      return getThreadDetail(siteId, reader, threadId, {
        messageLimit: options.messageLimit,
        beforeMessageId: options.beforeMessageId,
      });
    },

    async create(createInput) {
      requireBelievableCaller("create");
      const detail = await createThread({
        siteId,
        kind: createInput.kind,
        subject: createInput.subject ?? null,
        message: createInput.message,
        messageMarkdown: createInput.messageMarkdown ?? null,
        messageSourceLang: createInput.messageSourceLang ?? null,
        messageFlags: createInput.messageFlags,
        participantUserIds: createInput.participantUserIds,
        participantGroupIds: createInput.participantGroupIds,
        /*
         * Whose files these have to be follows whoever the write is attributed to, which is the same
         * rule as the ownership below. Acting for a person, an Add-on attaches that person's; acting as
         * itself, its own. Neither can reach into the other's Space, which is what keeps a record off a
         * quota nobody agreed to carry.
         */
        assetIds: createInput.assetIds,
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
      requireBelievableCaller("reply");
      return addThreadMessage({
        siteId,
        threadId: replyInput.threadId,
        reader,
        message: replyInput.message,
        messageMarkdown: replyInput.messageMarkdown ?? null,
        messageSourceLang: replyInput.messageSourceLang ?? null,
        messageFlags: replyInput.messageFlags,
        assetIds: replyInput.assetIds,
        externalRef: replyInput.externalRef ?? null,
        externalAuthor: replyInput.externalAuthor ?? null,
      });
    },

    async addParticipants(participantInput) {
      requireBelievableCaller("addParticipants");
      return addThreadParticipants({
        siteId,
        threadId: participantInput.threadId,
        reader,
        participantUserIds: participantInput.participantUserIds,
        participantGroupIds: participantInput.participantGroupIds,
      });
    },

    async setStatus(statusInput) {
      requireBelievableCaller("setStatus");
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
      requireBelievableCaller("findByExternalRef");
      return findThreadByExternalRef({ siteId, providerId: addonId, externalRef });
    },

    /*
     * Its own record of what it wrote out and what it brought in -- never anybody else's. The writes are
     * barred to an unverified hook like every other write here.
     */
    async recordExport(exportInput) {
      requireBelievableCaller("recordExport");
      return recordThreadMessageExport({
        siteId,
        providerId: addonId,
        messageId: exportInput.messageId,
        externalRef: exportInput.externalRef,
      });
    },

    async findExport(messageId) {
      requireBelievableCaller("findExport");
      return findThreadMessageExport({ siteId, providerId: addonId, messageId });
    },

    async amendImported(amendInput) {
      requireBelievableCaller("amendImported");
      return amendImportedThreadMessage({
        siteId,
        providerId: addonId,
        externalRef: amendInput.externalRef,
        message: amendInput.message,
      });
    },
  } satisfies PhisThreadsCapabilityV1);
}
