import "server-only";

import type { PoolClient } from "pg";

import {
  PHIS_ADDON_EVENTS,
  PHIS_DECLARABLE_THREAD_KINDS,
  PHIS_SITE_THREAD_KIND_FLAG_BY_DECLARATION,
  PhisResourceLinkFlag,
  PhisThreadKind,
  PhisThreadMessageFlag,
  PhisThreadParticipantFlag,
  PhisThreadStatus,
  type PhisThreadDetail,
  type PhisThreadKindValue,
  type PhisThreadMessage,
  type PhisThreadMessageAuthor,
  type PhisThreadParticipant,
  type PhisThreadStatusValue,
  type PhisThreadSummary,
} from "@phis/contracts/addon";

import { getPool } from "@/lib/db";
import { PhiBaseRole } from "@phis/contracts/access";

import { enqueuePhisAddonThreadEventWithDb } from "@/db/addon-events";
import { schedulePhisAddonEventDelivery } from "@/lib/addons/event-trigger";

import { PHI_CORE_ROLE_PROVIDER_ID } from "@/lib/authorization";
import { PhiSiteGroupFlags } from "@/lib/constants/site-groups";
import {
  PHIS_THREAD_MESSAGE_MAX_PAGE_SIZE,
  PHIS_THREAD_MESSAGE_PAGE_SIZE,
  PHIS_THREAD_MESSAGE_REF_EXPORTED,
  PHIS_THREAD_MESSAGE_REF_IMPORTED,
  PHIS_THREAD_PARTICIPANT_KIND_GROUP,
  PHIS_THREAD_PARTICIPANT_KIND_USER,
  PHIS_THREAD_AUTHOR_KIND_INTEGRATION,
  PHIS_THREAD_AUTHOR_KIND_SYSTEM,
  PHIS_THREAD_AUTHOR_KIND_USER,
  siteThreadKindFlagOf,
} from "@/lib/constants/threads";

type DbQueryable = Pick<PoolClient, "query">;

export class PhisThreadError extends Error {}

/**
 * Who is asking, in the only three shapes Core has to tell apart.
 *
 * A person is bounded by the threads they are in. An Add-on with no actor is bounded by what it owns
 * and what somebody linked it to. `system` is Core acting on its own behalf -- a maintenance task, a
 * migration -- and is never reachable from a request.
 */
export type ThreadReader =
  | { kind: "user"; userId: number }
  | { kind: "provider"; providerId: string }
  | { kind: "system" };

export type ThreadListOptions = {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
  kind?: PhisThreadKindValue | null;
  status?: PhisThreadStatusValue | null;
};

export type CreateThreadInput = {
  siteId: number;
  kind: PhisThreadKindValue;
  subject?: string | null;
  message: string;
  messageMarkdown?: string | null;
  messageFlags?: number;
  messageMeta?: Record<string, unknown>;
  participantUserIds?: number[];
  participantGroupIds?: number[];
  requesterUserId?: number | null;
  createdByUserId?: number | null;
  /** The Add-on opening this thread as its own, where no person is behind it. */
  ownerProviderId?: string | null;
  externalRef?: string | null;
  externalAuthor?: { name: string; url?: string } | null;
};

export type AddThreadMessageInput = {
  siteId: number;
  threadId: number;
  reader: ThreadReader;
  message: string;
  messageMarkdown?: string | null;
  messageFlags?: number;
  messageMeta?: Record<string, unknown>;
  externalRef?: string | null;
  externalAuthor?: { name: string; url?: string } | null;
};

export type AddThreadParticipantsInput = {
  siteId: number;
  threadId: number;
  reader: ThreadReader;
  participantUserIds?: number[];
  participantGroupIds?: number[];
};

type ThreadRow = {
  id: number;
  site_id: number;
  kind: number;
  status: number;
  subject: string | null;
  flags: number;
  owner_provider_id: string | null;
  created_by_user_id: number | null;
  last_message_id: number | null;
  last_message_created_at: string | null;
  last_read_message_id: number | null;
  created_at: string;
  updated_at: string;
  total_count?: number;
};

