import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db";
import { requirePhiTranslationLocale } from "@/lib/locale";

type TranslationQueryClient = Pick<Pool | PoolClient, "query">;

/**
 * Marks the current transaction as the request path filling a translation no Site holds yet.
 *
 * The change-marker triggers (`phis.tr_touch_*_marker*` in 001_create_phis.pgsql) skip such a
 * transaction: what it adds was a miss everywhere, so no Site has anything to empty, and moving the
 * marker would take its row lock and serialize every concurrent fill of a Site. Every other write moves
 * the marker. Must run inside the transaction it marks.
 */
async function markTranslationFill(client: TranslationQueryClient) {
  await client.query("SELECT set_config('phis.translation_fill', 'on', true)");
}

async function inTranslationFill<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await markTranslationFill(client);
    const result = await work(client);
    return result;
  });
}

function formatCollisionDetails(details: Record<string, unknown>) {
  return JSON.stringify(details);
}

function createGlobalCollisionError(
  msg: string,
  ctx: string,
  msgHash: string,
  existingMsg: string,
) {
  return new Error(
    `Hash collision detected for tr_msg: ${formatCollisionDetails({
      hash: msgHash,
      ctx,
      msg,
      existingMsg,
    })}`,
  );
}

function createSiteCollisionError(
  siteId: number,
  msg: string,
  ctx: string,
  msgHash: string,
  existingMsg: string,
) {
  return new Error(
    `Hash collision detected for tr_site_msg: ${formatCollisionDetails({
      siteId,
      hash: msgHash,
      ctx,
      msg,
      existingMsg,
    })}`,
  );
}

function normalizeMessageHash(msgHash: string) {
  if (!/^[0-9a-f]{64}$/i.test(msgHash)) {
    throw new Error("Invalid translation message hash.");
  }

  return msgHash.toLowerCase();
}

const TR_HASH_PREFIX_LENGTH = 50;

function computeSiteMessageHash(msg: string) {
  return createHash("sha256").update(msg.slice(0, TR_HASH_PREFIX_LENGTH)).digest("hex");
}

export function computeExternalSourceHash(msg: string) {
  return createHash("sha256").update(msg).digest("hex");
}

export type ExternalTranslationUnit = {
  msgId: number;
  canonicalMsg: string;
};

async function findExternalTranslationUnit(input: {
  siteId?: number;
  locale: string;
  source: string;
  ctx: string;
  sourceHash: string;
  database?: TranslationQueryClient;
}): Promise<ExternalTranslationUnit | null> {
  const sourceHash = normalizeMessageHash(input.sourceHash);
  const pool = input.database ?? getPool();
  const { rows } = input.siteId == null
    ? await pool.query<{ msg_id: number; canonical_msg: string; source: string }>(
        `SELECT lang.msg_id, msg.msg AS canonical_msg, lang.translation AS source
         FROM phis.tr_lang lang
         JOIN phis.tr_msg msg ON msg.id = lang.msg_id
         WHERE lang.locale = $1
           AND lang.source_hash = decode($2, 'hex')
           AND msg.ctx = $3`,
        [input.locale, sourceHash, input.ctx],
      )
    : await pool.query<{ msg_id: number; canonical_msg: string; source: string }>(
        `SELECT lang.msg_id, msg.msg AS canonical_msg, lang.translation AS source
         FROM phis.tr_site_lang lang
         JOIN phis.tr_site_msg msg ON msg.id = lang.msg_id
         WHERE msg.site_id = $1
           AND lang.locale = $2
           AND lang.source_hash = decode($3, 'hex')
           AND msg.ctx = $4`,
        [input.siteId, input.locale, sourceHash, input.ctx],
      );

  const exact = rows.find((row) => row.source === input.source);
  if (exact) {
    return { msgId: exact.msg_id, canonicalMsg: exact.canonical_msg };
  }
  if (rows.length > 0) {
    throw new Error("Hash collision detected for an external translation source.");
  }
  return null;
}

