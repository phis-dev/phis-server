import "server-only";

import type { PoolClient } from "pg";

import {
  PhisSupportAllowancePeriod,
  PhisSupportQueueFlag,
  PhisSupportTicketChannel,
  PhisSupportTicketPriority,
  PhisSupportTicketSeverity,
  PhisSupportTicketStatus,
  PhisSupportTicketTypeFlag,
  type PhisSupportAllowance,
  type PhisSupportAllowancePeriodValue,
  type PhisSupportTicketStatusValue,
} from "@phis/contracts/support";
import { PhisThreadKind, PhisThreadParticipantFlag } from "@phis/contracts/threads";
import { PhisResourceLinkFlag } from "@phis/contracts/addon";

import { getPool, withTransaction } from "@/lib/db";
import { createThreadWithDb } from "@/db/threads";
import { PHIS_THREAD_PARTICIPANT_KIND_GROUP } from "@/lib/constants/threads";
import { consumeSupportAllowanceWithDb, readSupportAllowance } from "@/db/support-allowance";
import { toPhiRecord } from "@/lib/helpers/record";
import {
  SUPPORT_TICKET_TASK_STATUS_BLOCKED,
  SUPPORT_TICKET_TASK_STATUS_CANCELED,
  SUPPORT_TICKET_TASK_STATUS_DONE,
  SUPPORT_TICKET_TASK_STATUS_IN_PROGRESS,
  SUPPORT_TICKET_TASK_STATUS_OPEN,
  SUPPORT_TICKET_TASK_TYPE_CUSTOMER_FOLLOWUP,
  SUPPORT_TICKET_TASK_TYPE_DEPLOYMENT,
  SUPPORT_TICKET_TASK_TYPE_DOCUMENTATION,
  SUPPORT_TICKET_TASK_TYPE_ENGINEERING,
  SUPPORT_TICKET_TASK_TYPE_INTERNAL,
  SUPPORT_TICKET_TASK_TYPE_QA,
} from "@/lib/constants/support";
import {
  SUPPORT_TICKET_EVENT_ASSIGNED,
  SUPPORT_TICKET_EVENT_CREATED,
  SUPPORT_TICKET_EVENT_LINKED,
  SUPPORT_TICKET_EVENT_TASK_COMPLETED,
  SUPPORT_TICKET_EVENT_TASK_CREATED,
  SUPPORT_TICKET_EVENT_TASK_REOPENED,
} from "@/lib/constants/support";
import {
  followSupportTicketTasksWithDb,
  insertSupportTicketEvent,
  moveSupportTicketStatusWithDb,
  settleSupportTicketWindowWithDb,
  supportTicketStatusAfterHandover,
} from "@/db/support-ticket-ladder";
import {
  settledSupportTicketColumnsSql,
  settledSupportTicketStatusSql,
} from "@/db/support-requester-window.mts";

/*
 * The ticket vocabulary, from the contract rather than spelled out again.
 *
 * These names are what this process reads; the numbers behind them are `@phis/contracts/support`, where
 * a surface outside this process can reach them too. They were literals here, and the contract's own
 * ticket type pointed at them in prose -- so a Site UI being sent `status: 4` had no way to learn that
 * this means waiting on the customer.
 */
export const SUPPORT_TICKET_STATUS_NEW = PhisSupportTicketStatus.New;
export const SUPPORT_TICKET_STATUS_TRIAGED = PhisSupportTicketStatus.Triaged;
export const SUPPORT_TICKET_STATUS_ASSIGNED = PhisSupportTicketStatus.Assigned;
export const SUPPORT_TICKET_STATUS_IN_PROGRESS = PhisSupportTicketStatus.InProgress;
export const SUPPORT_TICKET_STATUS_WAITING_CUSTOMER = PhisSupportTicketStatus.WaitingCustomer;
export const SUPPORT_TICKET_STATUS_WAITING_INTERNAL = PhisSupportTicketStatus.WaitingInternal;
export const SUPPORT_TICKET_STATUS_ESCALATED = PhisSupportTicketStatus.Escalated;
export const SUPPORT_TICKET_STATUS_RESOLVED = PhisSupportTicketStatus.Resolved;
export const SUPPORT_TICKET_STATUS_CLOSED = PhisSupportTicketStatus.Closed;

export const SUPPORT_TICKET_CHANNEL_PORTAL = PhisSupportTicketChannel.Portal;
export const SUPPORT_TICKET_CHANNEL_EMAIL = PhisSupportTicketChannel.Email;
export const SUPPORT_TICKET_CHANNEL_GITHUB = PhisSupportTicketChannel.GitHub;
export const SUPPORT_TICKET_CHANNEL_API = PhisSupportTicketChannel.Api;
export const SUPPORT_TICKET_CHANNEL_INTERNAL = PhisSupportTicketChannel.Internal;

export const SUPPORT_TICKET_PRIORITY_LOW = PhisSupportTicketPriority.Low;
export const SUPPORT_TICKET_PRIORITY_NORMAL = PhisSupportTicketPriority.Normal;
export const SUPPORT_TICKET_PRIORITY_HIGH = PhisSupportTicketPriority.High;
export const SUPPORT_TICKET_PRIORITY_URGENT = PhisSupportTicketPriority.Urgent;

export const SUPPORT_TICKET_SEVERITY_MINOR = PhisSupportTicketSeverity.Minor;
export const SUPPORT_TICKET_SEVERITY_MAJOR = PhisSupportTicketSeverity.Major;
export const SUPPORT_TICKET_SEVERITY_CRITICAL = PhisSupportTicketSeverity.Critical;

// The task vocabulary lives with the event numbers, where the ladder module and the CLI reach it too.
export {
  SUPPORT_TICKET_TASK_STATUS_BLOCKED,
  SUPPORT_TICKET_TASK_STATUS_CANCELED,
  SUPPORT_TICKET_TASK_STATUS_DONE,
  SUPPORT_TICKET_TASK_STATUS_IN_PROGRESS,
  SUPPORT_TICKET_TASK_STATUS_OPEN,
  SUPPORT_TICKET_TASK_TYPE_CUSTOMER_FOLLOWUP,
  SUPPORT_TICKET_TASK_TYPE_DEPLOYMENT,
  SUPPORT_TICKET_TASK_TYPE_DOCUMENTATION,
  SUPPORT_TICKET_TASK_TYPE_ENGINEERING,
  SUPPORT_TICKET_TASK_TYPE_INTERNAL,
  SUPPORT_TICKET_TASK_TYPE_QA,
};


type DbQueryable = Pick<PoolClient, "query">;

type SupportTicketListRow = {
  id: number;
  type_id: number;
  thread_id: number;
  status: number;
  /** `status` as it stands now; see `settledSupportTicketColumnsSql`. */
  settled_status: number;
  settled_closed_at: string | null;
  channel: number;
  priority: number;
  severity: number | null;
  flags: number;
  requester_user_id: number | null;
  requester_email: string | null;
  assignee_user_id: number | null;
  assignee_email: string | null;
  queue_id: number | null;
  queue_name: string | null;
  subject: string;
  summary: string | null;
  meta: Record<string, unknown> | null;
  first_response_due_at: string | null;
  resolution_due_at: string | null;
  last_public_message_at: string | null;
  last_internal_message_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
  total_count?: number;
};

type SupportTicketTaskRow = {
  id: number;
  ticket_id: number;
  type: number;
  status: number;
  flags: number;
  sort_order: number;
  assignee_user_id: number | null;
  assignee_email: string | null;
  title: string;
  description: string | null;
  meta: Record<string, unknown> | null;
  due_at: string | null;
  completed_at: string | null;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};