type ThreadMessageRow = {
  id: number;
  author_kind: number;
  author_user_id: number | null;
  author_provider_id: string | null;
  author_display_name: string | null;
  author_company_name: string | null;
  body_text: string;
  body_markdown: string | null;
  flags: number;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ThreadParticipantRow = {
  participant_kind: number;
  user_id: number | null;
  user_display_name: string | null;
  user_company_name: string | null;
  group_id: number | null;
  group_name: string | null;
  flags: number;
};

/**
 * Whether a thread of this kind is offered on this Site at all.
 *
 * Availability is the union of what the Site's active Modules declare, materialized into
 * `site_thread_config` the way declared Media Space kinds are. A Site that declares nothing offers
 * nothing: the absent row answers `0`, which hides threads rather than deleting them, and they return
 * with the Module that declared their kind.
 */
const SITE_KIND_AVAILABLE_SQL = `
  (COALESCE((
    SELECT config.flags
    FROM phis.site_thread_config config
    WHERE config.site_id = t.site_id
  ), 0) & CASE t.kind
    WHEN ${PhisThreadKind.Direct} THEN 1
    WHEN ${PhisThreadKind.Group} THEN 2
    WHEN ${PhisThreadKind.CrossGroup} THEN 4
    WHEN ${PhisThreadKind.Support} THEN 8
    ELSE 0
  END) <> 0`;

/**
 * Whether one person may see one thread.
 *
 * Participation is what grants it, and a group participates as a group: its members are resolved here,
 * so somebody who joined after the thread was opened is in the conversation and somebody who left is
 * not. A retired group grants nothing, and neither does an assertion that has expired -- the same rule
 * the group claims follow, applied in the one place threads ask the question.
 *
 * Opening a thread is not on this list. Whoever opens one is written in as a participant, so "the
 * creator can always see it" needs no second clause -- and a creator who was later removed is out,
 * which a clause on `created_by_user_id` would have quietly prevented.
 */
const USER_MAY_SEE_SQL = (viewerParam: string) => `
  EXISTS (
    SELECT 1
    FROM phis.thread_participants participant
    WHERE participant.thread_id = t.id
      AND (participant.flags & ${PhisThreadParticipantFlag.Left}) = 0
      AND (
        participant.user_id = ${viewerParam}
        OR EXISTS (
          SELECT 1
          FROM phis.site_group_members member
          JOIN phis.site_groups grp
            ON grp.id = member.group_id
          WHERE member.group_id = participant.group_id
            AND member.user_id = ${viewerParam}
            AND member.site_id = t.site_id
            AND grp.retired_at IS NULL
            AND (member.valid_until IS NULL OR member.valid_until > NOW())
        )
      )
  )`;

/**
 * Whether an Add-on with nobody behind it may reach one thread.
 *
 * Two ways in and no third: it opened the thread itself, or a person who could see the thread linked it
 * to something of this Add-on's and marked that link synced. The link is the consent, which is why
 * removing it ends the reach.
 */
const PROVIDER_MAY_SEE_SQL = (providerParam: string) => `
  (
    t.owner_provider_id = ${providerParam}
    OR EXISTS (
      SELECT 1
      FROM phis.resource_links link
      LEFT JOIN phis.support_tickets ticket
        ON ticket.id = link.ticket_id
      LEFT JOIN phis.support_ticket_tasks task
        ON task.id = link.ticket_task_id
      LEFT JOIN phis.support_tickets task_ticket
        ON task_ticket.id = task.ticket_id
      WHERE link.provider_id = ${providerParam}
        AND link.site_id = t.site_id
        AND (link.flags & ${PhisResourceLinkFlag.Synced}) <> 0
        AND (
          link.thread_id = t.id
          OR ticket.thread_id = t.id
          OR task_ticket.thread_id = t.id
        )
    )
  )`;

function readerPredicate(reader: ThreadReader, param: string) {
  if (reader.kind === "system") {
    return "TRUE";
  }
  return reader.kind === "user" ? USER_MAY_SEE_SQL(param) : PROVIDER_MAY_SEE_SQL(param);
}

function readerParamValue(reader: ThreadReader) {
  if (reader.kind === "user") return reader.userId;
  if (reader.kind === "provider") return reader.providerId;
  return null;
}

/**
 * Whether this reader is Staff, which is what `Internal` messages are withheld from.
 *
 * Any Core role makes somebody Staff, `Staff` itself included, and an Add-on's roles make nobody. A
 * reader that is not a person is not Staff either: an integration mirrors a conversation outwards, and
 * a note written past the customer is the one thing that must not go.
 */
async function readerIsStaff(db: DbQueryable, siteId: number, reader: ThreadReader) {
  if (reader.kind === "system") return true;
  if (reader.kind !== "user") return false;

  const { rows } = await db.query<{ role_flags: number }>(
    `SELECT role_flags
     FROM phis.user_site_role_claims
     WHERE site_id = $1
       AND user_id = $2
       AND provider_id = $3`,
    [siteId, reader.userId, PHI_CORE_ROLE_PROVIDER_ID],
  );
  // Any Core role at all, which `Staff` is one of: the bit exists for somebody who holds none of the
  // others, not as a second question to ask after them.
  return (rows[0]?.role_flags ?? 0) !== 0;
}

function projectThread(row: ThreadRow): PhisThreadSummary {
  return {
    id: row.id,
    kind: row.kind as PhisThreadKindValue,
    status: row.status as PhisThreadStatusValue,
    flags: row.flags,
    subject: row.subject,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestMessageAt: row.last_message_created_at,
    unread:
      row.last_message_id != null
      && row.last_message_id > (row.last_read_message_id ?? 0),
  };
}

function projectAuthor(row: ThreadMessageRow): PhisThreadMessageAuthor {
  if (row.author_kind === PHIS_THREAD_AUTHOR_KIND_INTEGRATION) {
    const meta = row.meta ?? {};
    const name = typeof meta.externalAuthorName === "string" ? meta.externalAuthorName : null;
    const url = typeof meta.externalAuthorUrl === "string" ? meta.externalAuthorUrl : null;
    return {
      kind: "integration",
      providerId: row.author_provider_id ?? "",
      externalName: name,
      externalUrl: url,
    };
  }

  if (row.author_kind === PHIS_THREAD_AUTHOR_KIND_USER) {
    return {
      kind: "user",
      user: {
        userId: row.author_user_id ?? 0,
        displayName: row.author_display_name,
        companyName: row.author_company_name,
      },
    };
  }

  return { kind: "system" };
}

/**
 * Projects one message for one reader.
 *
 * `Confidential` is where a message may go rather than who may read it, so the text is withheld from
 * everything that is not a person on this Site -- an Add-on included, whatever its actor could read --
 * while the flag itself is handed over, so an interface can say why there is nothing to show.
 */
function projectMessage(row: ThreadMessageRow, reader: ThreadReader): PhisThreadMessage {
  const withheld =
    (row.flags & PhisThreadMessageFlag.Redacted) !== 0
    || ((row.flags & PhisThreadMessageFlag.Confidential) !== 0 && reader.kind === "provider");

  return {
    id: row.id,
    author: projectAuthor(row),
    bodyText: withheld ? null : row.body_text,
    bodyMarkdown: withheld ? null : row.body_markdown,
    flags: row.flags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectParticipant(row: ThreadParticipantRow): PhisThreadParticipant {
  if (row.participant_kind === PHIS_THREAD_PARTICIPANT_KIND_GROUP) {
    return {
      kind: "group",
      groupId: row.group_id ?? 0,
      name: row.group_name ?? "",
      flags: row.flags,
    };
  }

  return {
    kind: "user",
    user: {
      userId: row.user_id ?? 0,
      displayName: row.user_display_name,
      companyName: row.user_company_name,
    },
    flags: row.flags,
  };
}

const THREAD_COLUMNS = `
  t.id,
  t.site_id,
  t.kind,
  t.status,
  t.subject,
  t.flags,
  t.owner_provider_id,
  t.created_by_user_id,
  t.last_message_id,
  latest.created_at AS last_message_created_at,
  t.created_at,
  t.updated_at`;

function normalizeUniqueIds(values: readonly number[] | undefined) {
  return [...new Set((values ?? []).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/**
 * The threads a reader may see, newest activity first.
 *
 * Only a person has an inbox. An Add-on's reach is made of ownership and links, which answers "may I
 * touch this one" and never "what is there" -- so a listing for a provider would have to invent an
 * order over a Site's conversations, which is the walk the capability exists to prevent.
 */
export async function listThreadsForUser(
  siteId: number,
  userId: number,
  options: ThreadListOptions = {},
) {
  const pool = getPool();
  const params: unknown[] = [siteId, userId];
  const conditions = [
    "t.site_id = $1",
    SITE_KIND_AVAILABLE_SQL,
    USER_MAY_SEE_SQL("$2"),
  ];

  if (options.kind != null) {
    params.push(options.kind);
    conditions.push(`t.kind = $${params.length}`);
  }
  if (options.status != null) {
    params.push(options.status);
    conditions.push(`t.status = $${params.length}`);
  }

  const pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 25) || 25));
  const page = Math.max(1, Math.trunc(options.page ?? 1) || 1);
  params.push(pageSize, (page - 1) * pageSize);

  const unreadCondition = options.unreadOnly
    ? `AND t.last_message_id IS NOT NULL
       AND t.last_message_id > COALESCE(reads.last_read_message_id, 0)`
    : "";

  const { rows } = await pool.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS},
            reads.last_read_message_id,
            COUNT(*) OVER () AS total_count
     FROM phis.threads t
     LEFT JOIN phis.thread_messages latest
       ON latest.id = t.last_message_id
     LEFT JOIN phis.thread_reads reads
       ON reads.thread_id = t.id
      AND reads.user_id = $2
     WHERE ${conditions.join("\n       AND ")}
       ${unreadCondition}
     ORDER BY t.updated_at DESC, t.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    rows: rows.map(projectThread),
    total: Number(rows[0]?.total_count ?? 0),
    page,
    pageSize,
  };
}

async function readThreadRow(
  db: DbQueryable,
  siteId: number,
  reader: ThreadReader,
  threadId: number,
) {
  const params: unknown[] = [siteId, threadId];
  const readerValue = readerParamValue(reader);
  let readerParam = "$0";
  if (readerValue != null) {
    params.push(readerValue);
    readerParam = `$${params.length}`;
  }
  const viewerUserId = reader.kind === "user" ? reader.userId : null;
  params.push(viewerUserId);
  const readsParam = `$${params.length}`;

  const { rows } = await db.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS},
            reads.last_read_message_id
     FROM phis.threads t
     LEFT JOIN phis.thread_messages latest
       ON latest.id = t.last_message_id
     LEFT JOIN phis.thread_reads reads
       ON reads.thread_id = t.id
      AND reads.user_id = ${readsParam}
     WHERE t.site_id = $1
       AND t.id = $2
       AND ${SITE_KIND_AVAILABLE_SQL}
       AND ${readerPredicate(reader, readerParam)}`,
    params,
  );

  return rows[0] ?? null;
}

async function readParticipants(db: DbQueryable, threadId: number) {
  const { rows } = await db.query<ThreadParticipantRow>(
    `SELECT participant.participant_kind,
            participant.user_id,
            participant.group_id,
            participant.flags,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''),
              account.email_normalized
            ) AS user_display_name,
            profile.company_name AS user_company_name,
            grp.name AS group_name
     FROM phis.thread_participants participant
     LEFT JOIN phis.user_account_directory account
       ON account.id = participant.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = participant.user_id
     LEFT JOIN phis.site_groups grp
       ON grp.id = participant.group_id
     WHERE participant.thread_id = $1
     ORDER BY participant.participant_kind ASC, participant.id ASC`,
    [threadId],
  );
  return rows;
}

async function readMessageWindow(
  db: DbQueryable,
  threadId: number,
  options: { limit: number; beforeMessageId: number | null; includeInternal: boolean },
) {
  const params: unknown[] = [threadId, options.limit + 1];
  const conditions = ["message.thread_id = $1"];
  if (!options.includeInternal) {
    conditions.push(`(message.flags & ${PhisThreadMessageFlag.Internal}) = 0`);
  }
  if (options.beforeMessageId != null) {
    params.push(options.beforeMessageId);
    conditions.push(`message.id < $${params.length}`);
  }

  const { rows } = await db.query<ThreadMessageRow>(
    `SELECT message.id,
            message.author_kind,
            message.author_user_id,
            message.author_provider_id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''),
              account.email_normalized
            ) AS author_display_name,
            profile.company_name AS author_company_name,
            message.body_text,
            message.body_markdown,
            message.flags,
            message.meta,
            message.created_at,
            message.updated_at
     FROM phis.thread_messages message
     LEFT JOIN phis.user_account_directory account
       ON account.id = message.author_user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = message.author_user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY message.created_at DESC, message.id DESC
     LIMIT $2`,
    params,
  );

  const hasMore = rows.length > options.limit;
  return {
    messages: hasMore ? rows.slice(0, options.limit).reverse() : rows.reverse(),
    hasMore,
  };
}

export async function getThreadDetail(
  siteId: number,
  reader: ThreadReader,
  threadId: number,
  options: { messageLimit?: number; beforeMessageId?: number | null } = {},
): Promise<PhisThreadDetail | null> {
  const pool = getPool();
  const thread = await readThreadRow(pool, siteId, reader, threadId);
  if (!thread) {
    return null;
  }

  const limit = Math.max(
    1,
    Math.min(PHIS_THREAD_MESSAGE_MAX_PAGE_SIZE, options.messageLimit ?? PHIS_THREAD_MESSAGE_PAGE_SIZE),
  );
  const includeInternal = await readerIsStaff(pool, siteId, reader);
  const [participants, window] = await Promise.all([
    readParticipants(pool, threadId),
    readMessageWindow(pool, threadId, {
      limit,
      beforeMessageId: options.beforeMessageId ?? null,
      includeInternal,
    }),
  ]);

  return {
    thread: projectThread(thread),
    participants: participants.map(projectParticipant),
    messages: window.messages.map((row) => projectMessage(row, reader)),
    hasMoreMessages: window.hasMore,
  };
}

/**
 * Normalizes what a writer asked for against what they are.
 *
 * `Internal` is Staff's to set, because it is what a note past a customer is made of; `Imported` and
 * `Edited` are Core's own record of where a message came from. What is left -- `Confidential` -- anybody
 * may set, including the customer who just pasted a password into a Support thread.
 */
function normalizeMessageFlags(requested: number | undefined, input: {
  isStaff: boolean;
  imported: boolean;
}) {
  const asked = Number.isSafeInteger(requested) ? (requested as number) : 0;
  let flags = asked & PhisThreadMessageFlag.Confidential;
  if (input.isStaff && (asked & PhisThreadMessageFlag.Internal) !== 0) {
    flags |= PhisThreadMessageFlag.Internal;
  }
  if (input.imported) {
    flags |= PhisThreadMessageFlag.Imported;
  }
  return flags;
}

function authorMeta(
  meta: Record<string, unknown> | undefined,
  externalAuthor: { name: string; url?: string } | null | undefined,
) {
  const base = { ...(meta ?? {}) };
  if (externalAuthor?.name) {
    base.externalAuthorName = externalAuthor.name;
  }
  if (externalAuthor?.url) {
    base.externalAuthorUrl = externalAuthor.url;
  }
  return base;
}

async function assertParticipantsExist(
  db: DbQueryable,
  siteId: number,
  userIds: number[],
  groupIds: number[],
) {
  if (userIds.length > 0) {
    const { rows } = await db.query<{ user_id: number }>(
      `SELECT membership.user_id
       FROM phis.user_site_memberships membership
       WHERE membership.site_id = $1
         AND membership.user_id = ANY($2::int[])`,
      [siteId, userIds],
    );
    if (rows.length !== userIds.length) {
      throw new PhisThreadError("One or more thread participants are not members of this Site.");
    }
  }

  if (groupIds.length > 0) {
    const { rows } = await db.query<{ id: number }>(
      `SELECT grp.id
       FROM phis.site_groups grp
       WHERE grp.site_id = $1
         AND grp.id = ANY($2::int[])
         AND grp.retired_at IS NULL`,
      [siteId, groupIds],
    );
    if (rows.length !== groupIds.length) {
      throw new PhisThreadError("One or more thread participant groups are invalid for this Site.");
    }
  }
}

async function insertParticipants(
  db: DbQueryable,
  input: {
    threadId: number;
    userIds: number[];
    groupIds: number[];
    requesterUserId?: number | null;
  },
) {
  for (const userId of input.userIds) {
    const flags = userId === input.requesterUserId ? PhisThreadParticipantFlag.Requester : 0;
    await db.query(
      `INSERT INTO phis.thread_participants (thread_id, participant_kind, user_id, flags)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [input.threadId, PHIS_THREAD_PARTICIPANT_KIND_USER, userId, flags],
    );
  }

  for (const groupId of input.groupIds) {
    await db.query(
      `INSERT INTO phis.thread_participants (thread_id, participant_kind, group_id, flags)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT DO NOTHING`,
      [input.threadId, PHIS_THREAD_PARTICIPANT_KIND_GROUP, groupId],
    );
  }
}