export function findGlobalExternalTranslationUnit(input: {
  locale: string;
  source: string;
  ctx: string;
  sourceHash: string;
}) {
  return findExternalTranslationUnit(input);
}

export function findSiteExternalTranslationUnit(input: {
  siteId: number;
  locale: string;
  source: string;
  ctx: string;
  sourceHash: string;
}) {
  return findExternalTranslationUnit(input);
}

export async function getTranslations(
  locale: string,
  entries: Array<{ msg: string; hash: string }>,
  ctx: string,
) {
  const normalizedEntries = entries
    .map((entry) => ({
      msg: entry.msg,
      hash: normalizeMessageHash(entry.hash),
    }))
    .filter((entry) => entry.msg.trim());

  if (normalizedEntries.length === 0) {
    return new Map<string, string>();
  }

  const uniqueHashes = Array.from(new Set(normalizedEntries.map((entry) => entry.hash)));
  const pool = getPool();
  const { rows } = await pool.query<
    { msg_hash: string; translation: string; msg: string }
  >(
    `SELECT encode(m.msg_hash, 'hex') AS msg_hash, l.translation, m.msg
     FROM phis.tr_lang l
     JOIN phis.tr_msg m ON m.id = l.msg_id
     WHERE l.locale = $1
       AND m.ctx = $2
       AND encode(m.msg_hash, 'hex') = ANY($3::text[])`,
    [locale, ctx, uniqueHashes],
  );

  const requestedMessageByHash = new Map(
    normalizedEntries.map((entry) => [entry.hash, entry.msg]),
  );
  const translationByHash = new Map<string, string>();

  for (const row of rows) {
    const requestedMsg = requestedMessageByHash.get(row.msg_hash);
    if (requestedMsg && requestedMsg !== row.msg) {
      throw createGlobalCollisionError(requestedMsg, ctx, row.msg_hash, row.msg);
    }

    translationByHash.set(row.msg_hash, row.translation);
  }

  return translationByHash;
}

/**
 * The stored change markers of the global store and of one Site's store, or null for a store nothing
 * has changed yet. Maintained by triggers in 001_create_phis.pgsql; read as text because only equality
 * means anything.
 */
/**
 * Which of these messages the global catalogue already holds, by hash.
 *
 * `getTranslations` starts at `tr_lang`, so it cannot tell "no translation for this locale" from "no
 * such message here" -- and that is the distinction a caller allowed to fill the catalogue but not to
 * extend it turns on (TRANSLATIONS.md, "Somebody else's strings in the global store"). Asked separately
 * rather than folded into that query: only the restricted path needs it, and only for what it missed.
 *
 * A hash whose stored message is a different text counts as absent. `msg_hash` covers the opening of a
 * message, so a collision is two messages to us and one key to the column; the requested one is not in
 * the catalogue, and treating it as present would fill in a translation under somebody else's text.
 */
export async function findGlobalMessageHashes(
  entries: Array<{ msg: string; hash: string }>,
  ctx: string,
) {
  const normalized = entries
    .map((entry) => ({ msg: entry.msg, hash: normalizeMessageHash(entry.hash) }))
    .filter((entry) => entry.msg.trim());
  if (normalized.length === 0) {
    return new Set<string>();
  }

  const { rows } = await getPool().query<{ msg_hash: string; msg: string }>(
    `SELECT encode(msg_hash, 'hex') AS msg_hash, msg
       FROM phis.tr_msg
      WHERE ctx = $1
        AND encode(msg_hash, 'hex') = ANY($2::text[])`,
    [ctx, Array.from(new Set(normalized.map((entry) => entry.hash)))],
  );

  const storedByHash = new Map(rows.map((row) => [row.msg_hash, row.msg]));
  return new Set(
    normalized
      .filter((entry) => storedByHash.get(entry.hash) === entry.msg)
      .map((entry) => entry.hash),
  );
}