export type SupportTicketRecord = {
  id: number;
  typeId: number;
  /** The ticket's conversation; everything anybody said about it is read through the thread surface. */
  threadId: number;
  status: number;
  channel: number;
  priority: number;
  severity: number | null;
  flags: number;
  requesterUserId: number | null;
  requesterEmail: string | null;
  assigneeUserId: number | null;
  assigneeEmail: string | null;
  queueId: number | null;
  queueName: string | null;
  subject: string;
  summary: string | null;
  meta: Record<string, unknown>;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  lastPublicMessageAt: string | null;
  lastInternalMessageAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportTicketTaskRecord = {
  id: number;
  ticketId: number;
  type: number;
  status: number;
  flags: number;
  sortOrder: number;
  assigneeUserId: number | null;
  assigneeEmail: string | null;
  title: string;
  description: string | null;
  meta: Record<string, unknown>;
  dueAt: string | null;
  completedAt: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * A ticket and its work, without its conversation.
 *
 * What anybody said about the ticket is its thread, read through the thread surface with the reader's
 * own visibility applied -- internal notes are withheld from the requester there, and reproducing that
 * rule here would be the second answer that eventually disagrees with the first. Cross-system
 * references are `resource_links`, and they are the linking Add-on's to read.
 */
export type SupportTicketDetailRecord = {
  ticket: SupportTicketRecord;
  tasks: SupportTicketTaskRecord[];
};

export type ListSupportTicketsOptions = {
  search?: string;
  status?: number | null;
  channel?: number | null;
  assigneeUserId?: number | null;
  queueId?: number | null;
  page?: number;
  pageSize?: number;
};

export type CreateSupportTicketInput = {
  siteId: number;
  /** One of the Site's own ticket types, which decides what may leave the Site and what ends the ticket. */
  typeId: number;
  /** The first thing said about it, which opens the ticket's thread. */
  message: string;
  messageMarkdown?: string | null;
  status?: number;
  channel: number;
  priority?: number;
  severity?: number | null;
  flags?: number;
  requesterUserId?: number | null;
  requesterEmail?: string | null;
  assigneeUserId?: number | null;
  queueId?: number | null;
  subject: string;
  summary?: string | null;
  meta?: Record<string, unknown>;
  firstResponseDueAt?: string | null;
  resolutionDueAt?: string | null;
  createdByUserId?: number | null;
  /**
   * The Add-on opening this ticket as its own, where no person is behind it.
   *
   * It is the thread that records it, and that is the whole of the Add-on's later reach: a ticket
   * arriving from a watched repository has nobody who could link it afterwards, so ownership is what
   * lets the integration read back what it opened.
   */
  ownerProviderId?: string | null;
  /**
   * Whether this ticket spends the requester's own allowance, and may be refused for want of it.
   *
   * Only the self-service route sets it. A Supporter opening a ticket for somebody, or an integration
   * opening one for work that arrived from outside, is not somebody asking for their own budget: it
   * neither spends it nor can be stopped by it. See `src/db/support-allowance.ts`.
   */
  enforceRequesterAllowance?: boolean;
  /** Idempotency for an inbound event: the other system's id for the thing that opened this. */
  externalRef?: string | null;
  /** The requester acknowledged that a ticket of this type is mirrored outside. */
  requesterExternalConsent?: boolean;
};

export type UpdateSupportTicketInput = {
  siteId: number;
  ticketId: number;
  typeId?: number;
  status?: number;
  channel?: number;
  priority?: number;
  severity?: number | null;
  requesterUserId?: number | null;
  requesterEmail?: string | null;
  assigneeUserId?: number | null;
  queueId?: number | null;
  subject?: string;
  summary?: string | null;
  meta?: Record<string, unknown>;
  firstResponseDueAt?: string | null;
  resolutionDueAt?: string | null;
  updatedByUserId?: number | null;
};

export type AddSupportTicketTaskInput = {
  siteId: number;
  ticketId: number;
  type?: number;
  status?: number;
  flags?: number;
  sortOrder?: number;
  assigneeUserId?: number | null;
  title: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  dueAt?: string | null;
  completedAt?: string | null;
  createdByUserId?: number | null;
};

export type UpdateSupportTicketTaskInput = {
  siteId: number;
  ticketId: number;
  taskId: number;
  type?: number;
  status?: number;
  flags?: number;
  sortOrder?: number;
  assigneeUserId?: number | null;
  title?: string;
  description?: string | null;
  meta?: Record<string, unknown>;
  dueAt?: string | null;
  completedAt?: string | null;
  updatedByUserId?: number | null;
};

export type SupportTicketAssignmentActionInput =
  | {
      siteId: number;
      ticketId: number;
      action: "assign_to_me";
      userId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "assign_to_user";
      userId: number;
      targetUserId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "unassign";
      userId: number;
    }
  | {
      siteId: number;
      ticketId: number;
      action: "move_to_queue";
      userId: number;
      queueId: number;
    };

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizeSearch(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function mapSupportTicket(row: SupportTicketListRow): SupportTicketRecord {
  return {
    id: row.id,
    typeId: row.type_id,
    threadId: row.thread_id,
    status: row.status,
    channel: row.channel,
    priority: row.priority,
    severity: row.severity,
    flags: row.flags,
    requesterUserId: row.requester_user_id,
    requesterEmail: row.requester_email,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    queueId: row.queue_id,
    queueName: row.queue_name,
    subject: row.subject,
    summary: row.summary,
    meta: toPhiRecord(row.meta),
    firstResponseDueAt: row.first_response_due_at,
    resolutionDueAt: row.resolution_due_at,
    lastPublicMessageAt: row.last_public_message_at,
    lastInternalMessageAt: row.last_internal_message_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportTicketTask(row: SupportTicketTaskRow): SupportTicketTaskRecord {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    type: row.type,
    status: row.status,
    flags: row.flags,
    sortOrder: row.sort_order,
    assigneeUserId: row.assignee_user_id,
    assigneeEmail: row.assignee_email,
    title: row.title,
    description: row.description,
    meta: toPhiRecord(row.meta),
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertSupportTicketAssignment(
  queryable: DbQueryable,
  input: {
    ticketId: number;
    fromUserId?: number | null;
    toUserId?: number | null;
    fromQueueId?: number | null;
    toQueueId?: number | null;
    createdByUserId?: number | null;
    reason?: string | null;
  },
) {
  await queryable.query(
    `INSERT INTO phis.support_ticket_assignments (
       ticket_id,
       from_user_id,
       to_user_id,
       from_queue_id,
       to_queue_id,
       reason,
       created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.ticketId,
      input.fromUserId ?? null,
      input.toUserId ?? null,
      input.fromQueueId ?? null,
      input.toQueueId ?? null,
      input.reason ?? null,
      input.createdByUserId ?? null,
    ],
  );
}

/**
 * Reads one ticket, optionally locking its row.
 *
 * A transaction that decides its writes from what it read here -- the assignment history records the
 * previous assignee and queue -- has to pass `forUpdate`, or two concurrent changes both read the same
 * "before" and one history entry names a state the ticket was never in. The lock names `t` alone
 * because PostgreSQL refuses to lock the nullable side of an outer join, and the joined rows are only
 * labels. A read outside a transaction must not lock: the lock would end with the statement anyway.
 */
async function getSupportTicketRowById(
  queryable: DbQueryable,
  siteId: number,
  ticketId: number,
  options: { forUpdate?: boolean } = {},
) {
  const { rows } = await queryable.query<SupportTicketListRow>(
    `SELECT
       t.*,
       ${settledSupportTicketColumnsSql("t")},
       assignee.email_normalized AS assignee_email,
       queue.name AS queue_name
     FROM phis.support_tickets t
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     LEFT JOIN phis.support_queues queue
       ON queue.id = t.queue_id
     WHERE t.site_id = $1
       AND t.id = $2
     LIMIT 1
     ${options.forUpdate ? "FOR UPDATE OF t" : ""}`,
    [siteId, ticketId],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }
  // A writer holding the lock writes down a window that ran out before it acts; a reader only shows it.
  if (options.forUpdate && row.settled_status !== row.status) {
    await settleSupportTicketWindowWithDb(queryable, row);
  }
  return settledSupportTicketRow(row);
}

/** The row with its status and close time as they stand now, which is what every caller works from. */
function settledSupportTicketRow(row: SupportTicketListRow): SupportTicketListRow {
  return { ...row, status: row.settled_status, closed_at: row.settled_closed_at };
}

async function getSupportTicketTaskRowById(
  queryable: DbQueryable,
  siteId: number,
  ticketId: number,
  taskId: number,
) {
  const { rows } = await queryable.query<SupportTicketTaskRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email
     FROM phis.support_ticket_tasks t
     JOIN phis.support_tickets ticket
       ON ticket.id = t.ticket_id
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     WHERE ticket.site_id = $1
       AND t.ticket_id = $2
       AND t.id = $3
     LIMIT 1`,
    [siteId, ticketId, taskId],
  );

  return rows[0] ?? null;
}

async function listSupportTicketTasksByTicketId(queryable: DbQueryable, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketTaskRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email
     FROM phis.support_ticket_tasks t
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     WHERE t.ticket_id = $1
     ORDER BY t.sort_order ASC, t.id ASC`,
    [ticketId],
  );

  return rows.map(mapSupportTicketTask);
}

export async function listSupportTicketsForSite(siteId: number, options: ListSupportTicketsOptions = {}) {
  const pool = getPool();
  const params: unknown[] = [siteId];
  const conditions: string[] = [`t.site_id = $1`];

  const search = normalizeSearch(options.search);
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    const searchIndex = params.length;
    conditions.push(
      `(
        lower(t.subject) LIKE $${searchIndex} ESCAPE '\\'
        OR lower(COALESCE(t.summary, '')) LIKE $${searchIndex} ESCAPE '\\'
        OR lower(COALESCE(t.requester_email, '')) LIKE $${searchIndex} ESCAPE '\\'
      )`,
    );
  }

  if (Number.isInteger(options.status)) {
    params.push(options.status);
    conditions.push(`${settledSupportTicketStatusSql("t")} = $${params.length}`);
  }

  if (Number.isInteger(options.channel)) {
    params.push(options.channel);
    conditions.push(`t.channel = $${params.length}`);
  }

  if (Number.isInteger(options.assigneeUserId)) {
    params.push(options.assigneeUserId);
    conditions.push(`t.assignee_user_id = $${params.length}`);
  }

  if (Number.isInteger(options.queueId)) {
    params.push(options.queueId);
    conditions.push(`t.queue_id = $${params.length}`);
  }

  const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 25) || 25));
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  const offset = (page - 1) * pageSize;
  params.push(pageSize, offset);

  const { rows } = await pool.query<SupportTicketListRow>(
    `WITH base AS (
       SELECT
         t.*,
         ${settledSupportTicketColumnsSql("t")},
         COUNT(*) OVER()::int AS total_count
       FROM phis.support_tickets t
       WHERE ${conditions.join(" AND ")}
     )
     SELECT
       base.*,
       assignee.email_normalized AS assignee_email,
       queue.name AS queue_name
     FROM base
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = base.assignee_user_id
     LEFT JOIN phis.support_queues queue
       ON queue.id = base.queue_id
     ORDER BY base.updated_at DESC, base.id DESC
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params,
  );

  return {
    rows: rows.map((row) => mapSupportTicket(settledSupportTicketRow(row))),
    total: rows[0]?.total_count ?? 0,
    page,
    pageSize,
  };
}

export type SupportQueueRecord = {
  id: number;
  siteId: number;
  groupId: number;
  key: string;
  name: string;
  flags: number;
  sortOrder: number;
  /** Set once the Site has retired the queue: nothing routes to it, and what stands in it still does. */
  retiredAt: string | null;
};

export async function listSupportQueues(siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    site_id: number;
    group_id: number;
    key: string;
    name: string;
    flags: number;
    sort_order: number;
    retired_at: string | null;
  }>(
    `SELECT id, site_id, group_id, key, name, flags, sort_order, retired_at
     FROM phis.support_queues
     WHERE site_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [siteId],
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    groupId: row.group_id,
    key: row.key,
    name: row.name,
    flags: row.flags,
    sortOrder: row.sort_order,
    retiredAt: row.retired_at,
  } satisfies SupportQueueRecord));
}

export async function getSupportQueueBySiteAndId(siteId: number, queueId: number) {
  const queues = await listSupportQueues(siteId);
  return queues.find((queue) => queue.id === queueId) ?? null;
}

/**
 * Whether somebody stands in the group a queue routes to.
 *
 * Queue membership is group membership -- there is no Support-owned membership table any more -- so
 * this asks the one place every other membership question is asked, retirement and expiry included.
 */
export async function isSupportQueueMember(siteId: number, queueId: number, userId: number) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `SELECT 1
     FROM phis.support_queues queue
     JOIN phis.site_groups grp
       ON grp.id = queue.group_id
     JOIN phis.site_group_members member
       ON member.group_id = queue.group_id
      AND member.site_id = queue.site_id
     WHERE queue.site_id = $1
       AND queue.id = $2
       AND member.user_id = $3
       AND grp.retired_at IS NULL
       AND (member.valid_until IS NULL OR member.valid_until > NOW())
     LIMIT 1`,
    [siteId, queueId, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function isSupportSiteUser(siteId: number, userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM phis.user_site_memberships
       WHERE user_id = $2
         AND site_id = $1
     ) AS exists`,
    [siteId, userId],
  );

  return rows[0]?.exists ?? false;
}

export async function applySupportTicketAssignmentAction(input: SupportTicketAssignmentActionInput) {
  const found = await withTransaction(async (client) => {
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId, {
      forUpdate: true,
    });
    if (!existing) {
      return false;
    }

    if (input.action === "assign_to_me") {
      if (existing.queue_id) {
        const member = await isSupportQueueMember(input.siteId, existing.queue_id, input.userId);
        if (!member) {
          throw new Error("You must belong to the assigned queue before claiming this ticket.");
        }
      }

      if (existing.assignee_user_id !== input.userId) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = $3,
               updated_by_user_id = $3,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: input.userId,
          fromQueueId: existing.queue_id,
          toQueueId: existing.queue_id,
          createdByUserId: input.userId,
          reason: "assign_to_me",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "assign_to_me",
            fromUserId: existing.assignee_user_id,
            toUserId: input.userId,
            queueId: existing.queue_id,
          },
        });
      }
    }

    if (input.action === "assign_to_user") {
      const targetUserExists = await isSupportSiteUser(input.siteId, input.targetUserId);
      if (!targetUserExists) {
        throw new Error("Target user is not available for this site.");
      }

      if (existing.queue_id) {
        const member = await isSupportQueueMember(input.siteId, existing.queue_id, input.targetUserId);
        if (!member) {
          throw new Error("Target user must belong to the assigned queue.");
        }
      }

      if (existing.assignee_user_id !== input.targetUserId) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = $3,
               updated_by_user_id = $4,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.targetUserId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: input.targetUserId,
          fromQueueId: existing.queue_id,
          toQueueId: existing.queue_id,
          createdByUserId: input.userId,
          reason: "assign_to_user",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "assign_to_user",
            fromUserId: existing.assignee_user_id,
            toUserId: input.targetUserId,
            queueId: existing.queue_id,
          },
        });
      }
    }

    if (input.action === "unassign") {
      if (existing.assignee_user_id !== null) {
        await client.query(
          `UPDATE phis.support_tickets
           SET assignee_user_id = NULL,
               updated_by_user_id = $3,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.userId],
        );

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: null,
          fromQueueId: existing.queue_id,
          toQueueId: existing.queue_id,
          createdByUserId: input.userId,
          reason: "unassign",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "unassign",
            fromUserId: existing.assignee_user_id,
            toUserId: null,
            queueId: existing.queue_id,
          },
        });
      }
    }

    if (input.action === "move_to_queue") {
      // Of this Site and still open for work; a retired queue takes nothing new.
      await assertSupportTicketReferencesOfSite(client, input.siteId, { queueId: input.queueId });

      if (existing.queue_id !== input.queueId || existing.assignee_user_id !== null) {
        await client.query(
          `UPDATE phis.support_tickets
           SET queue_id = $3,
               assignee_user_id = NULL,
               updated_by_user_id = $4,
               updated_at = NOW()
           WHERE site_id = $1
             AND id = $2`,
          [input.siteId, input.ticketId, input.queueId, input.userId],
        );
        if (existing.queue_id !== input.queueId) {
          await moveSupportThreadToQueueGroupWithDb(client, {
            threadId: existing.thread_id,
            fromQueueId: existing.queue_id,
            toQueueId: input.queueId,
          });
        }

        await insertSupportTicketAssignment(client, {
          ticketId: input.ticketId,
          fromUserId: existing.assignee_user_id,
          toUserId: null,
          fromQueueId: existing.queue_id,
          toQueueId: input.queueId,
          createdByUserId: input.userId,
          reason: "move_to_queue",
        });

        await insertSupportTicketEvent(client, {
          ticketId: input.ticketId,
          eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
          createdByUserId: input.userId,
          payload: {
            action: "move_to_queue",
            fromUserId: existing.assignee_user_id,
            toUserId: null,
            fromQueueId: existing.queue_id,
            toQueueId: input.queueId,
          },
        });
      }
    }

    const nextStatus = supportTicketStatusAfterHandover(
      existing.status,
      input.action === "move_to_queue"
        ? "moved"
        : input.action === "unassign"
          ? "released"
          : "taken",
    );
    const handedOver = input.action === "unassign"
      ? existing.assignee_user_id !== null
      : input.action === "move_to_queue"
        ? existing.queue_id !== input.queueId || existing.assignee_user_id !== null
        : true;
    if (nextStatus != null && handedOver) {
      await moveSupportTicketStatusWithDb(client, {
        ticketId: input.ticketId,
        from: existing.status,
        to: nextStatus,
        byUserId: input.userId,
      });
    }

    return true;
  });
  if (!found) {
    return null;
  }
  return getSupportTicketDetail(input.siteId, input.ticketId);
}

export async function getSupportTicketDetail(siteId: number, ticketId: number) {
  const pool = getPool();
  const ticketRow = await getSupportTicketRowById(pool, siteId, ticketId);
  if (!ticketRow) {
    return null;
  }

  const tasks = await listSupportTicketTasksByTicketId(pool, ticketId);

  return {
    ticket: mapSupportTicket(ticketRow),
    tasks,
  } satisfies SupportTicketDetailRecord;
}

export async function createSupportTicket(input: CreateSupportTicketInput) {
  const createdTicketId = await withTransaction(async (client) => {
    /*
     * Where this ticket lands, and the group that therefore sees it.
     *
     * An unrouted ticket is a ticket nobody is looking at, so a queue is required rather than defaulted
     * to whatever happens to exist: either the caller names one, or the Site has marked one as where
     * work arrives. Its group is what makes the ticket's thread visible to Support at all.
     */
    const queueRows = await client.query<{ id: number; group_id: number }>(
      input.queueId != null
        ? `SELECT id, group_id FROM phis.support_queues
           WHERE site_id = $1 AND id = $2 AND retired_at IS NULL`
        : `SELECT id, group_id
           FROM phis.support_queues
           WHERE site_id = $1
             AND (flags & ${PhisSupportQueueFlag.Entry}) <> 0
           ORDER BY sort_order ASC, id ASC
           LIMIT 1`,
      input.queueId != null ? [input.siteId, input.queueId] : [input.siteId],
    );
    const queue = queueRows.rows[0];
    if (!queue) {
      throw new Error("No Support queue to route this ticket to.");
    }

    /*
     * Spent before the thread exists, and inside the same transaction.
     *
     * Refusing after the conversation has been opened would leave a thread nobody can reach behind every
     * refusal, and the rollback that undoes it is the same rollback that would have to put the request
     * back if the insert failed later. One transaction answers both.
     */
    let allowanceGrantId: number | null = null;
    if (input.enforceRequesterAllowance && input.requesterUserId != null) {
      const spent = await consumeSupportAllowanceWithDb(client, {
        siteId: input.siteId,
        userId: input.requesterUserId,
        typeId: input.typeId,
        selfServiceChannel: SUPPORT_TICKET_CHANNEL_PORTAL,
      });
      allowanceGrantId = spent.grantId;
    }

    // Opened already in somebody's hands is opened assigned, as taking it a moment later would have left it.
    const initialStatus = input.status ?? (input.assigneeUserId != null ? SUPPORT_TICKET_STATUS_ASSIGNED : SUPPORT_TICKET_STATUS_NEW);

    const thread = await createThreadWithDb(client, {
      siteId: input.siteId,
      kind: PhisThreadKind.Support,
      subject: input.subject,
      message: input.message,
      messageMarkdown: input.messageMarkdown ?? null,
      participantUserIds: input.requesterUserId ? [input.requesterUserId] : [],
      participantGroupIds: [queue.group_id],
      requesterUserId: input.requesterUserId ?? null,
      createdByUserId: input.createdByUserId ?? input.requesterUserId ?? null,
      ownerProviderId: input.ownerProviderId ?? null,
      externalRef: input.externalRef ?? null,
      requesterExternalConsent: input.requesterExternalConsent ?? false,
    });

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_tickets (
         site_id,
         type_id,
         thread_id,
         status,
         channel,
         priority,
         severity,
         flags,
         requester_user_id,
         requester_email,
         assignee_user_id,
         queue_id,
         allowance_grant_id,
         subject,
         summary,
         meta,
         first_response_due_at,
         resolution_due_at,
         created_by_user_id,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $19, $13, $14, $15::jsonb, $16, $17, $18, $18)
       RETURNING id`,
      [
        input.siteId,
        input.typeId,
        thread.id,
        initialStatus,
        input.channel,
        input.priority ?? SUPPORT_TICKET_PRIORITY_NORMAL,
        input.severity ?? null,
        input.flags ?? 0,
        input.requesterUserId ?? null,
        input.requesterEmail ?? null,
        input.assigneeUserId ?? null,
        queue.id,
        input.subject,
        input.summary ?? null,
        JSON.stringify(input.meta ?? {}),
        input.firstResponseDueAt ?? null,
        input.resolutionDueAt ?? null,
        input.createdByUserId ?? null,
        allowanceGrantId,
      ],
    );

    const ticketId = rows[0]?.id;
    if (!ticketId) {
      throw new Error("Failed to create support ticket.");
    }

    if (input.assigneeUserId || queue.id) {
      await insertSupportTicketAssignment(client, {
        ticketId,
        toUserId: input.assigneeUserId ?? null,
        toQueueId: queue.id,
        createdByUserId: input.createdByUserId ?? null,
        reason: "initial_assignment",
      });
    }

    await insertSupportTicketEvent(client, {
      ticketId,
      eventType: SUPPORT_TICKET_EVENT_CREATED,
      createdByUserId: input.createdByUserId ?? null,
      payload: {
        status: initialStatus,
        assigneeUserId: input.assigneeUserId ?? null,
        queueId: queue.id,
      },
    });

    return ticketId;
  });
  return getSupportTicketDetail(input.siteId, createdTicketId);
}

