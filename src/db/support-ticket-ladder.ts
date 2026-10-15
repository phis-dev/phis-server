import "server-only";

import type { PoolClient } from "pg";

import { PhisSupportTicketStatus, type PhisSupportTicketStatusValue } from "@phis/contracts/support";

import { supportTicketWindowEndSql, supportTicketWindowPassedSql } from "@/db/support-requester-window.mts";
import {
  SUPPORT_TICKET_EVENT_CLOSED,
  SUPPORT_TICKET_EVENT_REOPENED,
  SUPPORT_TICKET_EVENT_REPLIED,
  SUPPORT_TICKET_EVENT_RESOLVED,
  SUPPORT_TICKET_EVENT_TRIAGED,
} from "@/lib/constants/support";

/*
 * Where a ticket moves on the ladder because of something that happened, rather than because somebody
 * set a status.
 *
 * Its own module because two writers reach it from opposite ends: `support.ts`, where a ticket is taken
 * or put down, and `threads.ts`, where somebody answers in the ticket's conversation. `support.ts`
 * already imports `threads.ts` to open a ticket's thread, so the rules both of them apply live below
 * both rather than in either.
 */

type DbQueryable = Pick<PoolClient, "query">;

export async function insertSupportTicketEvent(
  queryable: DbQueryable,
  input: {
    ticketId: number;
    eventType: number;
    createdByUserId?: number | null;
    payload?: Record<string, unknown>;
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

/**
 * Moves a ticket to `to`, and records when it got there.
 *
 * `resolved_at` and `closed_at` are facts of the move rather than fields a caller supplies: the
 * requester window counts from `resolved_at`, and a timestamp somebody typed into a request body would
 * let a ticket close the moment it was resolved. Arriving at `Resolved` stamps it afresh, since a
 * ticket resolved a second time has a second window; leaving for anything short of `Closed` clears it,
 * since a ticket that is being worked on again is no longer waiting for anybody to object.
 */
export async function moveSupportTicketStatusWithDb(
  db: DbQueryable,
  input: {
    ticketId: number;
    from: number;
    to: PhisSupportTicketStatusValue;
    byUserId: number | null;
    eventType?: number;
    payload?: Record<string, unknown>;
  },
) {
  if (input.from === input.to) {
    return;
  }
  await db.query(
    `UPDATE phis.support_tickets
     SET status = $2::smallint,
         resolved_at = CASE
           WHEN $2::smallint = ${PhisSupportTicketStatus.Resolved} THEN NOW()
           WHEN $2::smallint = ${PhisSupportTicketStatus.Closed} THEN resolved_at
           ELSE NULL
         END,
         closed_at = CASE WHEN $2::smallint = ${PhisSupportTicketStatus.Closed} THEN NOW() ELSE NULL END,
         updated_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [input.ticketId, input.to, input.byUserId],
  );
  await insertSupportTicketEvent(db, {
    ticketId: input.ticketId,
    eventType: input.eventType ?? (
      input.to === PhisSupportTicketStatus.Resolved
        ? SUPPORT_TICKET_EVENT_RESOLVED
        : input.to === PhisSupportTicketStatus.Closed
          ? SUPPORT_TICKET_EVENT_CLOSED
          : SUPPORT_TICKET_EVENT_TRIAGED
    ),
    createdByUserId: input.byUserId,
    payload: { ...input.payload, fromStatus: input.from, toStatus: input.to },
  });
}

/**
 * Records that a ticket's requester window ran out, if it did, before anything else is done to it.
 *
 * Readers already show such a ticket as closed (`settledSupportTicketColumnsSql`); a writer that has
 * locked the ticket writes that down first, so what it then does starts from where the ticket actually
 * stands. A requester answering after their window has closed answers a closed ticket, not a resolved
 * one they could still reopen. `closed_at` is when the window ended, which is what readers showed.
 *
 * Answers the status the ticket is at afterwards.
 */
export async function settleSupportTicketWindowWithDb(
  db: DbQueryable,
  ticket: { id: number; status: number },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE phis.support_tickets ticket
     SET status = ${PhisSupportTicketStatus.Closed},
         closed_at = ${supportTicketWindowEndSql("ticket")},
         updated_by_user_id = NULL,
         updated_at = NOW()
     WHERE ticket.id = $1
       AND ${supportTicketWindowPassedSql("ticket")}
     RETURNING ticket.id`,
    [ticket.id],
  );
  if (rows.length === 0) {
    return ticket.status;
  }
  await insertSupportTicketEvent(db, {
    ticketId: ticket.id,
    eventType: SUPPORT_TICKET_EVENT_CLOSED,
    createdByUserId: null,
    payload: {
      fromStatus: PhisSupportTicketStatus.Resolved,
      toStatus: PhisSupportTicketStatus.Closed,
      reason: "requester_window",
    },
  });
  return PhisSupportTicketStatus.Closed;
}

/**
 * What a message in a ticket's conversation does to the ticket.
 *
 * Only a person's message that the requester could read counts. An internal note is Staff talking among
 * themselves, and a message imported from an integration is the other system's conversation, which moves
 * the ticket through its tasks rather than through this.
 *
 * - The requester answers a ticket that is waiting on them, or one that was resolved: it is back with
 *   Support. Answering a resolved one is the objection the requester window exists to collect, so it is
 *   recorded as a reopening.
 * - Somebody else answers a ticket that was only taken: the work has started.
 *
 * Nothing else moves. In particular a Supporter answering a ticket that is waiting on the customer leaves
 * it waiting -- that answer is usually the question being waited on.
 */
export async function recordSupportTicketMessageWithDb(
  db: DbQueryable,
  input: { threadId: number; authorUserId: number; visibleToRequester: boolean },
) {
  const { rows } = await db.query<{ id: number; status: number; requester_user_id: number | null }>(
    `SELECT id, status, requester_user_id
     FROM phis.support_tickets
     WHERE thread_id = $1
     FOR UPDATE`,
    [input.threadId],
  );
  const ticket = rows[0];
  if (!ticket) {
    return;
  }
  ticket.status = await settleSupportTicketWindowWithDb(db, ticket);

  await db.query(
    `UPDATE phis.support_tickets
     SET ${input.visibleToRequester ? "last_public_message_at" : "last_internal_message_at"} = NOW()
     WHERE id = $1`,
    [ticket.id],
  );
  if (!input.visibleToRequester) {
    return;
  }

  const fromRequester = ticket.requester_user_id === input.authorUserId;
  if (
    fromRequester &&
    (ticket.status === PhisSupportTicketStatus.Resolved || ticket.status === PhisSupportTicketStatus.WaitingCustomer)
  ) {
    await moveSupportTicketStatusWithDb(db, {
      ticketId: ticket.id,
      from: ticket.status,
      to: PhisSupportTicketStatus.InProgress,
      byUserId: input.authorUserId,
      eventType: ticket.status === PhisSupportTicketStatus.Resolved ? SUPPORT_TICKET_EVENT_REOPENED : undefined,
    });
    return;
  }
  if (!fromRequester && ticket.status === PhisSupportTicketStatus.Assigned) {
    await moveSupportTicketStatusWithDb(db, {
      ticketId: ticket.id,
      from: ticket.status,
      to: PhisSupportTicketStatus.InProgress,
      byUserId: input.authorUserId,
      eventType: SUPPORT_TICKET_EVENT_REPLIED,
    });
  }
}

/**
 * The status a change of hands leaves a ticket at.
 *
 * Somebody taking a ticket that nobody had started is the ticket being assigned; putting it down sends
 * it back to be picked up. Moving it to another queue does that too, and also to a ticket somebody was
 * working on, because the move takes the ticket out of their hands: nobody in the new queue has started
 * it. A ticket that is waiting, escalated or resolved keeps its place -- who holds it changed, not what it
 * is waiting for.
 */
export function supportTicketStatusAfterHandover(
  status: number,
  handover: "taken" | "released" | "moved",
): PhisSupportTicketStatusValue | null {
  if (handover === "taken") {
    return status === PhisSupportTicketStatus.New || status === PhisSupportTicketStatus.Triaged
      ? PhisSupportTicketStatus.Assigned
      : null;
  }
  if (status === PhisSupportTicketStatus.Assigned) {
    return PhisSupportTicketStatus.Triaged;
  }
  return handover === "moved" && status === PhisSupportTicketStatus.InProgress
    ? PhisSupportTicketStatus.Triaged
    : null;
}