export async function readTranslationChangeMarkers(siteId: number) {
  const { rows } = await getPool().query<{ global_marker: string | null; site_marker: string | null }>(
    `SELECT (SELECT marker::text FROM phis.tr_marker WHERE scope = 'global') AS global_marker,
            (SELECT marker::text FROM phis.tr_site_marker WHERE site_id = $1) AS site_marker`,
    [siteId],
  );
  return {
    global: rows[0]?.global_marker ?? null,
    site: rows[0]?.site_marker ?? null,
  };
}

export async function upsertTranslation(
  locale: string,
  msg: string,
  ctx: string,
  translation: string,
  msgHash: string,
) {
  const msgId = await ensureMessageId(msg, ctx, normalizeMessageHash(msgHash));
  // A fill adds what was missing and nothing else. It runs past the change marker, so replacing a row
  // here -- one an editor wrote while the provider was being asked -- would change a translation every
  // Site keeps without telling any of them.
  await inTranslationFill((client) => client.query(
    `INSERT INTO phis.tr_lang (msg_id, locale, translation)
       VALUES ($1, $2, $3)
     ON CONFLICT (msg_id, locale) DO NOTHING`,
    [msgId, locale, translation],
  ));
}

export async function ensureGlobalExternalTranslationUnit(input: {
  sourceLocale: string;
  source: string;
  sourceHash: string;
  canonicalMsg: string;
  canonicalHash: string;
  ctx: string;
}) {
  const sourceHash = normalizeMessageHash(input.sourceHash);
  return withTransaction(async (client) => {
    await markTranslationFill(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`global:${input.sourceLocale}:${sourceHash}:${input.ctx}`],
    );
    const existingUnit = await findExternalTranslationUnit({
      locale: input.sourceLocale,
      source: input.source,
      ctx: input.ctx,
      sourceHash,
      database: client,
    });
    if (existingUnit) {
      return existingUnit.msgId;
    }
    const msgId = await ensureMessageId(
      input.canonicalMsg,
      input.ctx,
      normalizeMessageHash(input.canonicalHash),
      client,
    );
    const existing = await client.query<{ translation: string }>(
      `SELECT translation
       FROM phis.tr_lang
       WHERE msg_id = $1 AND locale = $2
       LIMIT 1`,
      [msgId, input.sourceLocale],
    );
    if (existing.rows[0] && existing.rows[0].translation !== input.source) {
      throw new Error("External source conflicts with an existing translation variant.");
    }
    await client.query(
      `INSERT INTO phis.tr_lang (msg_id, locale, translation, source_hash)
       VALUES ($1, $2, $3, decode($4, 'hex'))
       ON CONFLICT (msg_id, locale)
       DO UPDATE SET source_hash = EXCLUDED.source_hash, updated_at = NOW()`,
      [msgId, input.sourceLocale, input.source, sourceHash],
    );
    return msgId;
  });
}

async function ensureMessageId(
  msg: string,
  ctx: string,
  msgHash: string,
  database: TranslationQueryClient = getPool(),
) {
  const pool = database;
  const normalizedHash = normalizeMessageHash(msgHash);

  await pool.query(
    `INSERT INTO phis.tr_msg (msg, msg_hash, ctx)
     VALUES ($1, decode($2, 'hex'), $3)
     ON CONFLICT (msg_hash, ctx) DO NOTHING`,
    [msg, normalizedHash, ctx],
  );

  const { rows } = await pool.query<{ id: number; msg: string }>(
    "SELECT id, msg FROM phis.tr_msg WHERE msg_hash = decode($1, 'hex') AND ctx = $2 LIMIT 1",
    [normalizedHash, ctx],
  );

  if (!rows[0]) {
    throw new Error("Failed to persist translation message.");
  }

  if (rows[0].msg !== msg) {
    throw createGlobalCollisionError(msg, ctx, normalizedHash, rows[0].msg);
  }

  return rows[0].id;
}