/**
 * Hands a ticket's thread from one queue's group to the other's.
 *
 * The queue's group is the thread participant through which its Supporters read and answer. A move that
 * only changed `queue_id` left the old group in the conversation and kept the new one out of it.
 */
async function moveSupportThreadToQueueGroupWithDb(
  db: DbQueryable,
  input: { threadId: number; fromQueueId: number | null; toQueueId: number | null },
) {
  const { rows } = await db.query<{ id: number; group_id: number }>(
    `SELECT id, group_id FROM phis.support_queues WHERE id = ANY($1::int[])`,
    [[input.fromQueueId, input.toQueueId].filter((id): id is number => id != null)],
  );
  const fromGroupId = rows.find((row) => row.id === input.fromQueueId)?.group_id ?? null;
  const toGroupId = rows.find((row) => row.id === input.toQueueId)?.group_id ?? null;
  if (fromGroupId === toGroupId) return;
  if (fromGroupId != null) {
    await db.query(
      `DELETE FROM phis.thread_participants WHERE thread_id = $1 AND group_id = $2`,
      [input.threadId, fromGroupId],
    );
  }
  if (toGroupId == null) return;
  await db.query(
    `INSERT INTO phis.thread_participants (thread_id, participant_kind, group_id, flags)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT DO NOTHING`,
    [input.threadId, PHIS_THREAD_PARTICIPANT_KIND_GROUP, toGroupId],
  );
}

