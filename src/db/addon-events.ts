import "server-only";

import type { PoolClient } from "pg";

import {
  PhisResourceLinkFlag,
  type PhisAddonEmittedEventId,
  type PhisAddonEventId,
  type PhisAddonThreadEventId,
} from "@phis/contracts/addon";

import { getPool } from "@/lib/db";
import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "@/lib/constants/server-addons";
import { PHIS_RESOURCE_LINK_THREAD_JOINS_SQL } from "@/db/resource-link-sql";

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
  subjectKind: "thread" | "payment" | "subscription" | "emitted";
  threadId: number | null;
  paymentId: string | null;
  subscriptionId: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  /** The Add-on that emitted this event, for an `emitted` subject; null on Core's own events. */
  emitter: string | null;
  /** How many handlers the chain had passed through when this row was written. */
  hop: number;
  dedupeKey: string | null;
  createdAt: string;
};

type OutboxRow = {
  id: string;
  site_id: number;
  addon_id: string;
  event: string;
  thread_id: number | null;
  subject_kind: "thread" | "payment" | "subscription" | "emitted";
  payment_id: string | null;
  subscription_id: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  emitter: string | null;
  hop: number;
  dedupe_key: string | null;
  created_at: string | Date;
};

const OUTBOX_COLUMNS =
  "id, site_id, addon_id, event, subject_kind, thread_id, payment_id, subscription_id, payload, attempts, emitter, hop, dedupe_key, created_at";

function mapOutboxRow(row: OutboxRow): PhisAddonEventRow {
  return {
    id: row.id,
    siteId: row.site_id,
    addonId: row.addon_id,
    event: row.event as PhisAddonEventId,
    subjectKind: row.subject_kind,
    paymentId: row.payment_id,
    subscriptionId: row.subscription_id,
    threadId: row.thread_id,
    payload: row.payload ?? {},
    attempts: row.attempts,
    emitter: row.emitter,
    hop: row.hop,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

/**
 * Enqueues one event for every Add-on a person has linked to this thread, and for the one that owns it.
 *
 * The recipients are the synced links and the owner and nothing else -- the same predicate that decides
 * whether an actorless Add-on may read the thread at all, asked here in the other direction. Delivering to every
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
    event: PhisAddonThreadEventId;
    payload?: Record<string, unknown>;
    exceptProviderId?: string | null;
  },
) {
  /*
   * Who hears about a thread: every Add-on a person linked to it, synced -- and the Add-on that owns it.
   * An Add-on that opened a thread itself (a ticket for an issue that arrived from outside) reaches it by
   * ownership rather than by a link, and nobody could have written a link for it: writing one needs a
   * person. Leaving the owner out would leave the one integration that started the conversation deaf to it.
   */
  const { rowCount } = await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, thread_id, payload)
     SELECT DISTINCT $1::smallint, candidate.provider_id, $3, $2::int, $4::jsonb
     FROM (
       SELECT link.provider_id
       FROM phis.resource_links link
       ${PHIS_RESOURCE_LINK_THREAD_JOINS_SQL}
       WHERE link.site_id = $1
         AND (link.flags & ${PhisResourceLinkFlag.Synced}) <> 0
         AND (
           link.thread_id = $2
           OR ticket.thread_id = $2
           OR task_ticket.thread_id = $2
         )
       UNION
       SELECT thread.owner_provider_id
       FROM phis.threads thread
       WHERE thread.site_id = $1
         AND thread.id = $2
         AND thread.owner_provider_id IS NOT NULL
     ) candidate
     JOIN phis.site_server_addons installed
       ON installed.addon_id = candidate.provider_id
      AND installed.site_id = $1
     WHERE (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'
       AND ($5::varchar IS NULL OR candidate.provider_id <> $5::varchar)`,
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
    `SELECT ${OUTBOX_COLUMNS}
     FROM phis.addon_event_outbox
     WHERE addon_id = $1
       AND site_id = $2
       AND delivered_at IS NULL
     ORDER BY id ASC
     LIMIT $3::int`,
    [input.addonId, input.siteId, Math.max(1, Math.min(input.limit ?? 200, 1000))],
  );
  return rows.map(mapOutboxRow);
}

/**
 * Writes what an Add-on emitted, one row per listener (SERVER_ADDONS.md, Events).
 *
 * The listeners are named by the caller, who read the installed manifests for the handlers that declare
 * this event; the insert keeps only those asked for and configured on this Site, which is the same gate
 * every other row of this table passes. The emitter's `dedupeKey` meets the partial unique index: a
 * second emit with the same key writes nothing for a listener already owed the first, and the count
 * says how many rows were new.
 */
export async function enqueuePhisAddonEmittedEvent(
  db: DbQueryable,
  input: {
    siteId: number;
    emitter: string;
    event: PhisAddonEmittedEventId;
    recipients: readonly string[];
    facts: Record<string, unknown>;
    dedupeKey: string | null;
    hop: number;
  },
): Promise<number> {
  if (input.recipients.length === 0) {
    return 0;
  }
  const { rowCount } = await db.query(
    `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, emitter, payload, dedupe_key, hop)
     SELECT $1::smallint, installed.addon_id, $3, 'emitted', $2, $5::jsonb, $6, $7::smallint
     FROM phis.site_server_addons installed
     WHERE installed.site_id = $1
       AND installed.addon_id = ANY($4::text[])
       AND (installed.flags & ${PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED}) <> 0
       AND installed.configuration_status = 'ready'
     ON CONFLICT DO NOTHING`,
    [
      input.siteId,
      input.emitter,
      input.event,
      input.recipients,
      JSON.stringify({ facts: input.facts }),
      input.dedupeKey,
      input.hop,
    ],
  );
  return rowCount ?? 0;
}

/** The Sites with something still owed, for the scheduled drain that walks all of them. */
export async function listPhisAddonEventSiteIds() {
  const { rows } = await getPool().query<{ site_id: number }>(
    `SELECT DISTINCT site_id
     FROM phis.addon_event_outbox
     WHERE delivered_at IS NULL
     ORDER BY site_id ASC`,
  );
  return rows.map((row) => row.site_id);
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
    event: PhisAddonThreadEventId;
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

/**
 * Runs `body` while holding the delivery lock for one Add-on on one Site, or returns null without
 * running it when another drain holds the lock.
 *
 * Three things drain the outbox (event-delivery.ts), on every instance of Core, and none of them knew
 * about the others: two drains reading the same owed rows handed the handler each row twice, and the
 * order the rows promise -- a message, then a status, then the link going away -- held only within one
 * drain. The lock is a session-level advisory lock on the database, so it is one lock across every
 * instance, and it goes with the connection when a process dies holding it. Held on a connection of
 * its own for the length of the drain; the handlers' own queries run on the pool as before.
 */
export async function withPhisAddonEventDeliveryLock<T>(
  addonId: string,
  siteId: number,
  body: () => Promise<T>,
): Promise<T | null> {
  const client = await getPool().connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('addon-events:' || $1::text), $2::int) AS locked`,
      [addonId, siteId],
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      return null;
    }
    return await body();
  } finally {
    if (locked) {
      await client
        .query(`SELECT pg_advisory_unlock(hashtext('addon-events:' || $1::text), $2::int)`, [addonId, siteId])
        .catch(() => undefined);
    }
    client.release();
  }
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