export async function ensureSiteMessageId(
  siteId: number,
  msg: string,
  ctx: string,
  database: TranslationQueryClient = getPool(),
) {
  const pool = database;
  const normalizedHash = computeSiteMessageHash(msg);

  await pool.query(
    `INSERT INTO phis.tr_site_msg (site_id, msg, msg_hash, ctx)
     VALUES ($1, $2, decode($3, 'hex'), $4)
     ON CONFLICT (site_id, msg_hash, ctx) DO NOTHING`,
    [siteId, msg, normalizedHash, ctx],
  );

  const { rows: insertedRows } = await pool.query<{ id: number; msg: string }>(
    `SELECT id, msg
     FROM phis.tr_site_msg
     WHERE site_id = $1
       AND msg_hash = decode($2, 'hex')
       AND ctx = $3
     LIMIT 1`,
    [siteId, normalizedHash, ctx],
  );

  if (!insertedRows[0] || insertedRows[0].msg !== msg) {
    throw createSiteCollisionError(
      siteId,
      msg,
      ctx,
      normalizedHash,
      insertedRows[0]?.msg ?? "",
    );
  }

  return insertedRows[0].id;
}

export async function ensureSiteExternalTranslationUnit(input: {
  siteId: number;
  sourceLocale: string;
  source: string;
  sourceHash: string;
  canonicalMsg: string;
  ctx: string;
}) {
  const sourceHash = normalizeMessageHash(input.sourceHash);
  return withTransaction(async (client) => {
    await markTranslationFill(client);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`site:${input.siteId}:${input.sourceLocale}:${sourceHash}:${input.ctx}`],
    );
    const existingUnit = await findExternalTranslationUnit({
      siteId: input.siteId,
      locale: input.sourceLocale,
      source: input.source,
      ctx: input.ctx,
      sourceHash,
      database: client,
    });
    if (existingUnit) {
      return existingUnit.msgId;
    }
    const msgId = await ensureSiteMessageId(
      input.siteId,
      input.canonicalMsg,
      input.ctx,
      client,
    );
    const existing = await client.query<{ translation: string }>(
      `SELECT translation
       FROM phis.tr_site_lang
       WHERE msg_id = $1 AND locale = $2
       LIMIT 1`,
      [msgId, input.sourceLocale],
    );
    if (existing.rows[0] && existing.rows[0].translation !== input.source) {
      throw new Error("External source conflicts with an existing Site translation variant.");
    }
    await client.query(
      `INSERT INTO phis.tr_site_lang (msg_id, locale, translation, source_hash)
       VALUES ($1, $2, $3, decode($4, 'hex'))
       ON CONFLICT (msg_id, locale)
       DO UPDATE SET source_hash = EXCLUDED.source_hash, updated_at = NOW()`,
      [msgId, input.sourceLocale, input.source, sourceHash],
    );
    return msgId;
  });
}

export async function getSiteTranslations(msgIds: number[], locale: string) {
  const uniqueMsgIds = Array.from(new Set(msgIds.filter((msgId) => Number.isInteger(msgId) && msgId > 0)));
  if (uniqueMsgIds.length === 0) {
    return new Map<number, string>();
  }

  const pool = getPool();
  const { rows } = await pool.query<{ msg_id: number; translation: string }>(
    `SELECT msg_id, translation
     FROM phis.tr_site_lang
     WHERE msg_id = ANY($1::int[])
       AND locale = $2`,
    [uniqueMsgIds, locale],
  );

  return new Map(rows.map((row) => [row.msg_id, row.translation]));
}

export type ResolvedSiteMessageField = {
  msgId: number;
  source: string;
  value: string;
};