/**
 * What a ticket write may point at: this Site's queues and types, and this Site's members.
 *
 * `support_queues.id` and `support_ticket_types.id` are keyed without a Site component, and a user id
 * is global, so a `queueId` or `assigneeUserId` from the body reached the row unasked: a Supporter on
 * one Site could file a ticket under another Site's queue, and the answer then showed that queue's
 * name. A retired queue or type is not offered either -- retirement replaces deletion here, and nothing
 * new is routed to what has ended.
 */
async function assertSupportTicketReferencesOfSite(
  db: DbQueryable,
  siteId: number,
  refs: {
    queueId?: number | null;
    typeId?: number | null;
    assigneeUserId?: number | null;
    requesterUserId?: number | null;
  },
) {
  if (refs.queueId != null) {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM phis.support_queues WHERE site_id = $1 AND id = $2 AND retired_at IS NULL`,
      [siteId, refs.queueId],
    );
    if (rows.length === 0) throw new SupportAdministrationError("This Site has no such queue.");
  }
  if (refs.typeId != null) {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM phis.support_ticket_types WHERE site_id = $1 AND id = $2 AND retired_at IS NULL`,
      [siteId, refs.typeId],
    );
    if (rows.length === 0) throw new SupportAdministrationError("This Site has no such ticket type.");
  }
  const people = [refs.assigneeUserId, refs.requesterUserId]
    .filter((userId): userId is number => userId != null);
  if (people.length > 0) {
    const { rows } = await db.query<{ user_id: number }>(
      `SELECT user_id FROM phis.user_site_memberships WHERE site_id = $1 AND user_id = ANY($2::int[])`,
      [siteId, [...new Set(people)]],
    );
    if (rows.length !== new Set(people).size) {
      throw new SupportAdministrationError("One or more of these people are not members of this Site.");
    }
  }
}

