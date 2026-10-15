import "server-only";

import type {
  PhisSupportCapabilityV1,
  PhisSupportTicket,
  PhisSupportTicketTask,
} from "./contract.ts";
import {
  addSupportTicketTask,
  createSupportTicket,
  findSupportTicketByThread,
  getSupportQueueIdByKey,
  getSupportTicketDetail,
  getSupportTicketIdForTask,
  getSupportTicketTypeIdByKey,
  getSupportTicketWithType,
  updateSupportTicketTask,
  type SupportTicketTaskRecord,
  type SupportTicketWithTypeRecord,
  SUPPORT_TICKET_CHANNEL_API,
  SUPPORT_TICKET_CHANNEL_PORTAL,
  SUPPORT_TICKET_TASK_TYPE_ENGINEERING,
} from "@/db/support";
import {
  SupportAllowanceError,
  getSupportAllowance,
  grantSupportAllowance,
  revokeSupportAllowanceGrant,
} from "@/db/support-allowance";
import { canReaderSeeThread } from "@/db/threads";
import { isPhiSiteMember } from "@/db/server-addon-owner.mts";
import { getPool } from "@/lib/db";
import type { PhisSupportClosePolicyValue } from "@phis/contracts/support";

export class PhisAddonSupportError extends Error {}

function asTicket(record: SupportTicketWithTypeRecord): PhisSupportTicket {
  return {
    id: record.id,
    threadId: record.threadId,
    subject: record.subject,
    status: record.status,
    queueId: record.queueId,
    type: {
      id: record.typeId,
      key: record.typeKey,
      flags: record.typeFlags,
      closePolicy: record.typeClosePolicy as PhisSupportClosePolicyValue,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function asTask(record: SupportTicketTaskRecord): PhisSupportTicketTask {
  return {
    id: record.id,
    ticketId: record.ticketId,
    type: record.type,
    status: record.status,
    title: record.title,
    description: record.description,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The workflow record around a conversation: `@phis/server/support:v1`.
 *
 * It exists so that an integration in its own repository can reach a Site's tickets without depending
 * on `@phis/support`. Support's tables and rules are Core's; that package is only the Module, and a
 * second one that had to import it to read a ticket type would not be an independent package at all.
 *
 * **Reach is the thread's answer.** A ticket is readable exactly when its thread is, asked of the one
 * predicate that already answers it -- so for an Add-on with nobody behind it, the two ways in are the
 * ones `threads:v1` has: it opened the thread itself, or a person who could see the thread linked it to
 * something of this Add-on's and marked the link synced. A rule written a second time over the ticket
 * row would drift from that one, and the version that let somebody in would be the one nobody reread.
 *
 * There is no listing and no search, for the reason `resource-links:v1` has none: an Add-on reaches
 * what it was given and never walks a Site's records.
 */
export function buildPhisAddonSupportCapability(input: {
  addonId: string;
  siteId: number;
  actorUserId: number | null;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisSupportCapabilityV1 {
  const { addonId, siteId, actorUserId } = input;

  /*
   * An unverified hook reaches none of this, reads included.
   *
   * A ticket carries what a Site is working on for a customer, and its type says what may be said
   * about it elsewhere. Whoever found an unsigned address should learn neither.
   */
  const requireBelievableCaller = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonSupportError(
        `${addonId} called support.${call} from an unverified hook; a hook that touches tickets declares how its caller can be believed.`,
      );
    }
  };

  /*
   * Whoever the reach is judged against.
   *
   * With a person, it is theirs -- an Add-on acting for somebody may see what they may see and no more.
   * Without one, it is this Add-on's own: what it opened, and what somebody linked to it.
   */
  const reader = actorUserId != null
    ? { kind: "user" as const, userId: actorUserId }
    : { kind: "provider" as const, providerId: addonId };

  const reachTicket = async (call: string, ticketId: number) => {
    requireBelievableCaller(call);
    const ticket = await getSupportTicketWithType(siteId, ticketId);
    if (!ticket || !await canReaderSeeThread(siteId, reader, ticket.threadId)) {
      return null;
    }
    return ticket;
  };

  /*
   * The one thing on this capability that names a person instead of reaching a ticket.
   *
   * The allowance is about somebody before there is any ticket to be linked to, so the reach that
   * answers everything else here has nothing to answer with. The bound is the Site's, and it is the one
   * `groups:v1` already uses for the same unavoidable reason: the person must be a member of this Site.
   * What that leaves an Add-on able to do is give a member of its own Site something -- which is what a
   * Site installed it to do -- and it is still shut to an unverified hook like everything else.
   */
  const reachPerson = async (call: string, userId: number) => {
    requireBelievableCaller(call);
    if (!await isPhiSiteMember(getPool(), siteId, userId)) {
      throw new PhisAddonSupportError(`User ${userId} is not an active member of this Site.`);
    }
  };

  const requireTicket = async (call: string, ticketId: number) => {
    const ticket = await reachTicket(call, ticketId);
    if (!ticket) {
      // One message for absent and for out of reach. Telling them apart would answer, to whoever asked,
      // whether a ticket they cannot see exists.
      throw new PhisAddonSupportError(`${addonId} called support.${call} on a ticket it cannot reach.`);
    }
    return ticket;
  };

  return Object.freeze({
    async get(ticketId) {
      const ticket = await reachTicket("get", ticketId);
      return ticket ? asTicket(ticket) : null;
    },

    async findByThread(threadId) {
      requireBelievableCaller("findByThread");
      const ticket = await findSupportTicketByThread(siteId, threadId);
      if (!ticket || !await canReaderSeeThread(siteId, reader, ticket.threadId)) {
        return null;
      }
      return asTicket(ticket);
    },

    async create({ typeKey, queueKey, subject, message, externalRef }) {
      requireBelievableCaller("create");
      const typeId = await getSupportTicketTypeIdByKey(siteId, typeKey);
      if (typeId == null) {
        throw new PhisAddonSupportError(
          `${addonId} opened a ticket of type "${typeKey}", which this Site does not have.`,
        );
      }
      /*
       * A queue named and not found is refused rather than quietly left to the entry queue. An
       * integration configured against a queue that has been retired is a configuration to correct,
       * and routing its tickets somewhere else in the meantime hides that from whoever has to correct
       * it. Naming none is a different statement, and the entry queue answers it.
       */
      let queueId: number | null = null;
      if (queueKey != null) {
        queueId = await getSupportQueueIdByKey(siteId, queueKey);
        if (queueId == null) {
          throw new PhisAddonSupportError(
            `${addonId} opened a ticket in queue "${queueKey}", which this Site does not have.`,
          );
        }
      }

      const created = await createSupportTicket({
        siteId,
        typeId,
        queueId,
        subject,
        message,
        channel: SUPPORT_TICKET_CHANNEL_API,
        // The same rule as `threads.create`: with nobody behind the call the ticket is the Add-on's own,
        // which is what lets it read work arriving from outside back. Opened for a person, it is that
        // person's, and the Add-on reaches it only while acting for someone who can see it -- otherwise
        // one ticket opened on somebody's behalf would hand it actorless reach for good.
        ownerProviderId: actorUserId == null ? addonId : null,
        externalRef: externalRef ?? null,
        createdByUserId: actorUserId,
      });
      // Read back through the same join every other call answers with, so an Add-on is handed one shape.
      const ticket = created && await getSupportTicketWithType(siteId, created.ticket.id);
      if (!ticket) {
        throw new PhisAddonSupportError(`${addonId} opened a ticket that could not be read back.`);
      }
      return asTicket(ticket);
    },

    async listTasks(ticketId) {
      await requireTicket("listTasks", ticketId);
      const detail = await getSupportTicketDetail(siteId, ticketId);
      return (detail?.tasks ?? []).map(asTask);
    },

    async getTask(taskId) {
      requireBelievableCaller("getTask");
      const ticketId = await getSupportTicketIdForTask(siteId, taskId);
      if (ticketId == null || !await reachTicket("getTask", ticketId)) {
        return null;
      }
      const detail = await getSupportTicketDetail(siteId, ticketId);
      const task = detail?.tasks.find((candidate) => candidate.id === taskId);
      return task ? asTask(task) : null;
    },

    async addTask({ ticketId, type, title, description }) {
      await requireTicket("addTask", ticketId);
      const detail = await addSupportTicketTask({
        siteId,
        ticketId,
        type: type ?? SUPPORT_TICKET_TASK_TYPE_ENGINEERING,
        title,
        description: description ?? null,
        createdByUserId: actorUserId,
      });
      const added = detail?.tasks.at(-1);
      if (!added) {
        throw new PhisAddonSupportError(`${addonId} added a task that could not be read back.`);
      }
      return asTask(added);
    },

    async setTaskStatus({ taskId, status }) {
      requireBelievableCaller("setTaskStatus");
      const ticketId = await getSupportTicketIdForTask(siteId, taskId);
      if (ticketId == null) {
        throw new PhisAddonSupportError(`${addonId} called support.setTaskStatus on a task it cannot reach.`);
      }
      await requireTicket("setTaskStatus", ticketId);
      /*
       * The task moves, and the ticket follows by Core's rule rather than by the integration's say.
       *
       * An issue completes its task; whether that finishes the Support work depends on the type's close
       * policy and on the other tasks, which an integration cannot see all of. So there is no ticket
       * status here at all -- not a narrower one, none -- and `followSupportTicketTasksWithDb` decides
       * from all of them what the ticket is now.
       */
      const detail = await updateSupportTicketTask({
        siteId,
        ticketId,
        taskId,
        status,
        updatedByUserId: actorUserId,
      });
      const moved = detail?.tasks.find((candidate) => candidate.id === taskId);
      if (!moved) {
        throw new PhisAddonSupportError(`${addonId} moved a task that could not be read back.`);
      }
      return asTask(moved);
    },

    async allowance({ userId, typeKey }) {
      await reachPerson("allowance", userId);
      const allowance = await getSupportAllowance({
        siteId,
        userId,
        typeKey,
        selfServiceChannel: SUPPORT_TICKET_CHANNEL_PORTAL,
      });
      if (!allowance) {
        throw new PhisAddonSupportError(
          `${addonId} asked about the allowance of type "${typeKey}", which this Site does not have.`,
        );
      }
      return allowance;
    },

    async grant({ userId, typeKey, amount, reference, expiresAt }) {
      await reachPerson("grant", userId);
      try {
        return await grantSupportAllowance({
          siteId,
          userId,
          typeKey,
          providerId: addonId,
          reference,
          amount,
          expiresAt: expiresAt ?? null,
        });
      } catch (cause) {
        if (cause instanceof SupportAllowanceError) {
          throw new PhisAddonSupportError(`${addonId} could not grant: ${cause.message}`);
        }
        throw cause;
      }
    },

    async revokeGrant({ reference }) {
      requireBelievableCaller("revokeGrant");
      /*
       * No membership check and no user id, because the reference already names one grant.
       *
       * `provider_id` is in the WHERE rather than checked after: a grant somebody else made is not found
       * rather than refused, which is the same shape every other refusal here takes.
       */
      return revokeSupportAllowanceGrant({ siteId, providerId: addonId, reference });
    },
  } satisfies PhisSupportCapabilityV1);
}
