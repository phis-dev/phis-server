import "server-only";

import { getPool } from "@/lib/db";
import {
  SUPPORT_TICKET_EVENT_ASSIGNED,
  SUPPORT_TICKET_EVENT_CLOSED,
  SUPPORT_TICKET_EVENT_CREATED,
  SUPPORT_TICKET_EVENT_ESCALATED,
  SUPPORT_TICKET_EVENT_LINKED,
  SUPPORT_TICKET_EVENT_REOPENED,
  SUPPORT_TICKET_EVENT_REPLIED,
  SUPPORT_TICKET_EVENT_RESOLVED,
  SUPPORT_TICKET_EVENT_TASK_COMPLETED,
  SUPPORT_TICKET_EVENT_TASK_CREATED,
  SUPPORT_TICKET_EVENT_TASK_REOPENED,
  SUPPORT_TICKET_EVENT_TRIAGED,
  SUPPORT_TICKET_EVENT_UNLINKED,
} from "@/lib/constants/support";

/*
 * What happened to a ticket, read back for a Supporter.
 *
 * The log is written in numbers and ids (`insertSupportTicketEvent`), which is right for a log and
 * useless to a person. This reader answers in what a person recognises -- the kind of event as a word,
 * the people by name and address, the queues by name -- and in no language: the words around them are
 * the Support Module's to choose and translate. Oldest first, because a history is read in the order it
 * happened.
 */

const SUPPORT_TICKET_EVENT_KINDS = {
  [SUPPORT_TICKET_EVENT_CREATED]: "created",
  [SUPPORT_TICKET_EVENT_TRIAGED]: "status",
  [SUPPORT_TICKET_EVENT_ASSIGNED]: "assigned",
  [SUPPORT_TICKET_EVENT_REPLIED]: "replied",
  [SUPPORT_TICKET_EVENT_LINKED]: "linked",
  [SUPPORT_TICKET_EVENT_UNLINKED]: "unlinked",
  [SUPPORT_TICKET_EVENT_ESCALATED]: "escalated",
  [SUPPORT_TICKET_EVENT_RESOLVED]: "resolved",
  [SUPPORT_TICKET_EVENT_REOPENED]: "reopened",
  [SUPPORT_TICKET_EVENT_CLOSED]: "closed",
  [SUPPORT_TICKET_EVENT_TASK_CREATED]: "task_created",
  [SUPPORT_TICKET_EVENT_TASK_COMPLETED]: "task_completed",
  [SUPPORT_TICKET_EVENT_TASK_REOPENED]: "task_reopened",
} as const;

export type SupportTicketEventKind = (typeof SUPPORT_TICKET_EVENT_KINDS)[keyof typeof SUPPORT_TICKET_EVENT_KINDS];

export type SupportTicketEventPerson = {
  userId: number;
  name: string | null;
  email: string | null;
};

export type SupportTicketEventRecord = {
  id: number;
  kind: SupportTicketEventKind;
  at: string;
  /** Who did it; `null` where the server did, as when a requester window runs out. */
  actor: SupportTicketEventPerson | null;
  fromStatus?: number;
  toStatus?: number;
  fromAssignee?: SupportTicketEventPerson | null;
  toAssignee?: SupportTicketEventPerson | null;
  fromQueue?: string | null;
  toQueue?: string | null;
  taskId?: number;
  url?: string;
  reason?: string;
};

/** The most a history answers; a ticket with more events than this is read from its newest end. */
export const SUPPORT_TICKET_EVENTS_LIMIT = 200;

type SupportTicketEventRow = {
  id: number;
  event_type: number;
  payload: Record<string, unknown> | null;
  created_at: Date | string;
  actor_user_id: number | null;
  actor_user_name: string | null;
  actor_user_email: string | null;
  from_user_id: number | null;
  from_user_name: string | null;
  from_user_email: string | null;
  to_user_id: number | null;
  to_user_name: string | null;
  to_user_email: string | null;
  from_queue_name: string | null;
  to_queue_name: string | null;
};

/* A payload id as a number, or NULL for anything else -- a hand-edited row must not fail the read. */
function payloadIdSql(field: string) {
  return `CASE WHEN jsonb_typeof(event.payload -> '${field}') = 'number'
               THEN (event.payload ->> '${field}')::int END`;
}