export async function updateSupportTicket(input: UpdateSupportTicketInput) {
  const found = await withTransaction(async (client) => {
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId, {
      forUpdate: true,
    });
    if (!existing) {
      return false;
    }

    await assertSupportTicketReferencesOfSite(client, input.siteId, {
      queueId: input.queueId,
      typeId: input.typeId,
      assigneeUserId: input.assigneeUserId,
      requesterUserId: input.requesterUserId,
    });

    const sets: string[] = [];
    const params: unknown[] = [input.siteId, input.ticketId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.typeId === "number") addSet("type_id", input.typeId);
    if (typeof input.channel === "number") addSet("channel", input.channel);
    if (typeof input.priority === "number") addSet("priority", input.priority);
    if (input.severity !== undefined) addSet("severity", input.severity ?? null);
    if (input.requesterUserId !== undefined) addSet("requester_user_id", input.requesterUserId ?? null);
    if (input.requesterEmail !== undefined) addSet("requester_email", input.requesterEmail ?? null);
    if (input.assigneeUserId !== undefined) addSet("assignee_user_id", input.assigneeUserId ?? null);
    if (input.queueId !== undefined) addSet("queue_id", input.queueId ?? null);
    if (typeof input.subject === "string") addSet("subject", input.subject);
    if (input.summary !== undefined) addSet("summary", input.summary ?? null);
    if (input.meta !== undefined) {
      params.push(JSON.stringify(input.meta ?? {}));
      sets.push(`meta = $${params.length}::jsonb`);
    }
    if (input.firstResponseDueAt !== undefined) addSet("first_response_due_at", input.firstResponseDueAt ?? null);
    if (input.resolutionDueAt !== undefined) addSet("resolution_due_at", input.resolutionDueAt ?? null);
    addSet("updated_by_user_id", input.updatedByUserId ?? null);
    sets.push("updated_at = NOW()");

    await client.query(
      `UPDATE phis.support_tickets
       SET ${sets.join(", ")}
       WHERE site_id = $1
         AND id = $2`,
      params,
    );
    if (input.queueId !== undefined && (input.queueId ?? null) !== existing.queue_id) {
      await moveSupportThreadToQueueGroupWithDb(client, {
        threadId: existing.thread_id,
        fromQueueId: existing.queue_id,
        toQueueId: input.queueId ?? null,
      });
    }

    const assigneeChanged =
      (input.assigneeUserId !== undefined && (input.assigneeUserId ?? null) !== existing.assignee_user_id) ||
      (input.queueId !== undefined && (input.queueId ?? null) !== existing.queue_id);
    if (assigneeChanged) {
      await insertSupportTicketAssignment(client, {
        ticketId: input.ticketId,
        fromUserId: existing.assignee_user_id,
        toUserId: input.assigneeUserId !== undefined ? (input.assigneeUserId ?? null) : existing.assignee_user_id,
        fromQueueId: existing.queue_id,
        toQueueId: input.queueId !== undefined ? (input.queueId ?? null) : existing.queue_id,
        createdByUserId: input.updatedByUserId ?? null,
        reason: "ticket_update",
      });
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType: SUPPORT_TICKET_EVENT_ASSIGNED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          fromUserId: existing.assignee_user_id,
          toUserId: input.assigneeUserId !== undefined ? (input.assigneeUserId ?? null) : existing.assignee_user_id,
          fromQueueId: existing.queue_id,
          toQueueId: input.queueId !== undefined ? (input.queueId ?? null) : existing.queue_id,
        },
      });
    }

    /*
     * A status somebody set wins; without one, a change of hands moves the ticket the way taking or
     * putting it down does. The status is written by the move alone, which stamps `resolved_at` and
     * `closed_at` -- they are what the move did, not fields a caller supplies.
     */
    const assigneeAfter = input.assigneeUserId !== undefined ? (input.assigneeUserId ?? null) : existing.assignee_user_id;
    const nextStatus = typeof input.status === "number"
      ? input.status as PhisSupportTicketStatusValue
      : input.queueId !== undefined && (input.queueId ?? null) !== existing.queue_id
        ? supportTicketStatusAfterHandover(existing.status, "moved")
        : assigneeAfter !== existing.assignee_user_id
          ? supportTicketStatusAfterHandover(existing.status, assigneeAfter == null ? "released" : "taken")
          : null;
    if (nextStatus != null) {
      await moveSupportTicketStatusWithDb(client, {
        ticketId: input.ticketId,
        from: existing.status,
        to: nextStatus,
        byUserId: input.updatedByUserId ?? null,
      });
    }

    return true;
  });
  if (!found) {
    return null;
  }
  return getSupportTicketDetail(input.siteId, input.ticketId);
}