export async function getResolvedSiteMessageFields(msgIds: number[], locale: string) {
  const uniqueMsgIds = Array.from(new Set(msgIds.filter((msgId) => Number.isInteger(msgId) && msgId > 0)));
  if (uniqueMsgIds.length === 0) {
    return new Map<number, ResolvedSiteMessageField>();
  }

  const pool = getPool();
  const { rows } = await pool.query<{
    id: number;
    msg: string;
    translation: string | null;
  }>(
    `SELECT msg.id, msg.msg, lang.translation
     FROM phis.tr_site_msg msg
     LEFT JOIN phis.tr_site_lang lang
       ON lang.msg_id = msg.id
      AND lang.locale = $2
     WHERE msg.id = ANY($1::int[])`,
    [uniqueMsgIds, locale],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        msgId: row.id,
        source: row.msg,
        value: row.translation?.trim() ? row.translation : row.msg,
      } satisfies ResolvedSiteMessageField,
    ]),
  );
}

export async function upsertSiteTranslations(
  entries: Array<{ msgId: number; locale: string; translation: string }>,
) {
  const normalizedEntries = entries.filter(
    (entry) => Number.isInteger(entry.msgId) && entry.msgId > 0 && entry.locale.trim() && entry.translation,
  );
  if (normalizedEntries.length === 0) {
    return;
  }

  // As for the global store: a fill adds the misses and leaves every existing row, an editor's included.
  await inTranslationFill((client) => client.query(
    `INSERT INTO phis.tr_site_lang (msg_id, locale, translation)
     SELECT *
     FROM UNNEST($1::int[], $2::varchar(8)[], $3::text[])
     ON CONFLICT (msg_id, locale) DO NOTHING`,
    [
      normalizedEntries.map((entry) => entry.msgId),
      normalizedEntries.map((entry) => entry.locale),
      normalizedEntries.map((entry) => entry.translation),
    ],
  ));
}

export type SiteTranslationListRow = {
  id: string;
  msgId: number;
  locale: string;
  source: string;
  sourceContext: string;
  translation: string;
  createdAt: string | null;
  updatedAt: string | null;
  protected: boolean;
};

export type SiteTranslationEditorStatus = "all" | "missing" | "translated";

export type SiteTranslationEditorRow = Omit<SiteTranslationListRow, "translation"> & {
  translation: string | null;
  hasTranslation: boolean;
};

export type SiteTranslationContextRow = {
  context: string;
  count: number;
};