async function insertMessage(
  db: DbQueryable,
  input: {
    siteId: number;
    threadId: number;
    authorUserId: number | null;
    authorProviderId: string | null;
    bodyText: string;
    bodyMarkdown: string | null;
    flags: number;
    meta: Record<string, unknown>;
    externalRef?: string | null;
  },
) {
  const authorKind = input.authorProviderId
    ? PHIS_THREAD_AUTHOR_KIND_INTEGRATION
    : input.authorUserId != null
      ? PHIS_THREAD_AUTHOR_KIND_USER
      : PHIS_THREAD_AUTHOR_KIND_SYSTEM;

  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO phis.thread_messages (
       thread_id,
       author_kind,
       author_user_id,
       author_provider_id,
       body_text,
       body_markdown,
       flags,
       meta
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING id`,
    [
      input.threadId,
      authorKind,
      input.authorUserId,
      input.authorProviderId,
      input.bodyText,
      input.bodyMarkdown,
      input.flags,
      JSON.stringify(input.meta),
    ],
  );

  const messageId = rows[0]?.id;
  if (!messageId) {
    throw new PhisThreadError("Failed to write the thread message.");
  }

  if (input.externalRef && input.authorProviderId) {
    await db.query(
      `INSERT INTO phis.thread_message_refs (site_id, provider_id, external_id, message_id, flags)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.siteId,
        input.authorProviderId,
        input.externalRef,
        messageId,
        PHIS_THREAD_MESSAGE_REF_IMPORTED,
      ],
    );
  }

  await db.query(
    `UPDATE phis.threads
     SET last_message_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [input.threadId, messageId],
  );

  if (input.authorUserId != null) {
    await db.query(
      `INSERT INTO phis.thread_reads (thread_id, user_id, last_read_message_id, read_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (thread_id, user_id) DO UPDATE
       SET last_read_message_id = EXCLUDED.last_read_message_id,
           read_at = EXCLUDED.read_at`,
      [input.threadId, input.authorUserId, messageId],
    );
  }

  /*
   * What the linked Add-ons are owed, written with the message rather than after it.
   *
   * `exceptProviderId` is the author: a message an integration just imported is not news to that
   * integration, and telling it anyway is how two systems come to write the same sentence to each
   * other without end.
   */
  await enqueuePhisAddonThreadEventWithDb(db, {
    siteId: input.siteId,
    threadId: input.threadId,
    event: PHIS_ADDON_EVENTS.threadMessageCreated,
    payload: { messageId },
    exceptProviderId: input.authorProviderId,
  });

  return messageId;
}

/**
 * Whether the Site offers this kind of thread, asked before one is written.
 *
 * The listing predicate asks the same question, so a thread whose kind is not offered would be written
 * and then be invisible to everybody, including whoever wrote it.
 */
async function assertKindAvailable(db: DbQueryable, siteId: number, kind: PhisThreadKindValue) {
  const { rows } = await db.query<{ flags: number }>(
    `SELECT flags FROM phis.site_thread_config WHERE site_id = $1`,
    [siteId],
  );
  const flags = rows[0]?.flags ?? 0;
  if ((flags & siteThreadKindFlagOf(kind)) === 0) {
    throw new PhisThreadError("This Site does not offer threads of this kind.");
  }
}

/**
 * Opens a thread on a caller's own transaction.
 *
 * A Support ticket and its thread are written together or not at all -- a ticket whose conversation
 * failed to open is a record nobody can answer -- so the work is here, on whatever handle the caller
 * already holds, and `createThread` is the same thing with a transaction of its own around it.
 */
export async function createThreadWithDb(
  client: DbQueryable,
  input: CreateThreadInput,
): Promise<{ id: number }> {
  {
    await assertKindAvailable(client, input.siteId, input.kind);

    const userIds = normalizeUniqueIds(input.participantUserIds);
    const groupIds = normalizeUniqueIds(input.participantGroupIds);
    const openerId = input.createdByUserId ?? null;
    const participantUserIds = openerId != null && !userIds.includes(openerId)
      ? [...userIds, openerId]
      : userIds;

    if (participantUserIds.length === 0 && groupIds.length === 0) {
      throw new PhisThreadError("A thread needs at least one participant.");
    }
    await assertParticipantsExist(client, input.siteId, participantUserIds, groupIds);

    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO phis.threads (
         site_id,
         kind,
         status,
         subject,
         flags,
         owner_provider_id,
         created_by_user_id
       )
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       RETURNING id`,
      [
        input.siteId,
        input.kind,
        PhisThreadStatus.Open,
        input.subject ?? null,
        input.ownerProviderId ?? null,
        openerId,
      ],
    );

    const threadId = rows[0]?.id;
    if (!threadId) {
      throw new PhisThreadError("Failed to open the thread.");
    }

    await insertParticipants(client, {
      threadId,
      userIds: participantUserIds,
      groupIds,
      requesterUserId: input.requesterUserId ?? null,
    });

    const isStaff = await readerIsStaff(
      client,
      input.siteId,
      openerId != null ? { kind: "user", userId: openerId } : { kind: "system" },
    );

    await insertMessage(client, {
      siteId: input.siteId,
      threadId,
      authorUserId: openerId,
      authorProviderId: input.ownerProviderId ?? null,
      bodyText: input.message,
      bodyMarkdown: input.messageMarkdown ?? null,
      flags: normalizeMessageFlags(input.messageFlags, {
        isStaff,
        imported: Boolean(input.externalRef),
      }),
      meta: authorMeta(input.messageMeta, input.externalAuthor),
      externalRef: input.externalRef ?? null,
    });

    return { id: threadId };
  }
}