export async function addSupportTicketTask(input: AddSupportTicketTaskInput) {
  const found = await withTransaction(async (client) => {
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      return false;
    }

    await assertSupportTicketReferencesOfSite(client, input.siteId, { assigneeUserId: input.assigneeUserId });

    const nextSortOrder =
      typeof input.sortOrder === "number"
        ? input.sortOrder
        : (
            await client.query<{ next_sort_order: number }>(
              `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
               FROM phis.support_ticket_tasks
               WHERE ticket_id = $1`,
              [input.ticketId],
            )
          ).rows[0]?.next_sort_order ?? 0;

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_tasks (
         ticket_id,
         type,
         status,
         flags,
         sort_order,
         assignee_user_id,
         title,
         description,
         meta,
         due_at,
         completed_at,
         created_by_user_id,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $12)
       RETURNING id`,
      [
        input.ticketId,
        input.type ?? SUPPORT_TICKET_TASK_TYPE_INTERNAL,
        input.status ?? SUPPORT_TICKET_TASK_STATUS_OPEN,
        input.flags ?? 0,
        nextSortOrder,
        input.assigneeUserId ?? null,
        input.title,
        input.description ?? null,
        JSON.stringify(input.meta ?? {}),
        input.dueAt ?? null,
        input.completedAt ?? null,
        input.createdByUserId ?? null,
      ],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.createdByUserId ?? null],
    );

    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_TASK_CREATED,
      createdByUserId: input.createdByUserId ?? null,
      payload: { taskId: rows[0]?.id ?? null },
    });

    return true;
  });
  if (!found) {
    return null;
  }
  return getSupportTicketDetail(input.siteId, input.ticketId);
}

export async function updateSupportTicketTask(input: UpdateSupportTicketTaskInput) {
  const found = await withTransaction(async (client) => {
    const existing = await getSupportTicketTaskRowById(client, input.siteId, input.ticketId, input.taskId);
    if (!existing) {
      return false;
    }
    await assertSupportTicketReferencesOfSite(client, input.siteId, { assigneeUserId: input.assigneeUserId });

    const sets: string[] = [];
    const params: unknown[] = [input.taskId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.type === "number") addSet("type", input.type);
    if (typeof input.status === "number") addSet("status", input.status);
    if (typeof input.flags === "number") addSet("flags", input.flags);
    if (typeof input.sortOrder === "number") addSet("sort_order", input.sortOrder);
    if (input.assigneeUserId !== undefined) addSet("assignee_user_id", input.assigneeUserId ?? null);
    if (typeof input.title === "string") addSet("title", input.title);
    if (input.description !== undefined) addSet("description", input.description ?? null);
    if (input.meta !== undefined) {
      params.push(JSON.stringify(input.meta ?? {}));
      sets.push(`meta = $${params.length}::jsonb`);
    }
    if (input.dueAt !== undefined) addSet("due_at", input.dueAt ?? null);
    if (input.completedAt !== undefined) addSet("completed_at", input.completedAt ?? null);
    addSet("updated_by_user_id", input.updatedByUserId ?? null);
    sets.push("updated_at = NOW()");

    await client.query(
      `UPDATE phis.support_ticket_tasks
       SET ${sets.join(", ")}
       WHERE id = $1`,
      params,
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [input.siteId, input.ticketId, input.updatedByUserId ?? null],
    );

    if (typeof input.status === "number" && input.status !== existing.status) {
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType:
          input.status === SUPPORT_TICKET_TASK_STATUS_DONE
            ? SUPPORT_TICKET_EVENT_TASK_COMPLETED
            : SUPPORT_TICKET_EVENT_TASK_REOPENED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          taskId: input.taskId,
          fromStatus: existing.status,
          toStatus: input.status,
        },
      });
      const finished = (status: number) =>
        status === SUPPORT_TICKET_TASK_STATUS_DONE || status === SUPPORT_TICKET_TASK_STATUS_CANCELED;
      if (finished(input.status) !== finished(existing.status)) {
        await followSupportTicketTasksWithDb(client, {
          ticketId: input.ticketId,
          taskWasReopened: !finished(input.status),
          byUserId: input.updatedByUserId ?? null,
        });
      }
    }

    return true;
  });
  if (!found) {
    return null;
  }
  return getSupportTicketDetail(input.siteId, input.ticketId);
}

export async function deleteSupportTicketTask(siteId: number, ticketId: number, taskId: number, userId?: number | null) {
  const found = await withTransaction(async (client) => {
    const existing = await getSupportTicketTaskRowById(client, siteId, ticketId, taskId);
    if (!existing) {
      return false;
    }

    await client.query(
      `DELETE FROM phis.support_ticket_tasks
       WHERE id = $1`,
      [taskId],
    );

    await client.query(
      `UPDATE phis.support_tickets
       SET updated_at = NOW(),
           updated_by_user_id = $3
       WHERE site_id = $1
         AND id = $2`,
      [siteId, ticketId, userId ?? null],
    );

    return true;
  });
  if (!found) {
    return null;
  }
  return getSupportTicketDetail(siteId, ticketId);
}

/**
 * One ticket with the type it was opened under, for a caller that has to decide from the type.
 *
 * The type is joined rather than looked up afterwards because what an integration decides -- whether
 * anything may leave the Site, and what ends the ticket -- it decides from the flags and the close
 * policy. Two calls to learn one thing is two chances for them to disagree.
 */
export type SupportTicketWithTypeRecord = {
  id: number;
  threadId: number;
  subject: string;
  status: number;
  queueId: number | null;
  typeId: number;
  typeKey: string;
  typeFlags: number;
  typeClosePolicy: number;
  createdAt: string;
  updatedAt: string;
};

const TICKET_WITH_TYPE_SQL = `
  SELECT ticket.id,
         ticket.thread_id,
         ticket.subject,
         ${settledSupportTicketStatusSql("ticket")} AS status,
         ticket.queue_id,
         ticket.type_id,
         type.key AS type_key,
         type.flags AS type_flags,
         type.close_policy AS type_close_policy,
         ticket.created_at,
         ticket.updated_at
  FROM phis.support_tickets ticket
  JOIN phis.support_ticket_types type
    ON type.id = ticket.type_id AND type.site_id = ticket.site_id`;

type TicketWithTypeRow = {
  id: number;
  thread_id: number;
  subject: string;
  status: number;
  queue_id: number | null;
  type_id: number;
  type_key: string;
  type_flags: number;
  type_close_policy: number;
  created_at: string;
  updated_at: string;
};

function mapTicketWithType(row: TicketWithTypeRow): SupportTicketWithTypeRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    subject: row.subject,
    status: row.status,
    queueId: row.queue_id,
    typeId: row.type_id,
    typeKey: row.type_key,
    typeFlags: row.type_flags,
    typeClosePolicy: row.type_close_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSupportTicketWithType(siteId: number, ticketId: number) {
  const { rows } = await getPool().query<TicketWithTypeRow>(
    `${TICKET_WITH_TYPE_SQL} WHERE ticket.site_id = $1 AND ticket.id = $2`,
    [siteId, ticketId],
  );
  return rows[0] ? mapTicketWithType(rows[0]) : null;
}

/** The ticket a thread carries, for an event that arrived naming the conversation and not the record. */
export async function findSupportTicketByThread(siteId: number, threadId: number) {
  const { rows } = await getPool().query<TicketWithTypeRow>(
    `${TICKET_WITH_TYPE_SQL} WHERE ticket.site_id = $1 AND ticket.thread_id = $2`,
    [siteId, threadId],
  );
  return rows[0] ? mapTicketWithType(rows[0]) : null;
}

/**
 * A type or a queue by the key the Site knows it as.
 *
 * By key and never by id, because an id means nothing in an Add-on's configuration and would not
 * survive the Site being rebuilt. A retired row answers nothing: it is still named by the tickets that
 * already carry it, and it is offered to nothing new.
 */
export async function getSupportTicketTypeIdByKey(siteId: number, key: string) {
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT id FROM phis.support_ticket_types
     WHERE site_id = $1 AND key = $2 AND retired_at IS NULL`,
    [siteId, key],
  );
  return rows[0]?.id ?? null;
}

export async function getSupportQueueIdByKey(siteId: number, key: string) {
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT id FROM phis.support_queues
     WHERE site_id = $1 AND key = $2 AND retired_at IS NULL`,
    [siteId, key],
  );
  return rows[0]?.id ?? null;
}

/** The ticket one task belongs to, so a task id can be checked against the same reach as its ticket. */
export async function getSupportTicketIdForTask(siteId: number, taskId: number) {
  const { rows } = await getPool().query<{ ticket_id: number }>(
    `SELECT task.ticket_id
     FROM phis.support_ticket_tasks task
     JOIN phis.support_tickets ticket ON ticket.id = task.ticket_id
     WHERE ticket.site_id = $1 AND task.id = $2`,
    [siteId, taskId],
  );
  return rows[0]?.ticket_id ?? null;
}

/**
 * Administering the Site's queues and ticket types.
 *
 * A key is never among what these change. It is what a Module's declared seed finds its own rows by
 * ([design/SUPPORT.md](../../design/SUPPORT.md) section 4), so renaming one would not rename a row --
 * it would make the next publish create a second one beside it. The name is what a Site calls the
 * thing, and that is editable; the key is what the machinery calls it, and it is not.
 *
 * Retirement replaces deletion throughout, as it does for groups. Tickets already routed to a queue or
 * opened under a type keep naming it, and nothing new is offered either.
 */

export class SupportAdministrationError extends Error {}

export type SupportTicketTypeRecord = {
  id: number;
  siteId: number;
  key: string;
  name: string;
  flags: number;
  closePolicy: number;
  requesterWindowDays: number | null;
  /** How many of this type one person may open for themselves per period; `null` is no limit. */
  requesterAllowance: { limit: number; period: PhisSupportAllowancePeriodValue } | null;
  /** Where a forward of this type's work goes unless the Supporter chooses otherwise; null is none. */
  forwardTarget: string | null;
  sortOrder: number;
  retiredAt: string | null;
};

export async function listSupportTicketTypes(siteId: number) {
  const { rows } = await getPool().query<{
    id: number;
    site_id: number;
    key: string;
    name: string;
    flags: number;
    close_policy: number;
    requester_window_days: number | null;
    requester_allowance: number | null;
    requester_allowance_period: number;
    forward_target: string | null;
    sort_order: number;
    retired_at: string | null;
  }>(
    `SELECT id, site_id, key, name, flags, close_policy, requester_window_days,
            requester_allowance, requester_allowance_period, forward_target, sort_order, retired_at
     FROM phis.support_ticket_types
     WHERE site_id = $1
     ORDER BY sort_order ASC, id ASC`,
    [siteId],
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    name: row.name,
    flags: row.flags,
    closePolicy: row.close_policy,
    requesterWindowDays: row.requester_window_days,
    // The pair as it is stored. Whoever administers the catalogue is the one who set it, and a listing
    // that showed the count without the period would not say five of what.
    requesterAllowance: row.requester_allowance == null ? null : {
      limit: row.requester_allowance,
      period: row.requester_allowance_period as PhisSupportAllowancePeriodValue,
    },
    forwardTarget: row.forward_target,
    sortOrder: row.sort_order,
    retiredAt: row.retired_at,
  } satisfies SupportTicketTypeRecord));
}

/**
 * Leaves exactly one queue marked as where unrouted work arrives.
 *
 * The flag decides a routing question that has one answer, and the read that resolves it takes the
 * first row it finds -- so two queues carrying it is not a richer configuration, it is a Site whose
 * routing depends on `sort_order`. Clearing the others is done in the same transaction as setting this
 * one, because a moment with none would refuse every ticket arriving in it.
 */
async function moveEntryFlagWithDb(client: PoolClient, siteId: number, queueId: number) {
  await client.query(
    `UPDATE phis.support_queues
     SET flags = flags & ~${PhisSupportQueueFlag.Entry}, updated_at = NOW()
     WHERE site_id = $1 AND id <> $2 AND (flags & ${PhisSupportQueueFlag.Entry}) <> 0`,
    [siteId, queueId],
  );
}

export async function createSupportQueue(input: {
  siteId: number;
  groupId: number;
  key: string;
  name: string;
  flags?: number;
  sortOrder?: number;
}) {
  return withTransaction(async (client) => {
    // The group is the Site's, and a retired one routes nowhere -- so a queue may not be pointed at it.
    const { rows: groups } = await client.query<{ id: number }>(
      `SELECT id FROM phis.site_groups
       WHERE site_id = $1 AND id = $2 AND retired_at IS NULL`,
      [input.siteId, input.groupId],
    );
    if (!groups[0]) {
      throw new SupportAdministrationError("A queue routes to a group this Site does not have.");
    }
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_id, key) DO NOTHING
       RETURNING id`,
      [
        input.siteId,
        input.groupId,
        input.key,
        input.name,
        input.flags ?? 0,
        input.sortOrder ?? 0,
      ],
    );
    if (!rows[0]) {
      throw new SupportAdministrationError(`This Site already has a queue keyed "${input.key}".`);
    }
    if (((input.flags ?? 0) & PhisSupportQueueFlag.Entry) !== 0) {
      await moveEntryFlagWithDb(client, input.siteId, rows[0].id);
    }
    return rows[0].id;
  });
}

