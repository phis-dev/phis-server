import "server-only";

import type {
  PhisResourceLink,
  PhisResourceLinkSubject,
} from "@phis/contracts/addon";

import { getPool } from "@/lib/db";

export class PhisResourceLinkError extends Error {}

type ResourceLinkRow = {
  id: number;
  thread_id: number | null;
  ticket_id: number | null;
  ticket_task_id: number | null;
  type: number;
  external_id: string;
  url: string | null;
  state: number | null;
  flags: number;
  created_at: string;
  updated_at: string;
};

/**
 * The subject, as a column rather than a kind and a bare integer.
 *
 * Three nullable references with a check that exactly one is set. A polymorphic id would have no
 * foreign key, and a link whose subject has been deleted is a row nothing cleans up.
 */
function subjectColumn(subject: PhisResourceLinkSubject) {
  switch (subject.kind) {
    case "thread":
      return "thread_id";
    case "ticket":
      return "ticket_id";
    case "ticketTask":
      return "ticket_task_id";
    default:
      throw new PhisResourceLinkError("Unknown resource link subject.");
  }
}

function projectLink(row: ResourceLinkRow): PhisResourceLink {
  const subject: PhisResourceLinkSubject = row.thread_id != null
    ? { kind: "thread", id: row.thread_id }
    : row.ticket_id != null
      ? { kind: "ticket", id: row.ticket_id }
      : { kind: "ticketTask", id: row.ticket_task_id ?? 0 };

  return {
    id: row.id,
    subject,
    type: row.type,
    externalId: row.external_id,
    url: row.url,
    state: row.state,
    flags: row.flags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const LINK_COLUMNS = `
  link.id,
  link.thread_id,
  link.ticket_id,
  link.ticket_task_id,
  link.type,
  link.external_id,
  link.url,
  link.state,
  link.flags,
  link.created_at,
  link.updated_at`;

/**
 * Whether the acting user may reach the subject a link is about.
 *
 * A link says two things belong together, so it is bounded by the one whose visibility is already
 * decided: a thread the person is in, or the thread of the ticket or task in question. Support work is
 * reached through its ticket's thread for the same reason -- there is one answer to "may this person
 * see this conversation", and a second one on the ticket row would eventually disagree with it.
 */
async function resolveSubjectThreadId(
  siteId: number,
  subject: PhisResourceLinkSubject,
): Promise<number | null> {
  const pool = getPool();

  if (subject.kind === "thread") {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM phis.threads WHERE site_id = $1 AND id = $2`,
      [siteId, subject.id],
    );
    return rows[0]?.id ?? null;
  }

  if (subject.kind === "ticket") {
    const { rows } = await pool.query<{ thread_id: number }>(
      `SELECT thread_id FROM phis.support_tickets WHERE site_id = $1 AND id = $2`,
      [siteId, subject.id],
    );
    return rows[0]?.thread_id ?? null;
  }

  const { rows } = await pool.query<{ thread_id: number }>(
    `SELECT ticket.thread_id
     FROM phis.support_ticket_tasks task
     JOIN phis.support_tickets ticket
       ON ticket.id = task.ticket_id
     WHERE ticket.site_id = $1
       AND task.id = $2`,
    [siteId, subject.id],
  );
  return rows[0]?.thread_id ?? null;
}

export async function listResourceLinks(input: {
  siteId: number;
  providerId: string;
  subject: PhisResourceLinkSubject;
}): Promise<PhisResourceLink[]> {
  const pool = getPool();
  const column = subjectColumn(input.subject);
  const { rows } = await pool.query<ResourceLinkRow>(
    `SELECT ${LINK_COLUMNS}
     FROM phis.resource_links link
     WHERE link.site_id = $1
       AND link.provider_id = $2
       AND link.${column} = $3
     ORDER BY link.id ASC`,
    [input.siteId, input.providerId, input.subject.id],
  );
  return rows.map(projectLink);
}

/**
 * Records a reference, or hands back the one that is already there.
 *
 * Asking twice is how an id is learned, the way a declared group's is: the external id is unique per
 * Site and provider, so a second call answers with the first link instead of failing. The subject is
 * checked to exist on this Site before anything is written; whether the acting user may reach it is
 * the caller's question, asked with the answer this module returns from `resolveSubjectThreadId`.
 */
export async function upsertResourceLink(input: {
  siteId: number;
  providerId: string;
  subject: PhisResourceLinkSubject;
  type: number;
  externalId: string;
  url?: string | null;
  state?: number | null;
  flags?: number;
  createdByUserId?: number | null;
}): Promise<PhisResourceLink> {
  const pool = getPool();
  const column = subjectColumn(input.subject);
  const threadId = await resolveSubjectThreadId(input.siteId, input.subject);
  if (threadId == null) {
    throw new PhisResourceLinkError("The link subject does not exist on this Site.");
  }

  const { rows } = await pool.query<ResourceLinkRow>(
    `INSERT INTO phis.resource_links (
       site_id,
       ${column},
       provider_id,
       type,
       external_id,
       url,
       state,
       flags,
       created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (site_id, provider_id, type, external_id) DO UPDATE
     SET url = COALESCE(EXCLUDED.url, phis.resource_links.url),
         state = COALESCE(EXCLUDED.state, phis.resource_links.state),
         updated_at = NOW()
     RETURNING ${LINK_COLUMNS.replaceAll("link.", "phis.resource_links.")}`,
    [
      input.siteId,
      input.subject.id,
      input.providerId,
      input.type,
      input.externalId,
      input.url ?? null,
      input.state ?? null,
      input.flags ?? 0,
      input.createdByUserId ?? null,
    ],
  );

  const row = rows[0];
  if (!row) {
    throw new PhisResourceLinkError("Failed to record the resource link.");
  }
  return projectLink(row);
}

export async function setResourceLinkState(input: {
  siteId: number;
  providerId: string;
  linkId: number;
  state: number | null;
}) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE phis.resource_links
     SET state = $4,
         updated_at = NOW()
     WHERE id = $3
       AND site_id = $1
       AND provider_id = $2`,
    [input.siteId, input.providerId, input.linkId, input.state],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteResourceLink(input: {
  siteId: number;
  providerId: string;
  linkId: number;
}) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.resource_links
     WHERE id = $3
       AND site_id = $1
       AND provider_id = $2`,
    [input.siteId, input.providerId, input.linkId],
  );
  return (rowCount ?? 0) > 0;
}

export async function findResourceLinkByExternalId(input: {
  siteId: number;
  providerId: string;
  type: number;
  externalId: string;
}): Promise<PhisResourceLink | null> {
  const pool = getPool();
  const { rows } = await pool.query<ResourceLinkRow>(
    `SELECT ${LINK_COLUMNS}
     FROM phis.resource_links link
     WHERE link.site_id = $1
       AND link.provider_id = $2
       AND link.type = $3
       AND link.external_id = $4`,
    [input.siteId, input.providerId, input.type, input.externalId],
  );
  const row = rows[0];
  return row ? projectLink(row) : null;
}

export { resolveSubjectThreadId };