export async function createThread(input: CreateThreadInput): Promise<PhisThreadDetail> {
  const pool = getPool();
  const client = await pool.connect();
  let threadId: number;

  try {
    await client.query("BEGIN");
    threadId = (await createThreadWithDb(client, input)).id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  schedulePhisAddonEventDelivery(input.siteId);

  const openerId = input.createdByUserId ?? null;
  const reader: ThreadReader = openerId != null
    ? { kind: "user", userId: openerId }
    : input.ownerProviderId
      ? { kind: "provider", providerId: input.ownerProviderId }
      : { kind: "system" };
  const detail = await getThreadDetail(input.siteId, reader, threadId);
  if (!detail) {
    throw new PhisThreadError("The thread was opened and could not be read back.");
  }
  return detail;
}

/**
 * Adds a message to a thread the reader may reach.
 *
 * Idempotent where an integration names its own reference: the same `externalRef` answers with the
 * thread as it stands rather than writing a second message, which is what a webhook delivered twice
 * needs.
 */
export async function addThreadMessage(input: AddThreadMessageInput): Promise<PhisThreadDetail | null> {
  const pool = getPool();
  const providerId = input.reader.kind === "provider" ? input.reader.providerId : null;

  if (input.externalRef && providerId) {
    const { rows } = await pool.query<{ message_id: number }>(
      `SELECT message_id
       FROM phis.thread_message_refs
       WHERE site_id = $1 AND provider_id = $2 AND external_id = $3`,
      [input.siteId, providerId, input.externalRef],
    );
    if (rows[0]) {
      return getThreadDetail(input.siteId, input.reader, input.threadId);
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const thread = await readThreadRow(client, input.siteId, input.reader, input.threadId);
    if (!thread) {
      await client.query("ROLLBACK");
      return null;
    }
    if (thread.status !== PhisThreadStatus.Open) {
      throw new PhisThreadError("This thread is archived.");
    }

    const authorUserId = input.reader.kind === "user" ? input.reader.userId : null;
    const isStaff = await readerIsStaff(client, input.siteId, input.reader);

    await insertMessage(client, {
      siteId: input.siteId,
      threadId: input.threadId,
      authorUserId,
      authorProviderId: providerId,
      bodyText: input.message,
      bodyMarkdown: input.messageMarkdown ?? null,
      flags: normalizeMessageFlags(input.messageFlags, {
        isStaff,
        imported: Boolean(input.externalRef),
      }),
      meta: authorMeta(input.messageMeta, input.externalAuthor),
      externalRef: input.externalRef ?? null,
    });

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  schedulePhisAddonEventDelivery(input.siteId);

  return getThreadDetail(input.siteId, input.reader, input.threadId);
}

export async function addThreadParticipants(
  input: AddThreadParticipantsInput,
): Promise<PhisThreadDetail | null> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const thread = await readThreadRow(client, input.siteId, input.reader, input.threadId);
    if (!thread) {
      await client.query("ROLLBACK");
      return null;
    }

    const userIds = normalizeUniqueIds(input.participantUserIds);
    const groupIds = normalizeUniqueIds(input.participantGroupIds);
    if (userIds.length === 0 && groupIds.length === 0) {
      await client.query("ROLLBACK");
      return getThreadDetail(input.siteId, input.reader, input.threadId);
    }

    await assertParticipantsExist(client, input.siteId, userIds, groupIds);
    await insertParticipants(client, { threadId: input.threadId, userIds, groupIds });
    await client.query(
      `UPDATE phis.threads SET updated_at = NOW() WHERE id = $1`,
      [input.threadId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getThreadDetail(input.siteId, input.reader, input.threadId);
}

/**
 * Moves a thread between open and archived.
 *
 * On a transaction, although the update is one statement, because it is not the only thing that has to
 * happen: the Add-ons linked to this thread are owed the change, and a notification written outside the
 * transaction that caused it is one that can survive a rollback and announce something that never was.
 *
 * A status that is already the one asked for answers yes and writes nothing -- the caller wanted the
 * thread archived and it is, which is not a failure and is not a change worth telling anybody about.
 */
export async function setThreadStatus(input: {
  siteId: number;
  threadId: number;
  reader: ThreadReader;
  status: PhisThreadStatusValue;
}) {
  const pool = getPool();
  const client = await pool.connect();
  let changed = false;
  let seen = false;

  try {
    await client.query("BEGIN");
    const thread = await readThreadRow(client, input.siteId, input.reader, input.threadId);
    if (thread) {
      seen = true;
      const { rowCount } = await client.query(
        `UPDATE phis.threads
         SET status = $2,
             updated_at = NOW()
         WHERE id = $1
           AND status IS DISTINCT FROM $2`,
        [input.threadId, input.status],
      );
      changed = (rowCount ?? 0) > 0;
      if (changed) {
        await enqueuePhisAddonThreadEventWithDb(client, {
          siteId: input.siteId,
          threadId: input.threadId,
          event: PHIS_ADDON_EVENTS.threadStatusChanged,
          payload: { status: input.status },
          exceptProviderId: input.reader.kind === "provider" ? input.reader.providerId : null,
        });
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (changed) {
    schedulePhisAddonEventDelivery(input.siteId);
  }
  return seen;
}

export async function markThreadRead(
  siteId: number,
  userId: number,
  threadId: number,
  messageId?: number | null,
) {
  const pool = getPool();
  const thread = await readThreadRow(pool, siteId, { kind: "user", userId }, threadId);
  if (!thread) {
    return false;
  }

  await pool.query(
    `INSERT INTO phis.thread_reads (thread_id, user_id, last_read_message_id, read_at)
     VALUES ($1, $2, COALESCE($3::int, $4::int), NOW())
     ON CONFLICT (thread_id, user_id) DO UPDATE
     SET last_read_message_id = GREATEST(
           COALESCE(phis.thread_reads.last_read_message_id, 0),
           COALESCE(EXCLUDED.last_read_message_id, 0)
         ),
         read_at = EXCLUDED.read_at`,
    [threadId, userId, messageId ?? null, thread.last_message_id],
  );
  return true;
}

/**
 * The thread carrying one of an Add-on's own message references.
 *
 * How an actorless Add-on arrives at a thread at all: it finds its way back to a conversation it
 * already recorded something about, and to no other. The reach is still checked, so a reference that
 * outlived its link answers null.
 */
export async function findThreadByExternalRef(input: {
  siteId: number;
  providerId: string;
  externalRef: string;
}): Promise<PhisThreadDetail | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ thread_id: number }>(
    `SELECT message.thread_id
     FROM phis.thread_message_refs ref
     JOIN phis.thread_messages message
       ON message.id = ref.message_id
     WHERE ref.site_id = $1
       AND ref.provider_id = $2
       AND ref.external_id = $3`,
    [input.siteId, input.providerId, input.externalRef],
  );

  const threadId = rows[0]?.thread_id;
  if (!threadId) {
    return null;
  }
  return getThreadDetail(
    input.siteId,
    { kind: "provider", providerId: input.providerId },
    threadId,
  );
}

/** Records that a message left for an integration, so it is never exported twice. */
export async function recordThreadMessageExport(input: {
  siteId: number;
  providerId: string;
  externalId: string;
  messageId: number;
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO phis.thread_message_refs (site_id, provider_id, external_id, message_id, flags)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, provider_id, external_id) DO NOTHING`,
    [
      input.siteId,
      input.providerId,
      input.externalId,
      input.messageId,
      PHIS_THREAD_MESSAGE_REF_EXPORTED,
    ],
  );
}

/** Which kinds of thread this Site offers, as the materialized flags say. */
export async function readSiteThreadKinds(siteId: number) {
  const pool = getPool();
  const { rows } = await pool.query<{ flags: number; requester_window_days: number }>(
    `SELECT flags, requester_window_days
     FROM phis.site_thread_config
     WHERE site_id = $1`,
    [siteId],
  );
  return {
    flags: rows[0]?.flags ?? 0,
    requesterWindowDays: rows[0]?.requester_window_days ?? 14,
  };
}

/**
 * Who this person may address, and in what.
 *
 * Visibility runs through groups: somebody is offered here because the actor already shares a group
 * with them, which is the same reason they can be seen at all. The Site's user list stays out of it --
 * a picker that could name anybody would be a directory, and an address is never part of the answer.
 *
 * Admin and Developer are the one widening, and it is authority to *reach* rather than to read: they
 * may open a thread with any Staff member without sharing a group, which is what makes "ask the one
 * person who knows" possible on a Site where not everybody is grouped together. It opens no thread they
 * are not in.
 */
export async function listThreadCandidates(siteId: number, userId: number) {
  const pool = getPool();

  const { rows: roleRows } = await pool.query<{ role_flags: number }>(
    `SELECT role_flags
     FROM phis.user_site_role_claims
     WHERE site_id = $1 AND user_id = $2 AND provider_id = $3`,
    [siteId, userId, PHI_CORE_ROLE_PROVIDER_ID],
  );
  const actorRoleFlags = roleRows[0]?.role_flags ?? 0;
  const mayReachAllStaff = (actorRoleFlags & (PhiBaseRole.Admin | PhiBaseRole.Developer)) !== 0;

  const { rows: groups } = await pool.query<{
    id: number;
    name: string;
    flags: number;
  }>(
    `SELECT grp.id, grp.name, grp.flags
     FROM phis.site_groups grp
     JOIN phis.site_group_members member
       ON member.group_id = grp.id
      AND member.site_id = grp.site_id
     WHERE grp.site_id = $1
       AND member.user_id = $2
       AND grp.retired_at IS NULL
       AND (member.valid_until IS NULL OR member.valid_until > NOW())
     ORDER BY grp.name ASC, grp.id ASC`,
    [siteId, userId],
  );

  const { rows: users } = await pool.query<{
    id: number;
    display_name: string | null;
    company_name: string | null;
    show_company: boolean;
  }>(
    `SELECT DISTINCT ON (account.id)
            account.id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''),
              account.email_normalized
            ) AS display_name,
            profile.company_name,
            BOOL_OR((COALESCE(grp.flags, 0) & $4) <> 0) OVER (PARTITION BY account.id) AS show_company
     FROM phis.user_site_role_claims claim
     JOIN phis.user_account_directory account
       ON account.id = claim.user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = account.id
     LEFT JOIN phis.site_group_members member
       ON member.user_id = account.id
      AND member.site_id = claim.site_id
      AND (member.valid_until IS NULL OR member.valid_until > NOW())
     LEFT JOIN phis.site_groups grp
       ON grp.id = member.group_id
      AND grp.retired_at IS NULL
     WHERE claim.site_id = $1
       AND claim.provider_id = $3
       AND claim.role_flags <> 0
       AND account.id <> $2
       AND (
         $5
         OR EXISTS (
           SELECT 1
           FROM phis.site_group_members shared
           JOIN phis.site_groups shared_group
             ON shared_group.id = shared.group_id
           WHERE shared.group_id = member.group_id
             AND shared.user_id = $2
             AND shared.site_id = claim.site_id
             AND shared_group.retired_at IS NULL
             AND (shared.valid_until IS NULL OR shared.valid_until > NOW())
         )
       )
     ORDER BY account.id, display_name ASC`,
    [siteId, userId, PHI_CORE_ROLE_PROVIDER_ID, PhiSiteGroupFlags.ShowMemberCompany, mayReachAllStaff],
  );

  return {
    users: users.map((row) => ({
      userId: row.id,
      displayName: row.display_name,
      companyName: row.show_company ? row.company_name : null,
    })),
    groups: groups.map((row) => ({ id: row.id, name: row.name, flags: row.flags })),
  };
}

/**
 * Recomputes which kinds of thread the Site offers and writes the result to its thread configuration.
 *
 * The same shape declared Media Space kinds take, and for the same reason: availability is the union of
 * what the Modules of every *published* Area declare, so a draft never widens a running Site and
 * removing the last Module that declared a kind narrows it again on publish. Narrowing hides threads
 * rather than deleting anything.
 */
export async function materializeSiteThreadKindsWithDb(db: DbQueryable, siteId: number) {
  const { rows } = await db.query<{ kinds: unknown }>(
    `SELECT revision.tree_json #> '{preset,config,modules,threadKinds}' AS kinds
     FROM phis.site_area_scopes scope
     JOIN phis.site_area_revisions revision ON revision.id = scope.published_revision_id
     WHERE scope.site_id = $1`,
    [siteId],
  );

  const declared = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row.kinds)) {
      for (const kind of row.kinds) {
        if (typeof kind === "string") declared.add(kind);
      }
    }
  }

  // A kind this release does not know is ignored rather than refused: a newer Module must not make an
  // older control plane reject a publish. The names come from the contract both ends read, so a Module
  // and this materialization cannot drift into spelling the same kind two ways.
  let flags = 0;
  for (const kind of PHIS_DECLARABLE_THREAD_KINDS) {
    if (declared.has(kind)) {
      flags |= PHIS_SITE_THREAD_KIND_FLAG_BY_DECLARATION[kind];
    }
  }

  await db.query(
    `INSERT INTO phis.site_thread_config (site_id, flags)
     VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE
     SET flags = EXCLUDED.flags,
         updated_at = NOW()
     WHERE phis.site_thread_config.flags IS DISTINCT FROM EXCLUDED.flags`,
    [siteId, flags],
  );
  return flags;
}