export async function updateSupportQueue(input: {
  siteId: number;
  queueId: number;
  groupId?: number;
  name?: string;
  flags?: number;
  sortOrder?: number;
  retired?: boolean;
}) {
  await withTransaction(async (client) => {
    const { rows: existing } = await client.query<{ flags: number; retired_at: string | null }>(
      `SELECT flags, retired_at FROM phis.support_queues
       WHERE site_id = $1 AND id = $2 FOR UPDATE`,
      [input.siteId, input.queueId],
    );
    if (!existing[0]) {
      throw new SupportAdministrationError("This Site has no such queue.");
    }
    const flags = input.flags ?? existing[0].flags;
    const retired = input.retired ?? existing[0].retired_at != null;

    /*
     * A Site without an entry queue refuses every ticket that names none, which is every ticket a
     * requester opens. Retiring the one that carries the flag, or taking the flag off it without
     * putting it anywhere, is therefore refused here rather than discovered by the next customer.
     */
    if ((flags & PhisSupportQueueFlag.Entry) !== 0 && retired) {
      throw new SupportAdministrationError(
        "The entry queue cannot be retired; mark another queue as the entry queue first.",
      );
    }
    if ((existing[0].flags & PhisSupportQueueFlag.Entry) !== 0
      && (flags & PhisSupportQueueFlag.Entry) === 0) {
      throw new SupportAdministrationError(
        "A Site needs an entry queue; mark another queue as the entry queue instead of clearing this one.",
      );
    }

    if (input.groupId != null) {
      const { rows: groups } = await client.query<{ id: number }>(
        `SELECT id FROM phis.site_groups
         WHERE site_id = $1 AND id = $2 AND retired_at IS NULL`,
        [input.siteId, input.groupId],
      );
      if (!groups[0]) {
        throw new SupportAdministrationError("A queue routes to a group this Site does not have.");
      }
    }

    await client.query(
      `UPDATE phis.support_queues
       SET group_id = COALESCE($3, group_id),
           name = COALESCE($4, name),
           flags = $5,
           sort_order = COALESCE($6, sort_order),
           retired_at = CASE WHEN $7::boolean THEN COALESCE(retired_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE site_id = $1 AND id = $2`,
      [
        input.siteId,
        input.queueId,
        input.groupId ?? null,
        input.name ?? null,
        flags,
        input.sortOrder ?? null,
        retired,
      ],
    );
    if ((flags & PhisSupportQueueFlag.Entry) !== 0) {
      await moveEntryFlagWithDb(client, input.siteId, input.queueId);
    }
  });
}