function toIsoString(value: string | Date | null) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function listSiteTranslationRows(input: {
  siteId: number;
  locale: string;
  page: number;
  pageSize: number;
  search?: string | null;
}) {
  const siteId = input.siteId;
  const locale = input.locale.trim();
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const search = input.search?.trim() ?? "";

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  if (!locale) {
    throw new Error("A valid locale is required.");
  }

  const params: Array<number | string> = [siteId, locale];
  const searchWhere = search
    ? `AND (
         msg.msg ILIKE $3
         OR msg.ctx ILIKE $3
         OR lang.translation ILIKE $3
       )`
    : "";
  if (search) {
    params.push(`%${search}%`);
  }
  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;
  params.push(pageSize, offset);

  const pool = getPool();
  const [rowsResult, totalsResult] = await Promise.all([
    pool.query<{
      msg_id: number;
      locale: string;
      source: string;
      source_context: string;
      translation: string;
      created_at: string | Date | null;
      updated_at: string | Date | null;
      protected: boolean;
    }>(
      `SELECT
         msg.id AS msg_id,
         lang.locale,
         msg.msg AS source,
         msg.ctx AS source_context,
         lang.translation,
         msg.created_at,
         lang.updated_at,
         (lang.source_hash IS NOT NULL) AS protected
       FROM phis.tr_site_lang lang
       JOIN phis.tr_site_msg msg ON msg.id = lang.msg_id
       WHERE msg.site_id = $1
         AND lang.locale = $2
         ${searchWhere}
       ORDER BY lang.updated_at DESC NULLS LAST, msg.created_at DESC NULLS LAST, msg.id DESC
       LIMIT $${limitParamIndex}
       OFFSET $${offsetParamIndex}`,
      params,
    ),
    pool.query<{ filtered_total: string | number; locale_total: string | number }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE $3::text = ''
             OR msg.msg ILIKE $3
             OR msg.ctx ILIKE $3
             OR lang.translation ILIKE $3
         ) AS filtered_total,
         COUNT(*) AS locale_total
       FROM phis.tr_site_lang lang
       JOIN phis.tr_site_msg msg ON msg.id = lang.msg_id
       WHERE msg.site_id = $1
         AND lang.locale = $2`,
      [siteId, locale, search ? `%${search}%` : ""],
    ),
  ]);
  const rows = rowsResult.rows;
  const totals = totalsResult.rows[0];

  return {
    rows: rows.map((row): SiteTranslationListRow => ({
      id: `${row.msg_id}:${row.locale}`,
      msgId: row.msg_id,
      locale: row.locale,
      source: row.source,
      sourceContext: row.source_context,
      translation: row.translation,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      protected: row.protected,
    })),
    total: Number(totals?.filtered_total ?? 0),
    localeTotal: Number(totals?.locale_total ?? 0),
    page,
    pageSize,
  };
}

export async function listSiteTranslationContexts(siteIdInput: number) {
  const siteId = siteIdInput;
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  const pool = getPool();
  const { rows } = await pool.query<{ source_context: string; total_count: string | number }>(
    `SELECT ctx AS source_context, COUNT(*) AS total_count
     FROM phis.tr_site_msg
     WHERE site_id = $1
     GROUP BY ctx
     ORDER BY ctx ASC`,
    [siteId],
  );

  return rows.map((row): SiteTranslationContextRow => ({
    context: row.source_context,
    count: Number(row.total_count ?? 0),
  }));
}

export async function listSiteTranslationEditorRows(input: {
  siteId: number;
  locale: string;
  page: number;
  pageSize: number;
  context?: string | null;
  search?: string | null;
  status?: SiteTranslationEditorStatus | null;
}) {
  const siteId = input.siteId;
  const locale = input.locale.trim();
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Math.trunc(input.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const context = input.context?.trim() ?? "";
  const search = input.search?.trim() ?? "";
  const status = input.status ?? "all";

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  if (!locale) {
    throw new Error("A valid locale is required.");
  }

  const params: Array<number | string> = [siteId, locale];
  const whereParts: string[] = ["msg.site_id = $1"];

  if (context) {
    params.push(context);
    whereParts.push(`msg.ctx = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    whereParts.push(`(
      msg.msg ILIKE $${params.length}
      OR msg.ctx ILIKE $${params.length}
      OR lang.translation ILIKE $${params.length}
    )`);
  }

  if (status === "missing") {
    whereParts.push("(lang.msg_id IS NULL OR NULLIF(BTRIM(lang.translation), '') IS NULL)");
  } else if (status === "translated") {
    whereParts.push("(lang.msg_id IS NOT NULL AND NULLIF(BTRIM(lang.translation), '') IS NOT NULL)");
  }

  const limitParamIndex = params.length + 1;
  const offsetParamIndex = params.length + 2;
  params.push(pageSize, offset);

  const pool = getPool();
  const { rows } = await pool.query<{
    msg_id: number;
    locale: string | null;
    source: string;
    source_context: string;
    translation: string | null;
    has_translation: boolean;
    created_at: string | Date | null;
    updated_at: string | Date | null;
    protected: boolean;
    total_count: string | number;
  }>(
    `SELECT
       msg.id AS msg_id,
       COALESCE(lang.locale, $2) AS locale,
       msg.msg AS source,
       msg.ctx AS source_context,
       lang.translation,
       (lang.msg_id IS NOT NULL AND NULLIF(BTRIM(lang.translation), '') IS NOT NULL) AS has_translation,
       msg.created_at,
       lang.updated_at,
       (lang.source_hash IS NOT NULL) AS protected,
       COUNT(*) OVER() AS total_count
     FROM phis.tr_site_msg msg
     LEFT JOIN phis.tr_site_lang lang ON lang.msg_id = msg.id AND lang.locale = $2
     WHERE ${whereParts.join("\n       AND ")}
     ORDER BY
       CASE WHEN lang.msg_id IS NULL OR NULLIF(BTRIM(lang.translation), '') IS NULL THEN 0 ELSE 1 END ASC,
       COALESCE(lang.updated_at, msg.created_at) DESC NULLS LAST,
       msg.id DESC
     LIMIT $${limitParamIndex}
     OFFSET $${offsetParamIndex}`,
    params,
  );

  return {
    rows: rows.map((row): SiteTranslationEditorRow => ({
      id: `${row.msg_id}:${row.locale ?? locale}`,
      msgId: row.msg_id,
      locale: row.locale ?? locale,
      source: row.source,
      sourceContext: row.source_context,
      translation: row.translation,
      hasTranslation: row.has_translation,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      protected: row.protected,
    })),
    total: Number(rows[0]?.total_count ?? 0),
    page,
    pageSize,
  };
}

