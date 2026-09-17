import "server-only";

import type { PoolClient } from "pg";

import { PhisResourceLinkFlag, type PhisAddonEventId } from "@phis/contracts/addon";

import { getPool } from "@/lib/db";
import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "@/lib/constants/server-addons";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * What Core owes an Add-on about a thread it is linked to.
 *
 * Written in the transaction that caused it and dispatched after the commit. Announcing a change from
 * inside the request that made it would tie a person's reply to a third party being reachable, and
 * announcing it before the commit would announce something that may still roll back.
 */

export type PhisAddonEventRow = {
  id: string;
  siteId: number;
  addonId: string;
  event: PhisAddonEventId;
  threadId: number;
  payload: Record<string, unknown>;
  attempts: number;
};

type OutboxRow = {
  id: string;
  site_id: number;
  addon_id: string;
  event: string;
  thread_id: number;
  payload: Record<string, unknown> | null;
  attempts: number;
};

/**
 * Enqueues one event for every Add-on a person has linked to this thread.
 *
 * The recipients are the synced links and nothing else -- the same predicate that decides whether an
 * actorless Add-on may read the thread at all, asked here in the other direction. Delivering to every
 * Add-on that merely declares the event would be the Site-wide listing that `threads:v1` refuses,
 * arriving by push instead of by pull.
 *
 * `exceptProviderId` is what stops an echo: a message this Add-on imported is not news to it, and
 * sending it back is how two systems write the same sentence to each other forever.
 *
 * The insert joins the Add-on registry rather than trusting `provider_id`. A link's provider is free
 * text with a shape, so a row could name something that was never installed -- and a foreign key
 * violation here would roll back the message that caused it, which is the one outcome a notification
 * must never produce.
 */
export async function enqueuePhisAddonThreadEventWithDb(
  db: DbQueryable,
  input: {
    siteId: number;
    threadId: number;
    event: PhisAddonEventId;
    payload?: Record<string, unknown>;
    exceptProviderId?: string | null;
  },
) {
  const { rowCount } = await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, thread_id, payload)
     SELECT DISTINCT $1::smallint, link.provider_id, $3, $2::int, $4::jsonb
     FROM phis.resource_links link
     JOIN phis.site_server_addons installed
       ON installed.addon_id = link.provider_id
      AND installed.site_id = link.site_id
     LEFT JOIN phis.support_tickets ticket
       ON ticket.id = link.ticket_id
     LEFT JOIN phis.support_ticket_tasks task
       ON task.id = link.ticket_task_id
     LEFT JOIN phis.support_tickets task_ticket
       ON task_ticket.id = task.ticket_id
     WHERE link.site_id = $1
       AND (link.flags & ${PhisResourceLinkFlag.Synced}) <> 0
       AND (
         link.thread_id = $2
         OR ticket.thread_id = $2
         OR task_ticket.thread_id = $2
       )
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'
       AND ($5::varchar IS NULL OR link.provider_id <> $5::varchar)`,
    [
      input.siteId,
      input.threadId,
      input.event,
      JSON.stringify(input.payload ?? {}),
      input.exceptProviderId ?? null,
    ],
  );
  return rowCount ?? 0;
}

/**
 * What is still owed, for one Add-on on one Site, oldest first.
 *
 * Ordered by the key and not by the timestamp: two events written in one transaction share a moment,
 * and an integration applying them in the wrong order would leave the older state as the current one.
 */
export async function listPendingPhisAddonEvents(input: {
  addonId: string;
  siteId: number;
  limit?: number;
}): Promise<PhisAddonEventRow[]> {
  const { rows } = await getPool().query<OutboxRow>(
    `SELECT id, site_id, addon_id, event, thread_id, payload, attempts
     FROM phis.addon_event_outbox
     WHERE addon_id = $1
       AND site_id = $2
       AND delivered_at IS NULL
     ORDER BY id ASC
     LIMIT $3::int`,
    [input.addonId, input.siteId, Math.max(1, Math.min(input.limit ?? 200, 1000))],
  );
  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    addonId: row.addon_id,
    event: row.event as PhisAddonEventId,
    threadId: row.thread_id,
    payload: row.payload ?? {},
    attempts: row.attempts,
  }));
}

/**
 * Enqueues one event for one named Add-on, whatever the links currently say.
 *
 * For the one event whose cause is the link going away. By the time the row could be selected the way
 * every other event is selected, the thing that would have selected it is gone -- and an Add-on that is
 * never told it was unlinked keeps a reference to a conversation it can no longer read.
 */
export async function enqueuePhisAddonThreadEventForProviderWithDb(
  db: DbQueryable,
  input: {
    siteId: number;
    threadId: number;
    addonId: string;
    event: PhisAddonEventId;
    payload?: Record<string, unknown>;
  },
) {
  const { rowCount } = await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, thread_id, payload)
     SELECT $1::smallint, installed.addon_id, $4, $2::int, $5::jsonb
     FROM phis.site_server_addons installed
     WHERE installed.addon_id = $3
       AND installed.site_id = $1
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'`,
    [
      input.siteId,
      input.threadId,
      input.addonId,
      input.event,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return rowCount ?? 0;
}

/** Which Add-ons are owed something on this Site, so one commit's drain finds them all. */
export async function listPhisAddonEventAddonIds(siteId: number) {
  const { rows } = await getPool().query<{ addon_id: string }>(
    `SELECT DISTINCT addon_id
     FROM phis.addon_event_outbox
     WHERE site_id = $1
       AND delivered_at IS NULL
     ORDER BY addon_id ASC`,
    [siteId],
  );
  return rows.map((row) => row.addon_id);
}

/** Which Sites still owe this Add-on something, so a run can drain them all. */
export async function listPhisAddonEventSiteIds(addonId: string) {
  const { rows } = await getPool().query<{ site_id: number }>(
    `SELECT DISTINCT site_id
     FROM phis.addon_event_outbox
     WHERE addon_id = $1
       AND delivered_at IS NULL
     ORDER BY site_id ASC`,
    [addonId],
  );
  return rows.map((row) => row.site_id);
}

export async function markPhisAddonEventDelivered(id: string) {
  await getPool().query(
    `UPDATE phis.addon_event_outbox
     SET delivered_at = NOW(),
         last_error = NULL
     WHERE id = $1::bigint
       AND delivered_at IS NULL`,
    [id],
  );
}

/**
 * Records a failed attempt and leaves the row owed.
 *
 * There is no attempt ceiling here. A row nobody can deliver is a row an operator should see, and
 * dropping it after five tries would turn a broken integration into a silently divergent one; what
 * removes it is the link going away, which takes the row with it.
 */
export async function markPhisAddonEventFailed(id: string, error: string) {
  await getPool().query(
    `UPDATE phis.addon_event_outbox
     SET attempts = LEAST(attempts + 1, 32767),
         last_error = $2
     WHERE id = $1::bigint
       AND delivered_at IS NULL`,
    [id, error.slice(0, 2000)],
  );
}