function personSql(alias: string, idExpression: string) {
  return {
    columns: `${idExpression} AS ${alias}_user_id,
              NULLIF(TRIM(CONCAT_WS(' ', ${alias}_profile.first_name, ${alias}_profile.last_name)), '') AS ${alias}_user_name,
              ${alias}_directory.email_normalized AS ${alias}_user_email`,
    joins: `LEFT JOIN phis.user_profiles ${alias}_profile ON ${alias}_profile.user_id = ${idExpression}
            LEFT JOIN phis.user_account_directory ${alias}_directory ON ${alias}_directory.id = ${idExpression}`,
  };
}

function readPerson(id: number | null, name: string | null, email: string | null): SupportTicketEventPerson | null {
  return id == null ? null : { userId: id, name, email };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mapEvent(row: SupportTicketEventRow): SupportTicketEventRecord | null {
  const kind = SUPPORT_TICKET_EVENT_KINDS[row.event_type as keyof typeof SUPPORT_TICKET_EVENT_KINDS];
  if (!kind) {
    return null;
  }
  const payload = row.payload ?? {};
  const hasAssignees = "fromUserId" in payload || "toUserId" in payload || "assigneeUserId" in payload;
  /*
   * A queue moved, or the queue a ticket opened in. An assignment states the queue it happened in as
   * `queueId` too, but nothing moved there, so it is not read as a destination.
   */
  const hasQueues = "fromQueueId" in payload || "toQueueId" in payload || (kind === "created" && "queueId" in payload);
  const fromStatus = readNumber(payload.fromStatus);
  const toStatus = readNumber(payload.toStatus) ?? (kind === "created" ? readNumber(payload.status) : undefined);
  const taskId = readNumber(payload.taskId);
  const url = readText(payload.url);
  const reason = readText(payload.reason);
  return {
    id: row.id,
    kind,
    at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    actor: readPerson(row.actor_user_id, row.actor_user_name, row.actor_user_email),
    ...(fromStatus != null ? { fromStatus } : {}),
    ...(toStatus != null ? { toStatus } : {}),
    ...(hasAssignees
      ? {
          fromAssignee: readPerson(row.from_user_id, row.from_user_name, row.from_user_email),
          toAssignee: readPerson(row.to_user_id, row.to_user_name, row.to_user_email),
        }
      : {}),
    ...(hasQueues ? { fromQueue: row.from_queue_name, toQueue: row.to_queue_name } : {}),
    ...(taskId != null ? { taskId } : {}),
    ...(url ? { url } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * The events of one ticket of this Site, oldest first, or `null` where the Site has no such ticket.
 * The ticket is looked up within the Site, so an id from another Site answers as one that does not exist.
 */
export async function listSupportTicketEvents(siteId: number, ticketId: number): Promise<SupportTicketEventRecord[] | null> {
  const pool = getPool();
  const ticket = await pool.query<{ id: number }>(
    `SELECT id FROM phis.support_tickets WHERE site_id = $1 AND id = $2 LIMIT 1`,
    [siteId, ticketId],
  );
  if (!ticket.rows[0]) {
    return null;
  }

  const actor = personSql("actor", "event.created_by_user_id");
  const fromUser = personSql("from", payloadIdSql("fromUserId"));
  /* Opening a ticket names its first assignee as `assigneeUserId`; every later move says `toUserId`. */
  const toUser = personSql("to", `COALESCE(${payloadIdSql("toUserId")}, ${payloadIdSql("assigneeUserId")})`);
  const { rows } = await pool.query<SupportTicketEventRow>(
    `SELECT *
     FROM (
       SELECT event.id,
              event.event_type,
              event.payload,
              event.created_at,
              ${actor.columns},
              ${fromUser.columns},
              ${toUser.columns},
              from_queue.name AS from_queue_name,
              to_queue.name AS to_queue_name
       FROM phis.support_ticket_events event
       ${actor.joins}
       ${fromUser.joins}
       ${toUser.joins}
       LEFT JOIN phis.support_queues from_queue ON from_queue.id = ${payloadIdSql("fromQueueId")}
       LEFT JOIN phis.support_queues to_queue
         ON to_queue.id = COALESCE(${payloadIdSql("toQueueId")}, ${payloadIdSql("queueId")})
       WHERE event.ticket_id = $1
       ORDER BY event.created_at DESC, event.id DESC
       LIMIT $2
     ) newest
     ORDER BY newest.created_at ASC, newest.id ASC`,
    [ticketId, SUPPORT_TICKET_EVENTS_LIMIT],
  );
  return rows.map(mapEvent).filter((event): event is SupportTicketEventRecord => event != null);
}
