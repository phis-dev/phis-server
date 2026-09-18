import "server-only";

import type { PoolClient } from "pg";

import { PhisSupportQueueFlag, PhisSupportTicketTypeFlag } from "@phis/contracts/support";
import { PhisThreadKind } from "@phis/contracts/threads";

import { getPool } from "@/lib/db";
import { createThreadWithDb } from "@/db/threads";

export const SUPPORT_TICKET_STATUS_NEW = 0;
export const SUPPORT_TICKET_STATUS_TRIAGED = 1;
export const SUPPORT_TICKET_STATUS_ASSIGNED = 2;
export const SUPPORT_TICKET_STATUS_IN_PROGRESS = 3;
export const SUPPORT_TICKET_STATUS_WAITING_CUSTOMER = 4;
export const SUPPORT_TICKET_STATUS_WAITING_INTERNAL = 5;
export const SUPPORT_TICKET_STATUS_ESCALATED = 6;
export const SUPPORT_TICKET_STATUS_RESOLVED = 7;
export const SUPPORT_TICKET_STATUS_CLOSED = 8;

export const SUPPORT_TICKET_CHANNEL_PORTAL = 0;
export const SUPPORT_TICKET_CHANNEL_EMAIL = 1;
export const SUPPORT_TICKET_CHANNEL_GITHUB = 2;
export const SUPPORT_TICKET_CHANNEL_API = 3;
export const SUPPORT_TICKET_CHANNEL_INTERNAL = 4;

export const SUPPORT_TICKET_PRIORITY_LOW = 0;
export const SUPPORT_TICKET_PRIORITY_NORMAL = 1;
export const SUPPORT_TICKET_PRIORITY_HIGH = 2;
export const SUPPORT_TICKET_PRIORITY_URGENT = 3;

export const SUPPORT_TICKET_SEVERITY_MINOR = 0;
export const SUPPORT_TICKET_SEVERITY_MAJOR = 1;
export const SUPPORT_TICKET_SEVERITY_CRITICAL = 2;

export const SUPPORT_TICKET_TASK_TYPE_INTERNAL = 0;
export const SUPPORT_TICKET_TASK_TYPE_CUSTOMER_FOLLOWUP = 1;
export const SUPPORT_TICKET_TASK_TYPE_ENGINEERING = 2;
export const SUPPORT_TICKET_TASK_TYPE_QA = 3;
export const SUPPORT_TICKET_TASK_TYPE_DEPLOYMENT = 4;
export const SUPPORT_TICKET_TASK_TYPE_DOCUMENTATION = 5;

export const SUPPORT_TICKET_TASK_STATUS_OPEN = 0;
export const SUPPORT_TICKET_TASK_STATUS_IN_PROGRESS = 1;
export const SUPPORT_TICKET_TASK_STATUS_BLOCKED = 2;
export const SUPPORT_TICKET_TASK_STATUS_DONE = 3;
export const SUPPORT_TICKET_TASK_STATUS_CANCELED = 4;

export const SUPPORT_TICKET_EVENT_CREATED = 0;
export const SUPPORT_TICKET_EVENT_TRIAGED = 1;
export const SUPPORT_TICKET_EVENT_ASSIGNED = 2;
export const SUPPORT_TICKET_EVENT_REPLIED = 3;
export const SUPPORT_TICKET_EVENT_LINKED = 4;
export const SUPPORT_TICKET_EVENT_UNLINKED = 5;
export const SUPPORT_TICKET_EVENT_ESCALATED = 6;
export const SUPPORT_TICKET_EVENT_RESOLVED = 7;
export const SUPPORT_TICKET_EVENT_REOPENED = 8;
export const SUPPORT_TICKET_EVENT_CLOSED = 9;
export const SUPPORT_TICKET_EVENT_TASK_CREATED = 10;
export const SUPPORT_TICKET_EVENT_TASK_COMPLETED = 11;
export const SUPPORT_TICKET_EVENT_TASK_REOPENED = 12;

type DbQueryable = Pick<PoolClient, "query">;