export async function createSupportTicketType(input: {
  siteId: number;
  key: string;
  name: string;
  flags?: number;
  closePolicy?: number;
  requesterWindowDays?: number | null;
  /**
   * How many of this type one person may open for themselves per period. Absent is no limit.
   *
   * One field for both halves rather than two, because they are one statement: a count without a period
   * does not say five of what, and a period without a count limits nothing while looking as though it
   * does. The schema refuses the half-written pair either way; this is what keeps a caller from having
   * to find that out.
   */
  requesterAllowance?: { limit: number; period: PhisSupportAllowancePeriodValue } | null;
  sortOrder?: number;
}) {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types
       (site_id, key, name, flags, close_policy, requester_window_days,
        requester_allowance, requester_allowance_period, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (site_id, key) DO NOTHING
     RETURNING id`,
    [
      input.siteId,
      input.key,
      input.name,
      input.flags ?? 0,
      input.closePolicy ?? 0,
      input.requesterWindowDays ?? null,
      input.requesterAllowance?.limit ?? null,
      input.requesterAllowance?.period ?? PhisSupportAllowancePeriod.None,
      input.sortOrder ?? 0,
    ],
  );
  if (!rows[0]) {
    throw new SupportAdministrationError(`This Site already has a ticket type keyed "${input.key}".`);
  }
  return rows[0].id;
}

export async function updateSupportTicketType(input: {
  siteId: number;
  typeId: number;
  name?: string;
  flags?: number;
  closePolicy?: number;
  requesterWindowDays?: number | null;
  /** Absent leaves it as it was; `null` removes the limit. See `createSupportTicketType`. */
  requesterAllowance?: { limit: number; period: PhisSupportAllowancePeriodValue } | null;
  /** Absent leaves it as it was; `null` removes the preselection. */
  forwardTarget?: string | null;
  sortOrder?: number;
  retired?: boolean;
}) {
  const { rowCount } = await getPool().query(
    `UPDATE phis.support_ticket_types
     SET name = COALESCE($3, name),
         flags = COALESCE($4, flags),
         close_policy = COALESCE($5, close_policy),
         requester_window_days = CASE WHEN $6::boolean THEN $7::smallint ELSE requester_window_days END,
         -- Both halves move on the one flag, so the pair the CHECK insists on cannot be written apart.
         requester_allowance = CASE WHEN $10::boolean THEN $11::smallint ELSE requester_allowance END,
         requester_allowance_period = CASE
           WHEN $10::boolean THEN $12::smallint ELSE requester_allowance_period
         END,
         forward_target = CASE WHEN $13::boolean THEN $14::varchar ELSE forward_target END,
         sort_order = COALESCE($8, sort_order),
         retired_at = CASE
           WHEN $9::boolean IS NULL THEN retired_at
           WHEN $9::boolean THEN COALESCE(retired_at, NOW())
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE site_id = $1 AND id = $2`,
    [
      input.siteId,
      input.typeId,
      input.name ?? null,
      input.flags ?? null,
      input.closePolicy ?? null,
      input.requesterWindowDays !== undefined,
      input.requesterWindowDays ?? null,
      input.sortOrder ?? null,
      input.retired ?? null,
      input.requesterAllowance !== undefined,
      input.requesterAllowance?.limit ?? null,
      input.requesterAllowance?.period ?? PhisSupportAllowancePeriod.None,
      input.forwardTarget !== undefined,
      input.forwardTarget ?? null,
    ],
  );
  if (!rowCount) {
    throw new SupportAdministrationError("This Site has no such ticket type.");
  }
}

/**
 * The ticket types a requester may choose, and nothing else about them.
 *
 * A narrower answer than the Staff catalogue and not a filtered view of it: a requester is told the key,
 * the name, and whether the conversation leaves the Site. What ends the ticket, how long the requester
 * window is, and what order Staff keeps the catalogue in are answers about how the work will be run.
 *
 * Retired types are absent, and so is every type without `Requestable` -- which is every type a Site has
 * not yet looked at, because the flag is off on anything a Module's seed brought with it.
 */
export type RequestableSupportTicketType = {
  key: string;
  name: string;
  /** The conversation of a ticket of this type is mirrored to a linked external system. */
  external: boolean;
  /**
   * What this person has left of it, or `null` where the type has no limit.
   *
   * Carried here because a refusal after somebody has written their request is a refusal at the worst
   * possible moment. What ends the ticket and how long the requester window is stay out of this listing
   * for the reason above; how many they may still ask for is not an answer about how the work will be
   * run, it is the only thing on this list they can act on.
   */
  allowance: PhisSupportAllowance | null;
};

export async function listRequestableSupportTicketTypes(siteId: number, userId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    key: string;
    name: string;
    flags: number;
    requester_allowance: number | null;
    requester_allowance_period: number;
  }>(
    `SELECT id, key, name, flags, requester_allowance, requester_allowance_period
     FROM phis.support_ticket_types
     WHERE site_id = $1
       AND retired_at IS NULL
       AND (flags & ${PhisSupportTicketTypeFlag.Requestable}) <> 0
     ORDER BY sort_order ASC, id ASC`,
    [siteId],
  );

  /*
   * One read per limited type, and deliberately not one statement for all of them.
   *
   * The list is a handful of rows -- what a Site offers the public, not what it has -- and the statement
   * that answered them together would be a second copy of the arithmetic the request route refuses by.
   * Two copies of that is how somebody gets told they have one left and is then turned away.
   */
  return Promise.all(rows.map(async (row) => ({
    key: row.key,
    name: row.name,
    external: (row.flags & PhisSupportTicketTypeFlag.External) !== 0,
    allowance: row.requester_allowance == null ? null : await readSupportAllowance(pool, {
      siteId,
      userId,
      selfServiceChannel: SUPPORT_TICKET_CHANNEL_PORTAL,
      type: row,
    }),
  } satisfies RequestableSupportTicketType)));
}

/** One requestable type by key, for the route that has to check what it was handed. */
export async function getRequestableSupportTicketType(siteId: number, key: string) {
  const { rows } = await getPool().query<{ id: number; flags: number }>(
    `SELECT id, flags
     FROM phis.support_ticket_types
     WHERE site_id = $1
       AND key = $2
       AND retired_at IS NULL
       AND (flags & ${PhisSupportTicketTypeFlag.Requestable}) <> 0`,
    [siteId, key],
  );
  return rows[0]
    ? { id: rows[0].id, external: (rows[0].flags & PhisSupportTicketTypeFlag.External) !== 0 }
    : null;
}

/** Whether the Site has somewhere for a ticket that names no queue to land. */
export async function hasSupportEntryQueue(siteId: number) {
  const { rows } = await getPool().query<{ id: number }>(
    `SELECT id FROM phis.support_queues
     WHERE site_id = $1
       AND retired_at IS NULL
       AND (flags & ${PhisSupportQueueFlag.Entry}) <> 0
     LIMIT 1`,
    [siteId],
  );
  return rows.length > 0;
}

/**
 * How long a resolved ticket waits for its requester on this Site, in days, where its type says nothing.
 *
 * The Site's half of the requester window (`support-requester-window.mts`). `0` switches automatic
 * closing off for every type at once. Stored on `site_thread_config`, whose row the thread kinds
 * materialization owns too: this writes the window and leaves the kinds as they are, and a Site that
 * has no row yet gets one offering no kind until its next publish says otherwise.
 */
export async function setSupportRequesterWindowDays(siteId: number, days: number) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new SupportAdministrationError("A requester window is a whole number of days from 0 to 3650.");
  }
  await getPool().query(
    `INSERT INTO phis.site_thread_config (site_id, flags, requester_window_days)
     VALUES ($1, 0, $2)
     ON CONFLICT (site_id) DO UPDATE
     SET requester_window_days = EXCLUDED.requester_window_days,
         updated_at = NOW()
     WHERE phis.site_thread_config.requester_window_days IS DISTINCT FROM EXCLUDED.requester_window_days`,
    [siteId, days],
  );
}

/**
 * What a forward may tell the system the work goes to, read in one place so the rule is one rule.
 *
 * `mirror` is the type's `External`. The opening text is the ticket's first message, and only where the
 * conversation may leave and its author -- the requester -- agreed to that when they wrote; otherwise the
 * external record opens from its title alone. `status` is as it stands now, window included.
 */
export async function readSupportTicketForForward(siteId: number, ticketId: number) {
  const { rows } = await getPool().query<{
    id: number;
    thread_id: number;
    subject: string;
    type_key: string;
    type_flags: number;
    settled_status: number;
    first_body: string | null;
    first_author_user_id: number | null;
    author_consented: boolean | null;
  }>(
    `SELECT t.id,
            t.thread_id,
            t.subject,
            type.key AS type_key,
            type.flags AS type_flags,
            ${settledSupportTicketStatusSql("t")} AS settled_status,
            first_message.body_text AS first_body,
            first_message.author_user_id AS first_author_user_id,
            (participant.flags & ${PhisThreadParticipantFlag.ExternalConsent}) <> 0 AS author_consented
     FROM phis.support_tickets t
     JOIN phis.support_ticket_types type ON type.id = t.type_id
     LEFT JOIN LATERAL (
       SELECT message.body_text, message.author_user_id, message.flags
       FROM phis.thread_messages message
       WHERE message.thread_id = t.thread_id
       ORDER BY message.id ASC
       LIMIT 1
     ) first_message ON TRUE
     LEFT JOIN phis.thread_participants participant
       ON participant.thread_id = t.thread_id
      AND participant.user_id = first_message.author_user_id
     WHERE t.site_id = $1
       AND t.id = $2`,
    [siteId, ticketId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  const mirror = (row.type_flags & PhisSupportTicketTypeFlag.External) !== 0;
  return {
    id: row.id,
    threadId: row.thread_id,
    subject: row.subject,
    typeKey: row.type_key,
    status: row.settled_status,
    mirror,
    body: mirror && row.author_consented === true ? row.first_body : null,
  };
}

/**
 * Writes down that a ticket's work went somewhere else, once that somewhere answered.
 *
 * One transaction: the engineering task the work now is, the synced link from that task to the external
 * record -- in the implementing Add-on's name, which is what lets it read the conversation and finish the
 * task afterwards -- the event, and the ticket waiting on the work. A ticket already finished does not
 * wait on anything and keeps its status.
 */
export async function recordSupportTicketForward(input: {
  siteId: number;
  ticketId: number;
  providerId: string;
  title: string;
  link: { type: number; externalId: string; url: string | null; state: number | null };
  byUserId: number;
}) {
  await withTransaction(async (client) => {
    const ticket = await getSupportTicketRowById(client, input.siteId, input.ticketId, { forUpdate: true });
    if (!ticket) {
      throw new SupportAdministrationError("This Site has no such ticket.");
    }
    const { rows: tasks } = await client.query<{ id: number }>(
      `INSERT INTO phis.support_ticket_tasks (
         ticket_id, type, status, title, created_by_user_id, updated_by_user_id
       )
       VALUES ($1, ${SUPPORT_TICKET_TASK_TYPE_ENGINEERING}, ${SUPPORT_TICKET_TASK_STATUS_OPEN}, $2, $3, $3)
       RETURNING id`,
      [input.ticketId, input.title, input.byUserId],
    );
    const taskId = tasks[0]!.id;
    const { rowCount } = await client.query(
      `INSERT INTO phis.resource_links (
         site_id, ticket_task_id, provider_id, type, external_id, url, state, flags, created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${PhisResourceLinkFlag.Synced}, $8)
       ON CONFLICT (site_id, provider_id, type, external_id) DO NOTHING`,
      [
        input.siteId,
        taskId,
        input.providerId,
        input.link.type,
        input.link.externalId,
        input.link.url,
        input.link.state,
        input.byUserId,
      ],
    );
    if (!rowCount) {
      throw new SupportAdministrationError("That external record is already linked to something on this Site.");
    }
    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_TASK_CREATED,
      createdByUserId: input.byUserId,
      payload: { taskId, type: SUPPORT_TICKET_TASK_TYPE_ENGINEERING },
    });
    await insertSupportTicketEvent(client, {
      ticketId: input.ticketId,
      eventType: SUPPORT_TICKET_EVENT_LINKED,
      createdByUserId: input.byUserId,
      payload: { taskId, providerId: input.providerId, externalId: input.link.externalId, url: input.link.url },
    });
    const waits = ticket.status !== PhisSupportTicketStatus.Resolved && ticket.status !== PhisSupportTicketStatus.Closed;
    if (waits) {
      await moveSupportTicketStatusWithDb(client, {
        ticketId: input.ticketId,
        from: ticket.status,
        to: PhisSupportTicketStatus.WaitingInternal,
        byUserId: input.byUserId,
      });
    }
  });
  return getSupportTicketDetail(input.siteId, input.ticketId);
}