export async function upsertSiteTranslationForSite(input: {
  siteId: number;
  msgId: number;
  locale: string;
  translation: string;
}) {
  const siteId = input.siteId;
  const msgId = input.msgId;
  const locale = input.locale.trim();
  const translation = input.translation.trim();

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }
  if (!Number.isInteger(msgId) || msgId <= 0) {
    throw new Error("A valid message id is required.");
  }
  if (!locale || !translation) {
    throw new Error("A valid locale and translation are required.");
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `INSERT INTO phis.tr_site_lang (msg_id, locale, translation)
     SELECT msg.id, $3, $4
     FROM phis.tr_site_msg msg
     WHERE msg.site_id = $1
       AND msg.id = $2
     ON CONFLICT (msg_id, locale)
     DO UPDATE SET translation = EXCLUDED.translation,
                   updated_at = NOW()
     WHERE phis.tr_site_lang.source_hash IS NULL`,
    [siteId, msgId, locale, translation],
  );

  return (rowCount ?? 0) > 0;
}

export async function updateSiteTranslation(input: {
  siteId: number;
  msgId: number;
  locale: string;
  translation: string;
}) {
  const siteId = input.siteId;
  const msgId = input.msgId;
  const locale = input.locale.trim();
  const translation = input.translation.trim();

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }
  if (!Number.isInteger(msgId) || msgId <= 0) {
    throw new Error("A valid message id is required.");
  }
  if (!locale || !translation) {
    throw new Error("A valid locale and translation are required.");
  }

  const pool = getPool();
  const { rows } = await pool.query<{
    translation: string;
    updated_at: string | Date;
  }>(
    `UPDATE phis.tr_site_lang lang
     SET translation = $4,
         updated_at = NOW()
     FROM phis.tr_site_msg msg
     WHERE lang.msg_id = msg.id
       AND msg.site_id = $1
       AND lang.msg_id = $2
       AND lang.locale = $3
       AND lang.source_hash IS NULL
     RETURNING lang.translation, lang.updated_at`,
    [siteId, msgId, locale, translation],
  );

  const updated = rows[0];
  return updated
    ? { translation: updated.translation, updatedAt: toIsoString(updated.updated_at) }
    : null;
}