type SupportTicketListRow = {
  id: number;
  type_id: number;
  thread_id: number;
  status: number;
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

type SupportTicketEventInsertPayload = Record<string, unknown>;

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
  resolvedAt?: string | null;
  closedAt?: string | null;
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

function toJsonRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? {};
}

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
    meta: toJsonRecord(row.meta),
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
    meta: toJsonRecord(row.meta),
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertSupportTicketEvent(
  queryable: DbQueryable,
  input: {
    ticketId: number;
    eventType: number;
    createdByUserId?: number | null;
    payload?: SupportTicketEventInsertPayload;
  },
) {
  await queryable.query(
    `INSERT INTO phis.support_ticket_events (
       ticket_id,
       event_type,
       payload,
       created_by_user_id
     )
     VALUES ($1, $2, $3::jsonb, $4)`,
    [input.ticketId, input.eventType, JSON.stringify(input.payload ?? {}), input.createdByUserId ?? null],
  );
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

async function getSupportTicketRowById(queryable: DbQueryable, siteId: number, ticketId: number) {
  const { rows } = await queryable.query<SupportTicketListRow>(
    `SELECT
       t.*,
       assignee.email_normalized AS assignee_email,
       queue.name AS queue_name
     FROM phis.support_tickets t
     LEFT JOIN phis.user_account_directory assignee
       ON assignee.id = t.assignee_user_id
     LEFT JOIN phis.support_queues queue
       ON queue.id = t.queue_id
     WHERE t.site_id = $1
       AND t.id = $2
     LIMIT 1`,
    [siteId, ticketId],
  );

  return rows[0] ?? null;
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
    conditions.push(`t.status = $${params.length}`);
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
    rows: rows.map(mapSupportTicket),
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
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
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
      const targetQueue = await getSupportQueueBySiteAndId(input.siteId, input.queueId);
      if (!targetQueue) {
        throw new Error("Target queue not found.");
      }

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

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    /*
     * Where this ticket lands, and the group that therefore sees it.
     *
     * An unrouted ticket is a ticket nobody is looking at, so a queue is required rather than defaulted
     * to whatever happens to exist: either the caller names one, or the Site has marked one as where
     * work arrives. Its group is what makes the ticket's thread visible to Support at all.
     */
    const queueRows = await client.query<{ id: number; group_id: number }>(
      input.queueId != null
        ? `SELECT id, group_id FROM phis.support_queues WHERE site_id = $1 AND id = $2`
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
         subject,
         summary,
         meta,
         first_response_due_at,
         resolution_due_at,
         created_by_user_id,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $18)
       RETURNING id`,
      [
        input.siteId,
        input.typeId,
        thread.id,
        input.status ?? SUPPORT_TICKET_STATUS_NEW,
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
        status: input.status ?? SUPPORT_TICKET_STATUS_NEW,
        assigneeUserId: input.assigneeUserId ?? null,
        queueId: queue.id,
      },
    });

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupportTicket(input: UpdateSupportTicketInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [input.siteId, input.ticketId];
    const addSet = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (typeof input.typeId === "number") addSet("type_id", input.typeId);
    if (typeof input.status === "number") addSet("status", input.status);
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
    if (input.resolvedAt !== undefined) addSet("resolved_at", input.resolvedAt ?? null);
    if (input.closedAt !== undefined) addSet("closed_at", input.closedAt ?? null);
    addSet("updated_by_user_id", input.updatedByUserId ?? null);
    sets.push("updated_at = NOW()");

    await client.query(
      `UPDATE phis.support_tickets
       SET ${sets.join(", ")}
       WHERE site_id = $1
         AND id = $2`,
      params,
    );

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

    if (typeof input.status === "number" && input.status !== existing.status) {
      await insertSupportTicketEvent(client, {
        ticketId: input.ticketId,
        eventType:
          input.status === SUPPORT_TICKET_STATUS_RESOLVED
            ? SUPPORT_TICKET_EVENT_RESOLVED
            : input.status === SUPPORT_TICKET_STATUS_CLOSED
              ? SUPPORT_TICKET_EVENT_CLOSED
              : SUPPORT_TICKET_EVENT_TRIAGED,
        createdByUserId: input.updatedByUserId ?? null,
        payload: {
          fromStatus: existing.status,
          toStatus: input.status,
        },
      });
    }

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addSupportTicketTask(input: AddSupportTicketTaskInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketRowById(client, input.siteId, input.ticketId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

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

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateSupportTicketTask(input: UpdateSupportTicketTaskInput) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketTaskRowById(client, input.siteId, input.ticketId, input.taskId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

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
    }

    await client.query("COMMIT");
    return getSupportTicketDetail(input.siteId, input.ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSupportTicketTask(siteId: number, ticketId: number, taskId: number, userId?: number | null) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const existing = await getSupportTicketTaskRowById(client, siteId, ticketId, taskId);
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
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

    await client.query("COMMIT");
    return getSupportTicketDetail(siteId, ticketId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
         ticket.status,
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
    sort_order: number;
    retired_at: string | null;
  }>(
    `SELECT id, site_id, key, name, flags, close_policy, requester_window_days, sort_order, retired_at
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
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
    await client.query("COMMIT");
    return rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createSupportTicketType(input: {
  siteId: number;
  key: string;
  name: string;
  flags?: number;
  closePolicy?: number;
  requesterWindowDays?: number | null;
  sortOrder?: number;
}) {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO phis.support_ticket_types
       (site_id, key, name, flags, close_policy, requester_window_days, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (site_id, key) DO NOTHING
     RETURNING id`,
    [
      input.siteId,
      input.key,
      input.name,
      input.flags ?? 0,
      input.closePolicy ?? 0,
      input.requesterWindowDays ?? null,
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
  sortOrder?: number;
  retired?: boolean;
}) {
  const { rowCount } = await getPool().query(
    `UPDATE phis.support_ticket_types
     SET name = COALESCE($3, name),
         flags = COALESCE($4, flags),
         close_policy = COALESCE($5, close_policy),
         requester_window_days = CASE WHEN $6::boolean THEN $7::smallint ELSE requester_window_days END,
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
};

export async function listRequestableSupportTicketTypes(siteId: number) {
  const { rows } = await getPool().query<{ key: string; name: string; flags: number }>(
    `SELECT key, name, flags
     FROM phis.support_ticket_types
     WHERE site_id = $1
       AND retired_at IS NULL
       AND (flags & ${PhisSupportTicketTypeFlag.Requestable}) <> 0
     ORDER BY sort_order ASC, id ASC`,
    [siteId],
  );
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    external: (row.flags & PhisSupportTicketTypeFlag.External) !== 0,
  } satisfies RequestableSupportTicketType));
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