export async function deleteSiteTranslation(input: {
  siteId: number;
  msgId: number;
  locale: string;
}) {
  const siteId = input.siteId;
  const msgId = input.msgId;
  const locale = input.locale.trim();

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }
  if (!Number.isInteger(msgId) || msgId <= 0) {
    throw new Error("A valid message id is required.");
  }
  if (!locale) {
    throw new Error("A valid locale is required.");
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.tr_site_lang lang
     USING phis.tr_site_msg msg
     WHERE lang.msg_id = msg.id
       AND msg.site_id = $1
       AND lang.msg_id = $2
       AND lang.locale = $3
       AND lang.source_hash IS NULL`,
    [siteId, msgId, locale],
  );

  return (rowCount ?? 0) > 0;
}

export async function deleteSiteTranslations(input: {
  siteId: number;
  rows: readonly { msgId: number; locale: string }[];
}) {
  const siteId = input.siteId;
  const rows = input.rows.map((row) => ({
    msgId: row.msgId,
    locale: row.locale.trim(),
  }));

  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }
  if (rows.length === 0 || rows.some((row) =>
    !Number.isInteger(row.msgId) || row.msgId <= 0 || !row.locale)) {
    throw new Error("Valid translation row identities are required.");
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.tr_site_lang lang
     USING phis.tr_site_msg msg,
           UNNEST($2::INT[], $3::TEXT[]) AS selected(msg_id, locale)
     WHERE lang.msg_id = msg.id
       AND msg.site_id = $1
       AND lang.msg_id = selected.msg_id
       AND lang.locale = selected.locale
       AND lang.source_hash IS NULL`,
    [siteId, rows.map((row) => row.msgId), rows.map((row) => row.locale)],
  );

  return rowCount ?? 0;
}

export async function deleteSiteTranslatedVariantsForLocale(
  siteIdInput: number,
  localeInput: string,
) {
  const siteId = siteIdInput;
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("A valid site id is required.");
  }

  if (!localeInput.trim()) {
    throw new Error("A valid locale is required.");
  }
  // The spelling the rows were written under; lowercasing never met `pt-BR` or `zh-Hans`.
  const locale = requirePhiTranslationLocale(localeInput);

  const pool = getPool();
  const existing = await pool.query<{ id: number }>(
    `SELECT id
     FROM phis.sites
     WHERE id = $1
     LIMIT 1`,
    [siteId],
  );

  if (!existing.rows[0]) {
    throw new Error("Site not found.");
  }

  const { rowCount } = await pool.query(
    `DELETE FROM phis.tr_site_lang lang
     USING phis.tr_site_msg msg
     WHERE lang.msg_id = msg.id
       AND msg.site_id = $1
       AND lang.locale = $2
       AND lang.source_hash IS NULL`,
    [siteId, locale],
  );

  return rowCount ?? 0;
}

export async function deleteSiteExternalTranslationUnit(input: {
  siteId: number;
  msgId: number;
}) {
  if (!Number.isInteger(input.siteId) || input.siteId <= 0) {
    throw new Error("A valid site id is required.");
  }
  if (!Number.isInteger(input.msgId) || input.msgId <= 0) {
    throw new Error("A valid message id is required.");
  }

  const pool = getPool();
  const { rows } = await pool.query<{ external: boolean; referenced: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM phis.tr_site_lang lang
         WHERE lang.msg_id = msg.id AND lang.source_hash IS NOT NULL
       ) AS external,
       EXISTS (
         SELECT 1 FROM phis.site_content_version_text content_text
         WHERE content_text.msg_id = msg.id
       ) AS referenced
     FROM phis.tr_site_msg msg
     WHERE msg.site_id = $1 AND msg.id = $2
     LIMIT 1`,
    [input.siteId, input.msgId],
  );

  if (!rows[0]?.external) {
    return { deleted: false, reason: "not_external" as const };
  }
  if (rows[0].referenced) {
    return { deleted: false, reason: "content_reference" as const };
  }

  const { rowCount } = await pool.query(
    `DELETE FROM phis.tr_site_msg
     WHERE site_id = $1 AND id = $2`,
    [input.siteId, input.msgId],
  );
  return (rowCount ?? 0) > 0
    ? { deleted: true, reason: null }
    : { deleted: false, reason: "not_found" as const };
}
