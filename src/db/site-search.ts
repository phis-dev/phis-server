import "server-only";

import type { PoolClient } from "pg";

import {
  PHI_SEARCH_INDEXED_AREA_MASK,
  PHI_SEARCH_MAX_DESCRIPTION_LENGTH,
  PHI_SEARCH_MAX_DOCUMENTS,
  PHI_SEARCH_MAX_LIMIT,
  PHI_SEARCH_MAX_PATH_LENGTH,
  PHI_SEARCH_MAX_TEXT_LENGTH,
  PHI_SEARCH_MAX_TITLE_LENGTH,
  tokenizePhiSearchQuery,
  type PhiSearchDocument,
  type PhiSearchHit,
  type PhiSearchIndexState,
  type PhiSearchSnippetSegment,
} from "@phis/contracts/search";

import { getPool, withTransaction } from "@/lib/db";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * The Site's search index (SEARCH.md): the document sets a Site writes of its published Pages, and the
 * query that answers a visitor from them.
 *
 * Nothing here reads the CMS tables. The documents arrive finished -- the Site resolved each Page as a
 * request does and wrote what a visitor could read -- and this module keeps them per Area and language
 * and searches them. The vector is a generated column (`001_create_phis.pgsql`), so how text is indexed
 * is the schema's word and not repeated in a query.
 */

export type SiteSearchSetKey = {
  siteId: number;
  areaMask: number;
  locale: string;
};

/** The markers `ts_headline` puts around a matched word; chosen to appear in no Page. */
const HEADLINE_START = "⸢";
const HEADLINE_STOP = "⸣";
const HEADLINE_OPTIONS = `MaxFragments=2, MaxWords=18, MinWords=8, FragmentDelimiter=" … ", StartSel=${HEADLINE_START}, StopSel=${HEADLINE_STOP}`;

function isIndexedArea(areaMask: number) {
  return Number.isInteger(areaMask) && areaMask > 0 && (areaMask & PHI_SEARCH_INDEXED_AREA_MASK) === areaMask
    // One Area per set: a set is written for an Area, and a query names the Areas it searches by their bits.
    && (areaMask & (areaMask - 1)) === 0;
}

function isSetKey(key: SiteSearchSetKey) {
  return Number.isInteger(key.siteId) && key.siteId > 0 && isIndexedArea(key.areaMask)
    && typeof key.locale === "string" && key.locale.length > 0 && key.locale.length <= 8;
}

function mapState(row: {
  area_id: number;
  locale: string;
  fingerprint: string;
  document_count: number;
  indexed_at: Date | string;
}): PhiSearchIndexState {
  return {
    areaMask: row.area_id,
    locale: row.locale,
    fingerprint: row.fingerprint,
    documentCount: row.document_count,
    indexedAt: row.indexed_at instanceof Date ? row.indexed_at.toISOString() : String(row.indexed_at),
  };
}

const STATE_COLUMNS = "area_id, locale, fingerprint, document_count, indexed_at";

/** Every set a Site holds, so a Site process can tell which of its sets are behind. */
export async function listSiteSearchIndexStates(siteId: number): Promise<PhiSearchIndexState[]> {
  if (!Number.isInteger(siteId) || siteId <= 0) return [];
  const { rows } = await getPool().query<Parameters<typeof mapState>[0]>(
    `SELECT ${STATE_COLUMNS} FROM phis.site_search_sets WHERE site_id = $1 ORDER BY area_id, locale`,
    [siteId],
  );
  return rows.map(mapState);
}

/**
 * A document as the set accepts it, or `null` for one that is not a document: no path, or a path that
 * is not an address within an Area. Text beyond the contract's lengths is cut, not refused -- the Page is
 * still found, by the words that fit.
 */
export function readSiteSearchDocument(value: unknown): PhiSearchDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path.startsWith("/") || path.length > PHI_SEARCH_MAX_PATH_LENGTH || /\s/u.test(path)) return null;
  const text = (field: unknown, max: number) =>
    (typeof field === "string" ? field : "").replace(/\s+/gu, " ").trim().slice(0, max);
  return {
    path,
    title: text(record.title, PHI_SEARCH_MAX_TITLE_LENGTH),
    description: text(record.description, PHI_SEARCH_MAX_DESCRIPTION_LENGTH),
    text: (typeof record.text === "string" ? record.text : "").trim().slice(0, PHI_SEARCH_MAX_TEXT_LENGTH),
  };
}

export type ReplaceSiteSearchDocumentsResult =
  | { status: "written"; state: PhiSearchIndexState }
  | { status: "unchanged"; state: PhiSearchIndexState }
  | { status: "invalid"; reason: string };

/**
 * One set, replaced whole: the documents of one Area in one language, under the fingerprint they were
 * built from.
 *
 * In one transaction, so a visitor searching while a Site writes sees the old set or the new one and
 * never half of each. The set row is locked first; a second process offering the same fingerprint
 * waits, reads it, and goes home without writing. A later document with a path an earlier one already
 * used replaces it -- the Site resolves Pages by address, so two documents at one address are one Page
 * read twice.
 */
export async function replaceSiteSearchDocuments(
  key: SiteSearchSetKey,
  fingerprint: string,
  documents: readonly PhiSearchDocument[],
): Promise<ReplaceSiteSearchDocumentsResult> {
  if (!isSetKey(key)) return { status: "invalid", reason: "The set names no indexed Area or no locale." };
  const print = fingerprint.trim();
  if (!print || print.length > 128) return { status: "invalid", reason: "The set carries no fingerprint." };
  if (documents.length > PHI_SEARCH_MAX_DOCUMENTS) {
    return { status: "invalid", reason: `The set carries more than ${PHI_SEARCH_MAX_DOCUMENTS} documents.` };
  }
  const byPath = new Map<string, PhiSearchDocument>();
  for (const document of documents) byPath.set(document.path, document);
  const unique = [...byPath.values()];

  return withTransaction(async (client) => {
    const held = await client.query<Parameters<typeof mapState>[0]>(
      `SELECT ${STATE_COLUMNS} FROM phis.site_search_sets
       WHERE site_id = $1 AND area_id = $2 AND locale = $3
       FOR UPDATE`,
      [key.siteId, key.areaMask, key.locale],
    );
    if (held.rows[0]?.fingerprint === print) {
      return { status: "unchanged", state: mapState(held.rows[0]) };
    }

    const set = await client.query<Parameters<typeof mapState>[0]>(
      `INSERT INTO phis.site_search_sets (site_id, area_id, locale, fingerprint, document_count, indexed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (site_id, area_id, locale) DO UPDATE
         SET fingerprint = EXCLUDED.fingerprint,
             document_count = EXCLUDED.document_count,
             indexed_at = EXCLUDED.indexed_at
       RETURNING ${STATE_COLUMNS}`,
      [key.siteId, key.areaMask, key.locale, print, unique.length],
    );
    await client.query(
      `DELETE FROM phis.site_search_documents WHERE site_id = $1 AND area_id = $2 AND locale = $3`,
      [key.siteId, key.areaMask, key.locale],
    );
    if (unique.length > 0) {
      await insertDocumentsWithDb(client, key, unique);
    }
    return { status: "written", state: mapState(set.rows[0]) };
  });
}

/** The documents in slices: one statement per slice, each with four arrays unnested side by side. */
async function insertDocumentsWithDb(db: DbQueryable, key: SiteSearchSetKey, documents: readonly PhiSearchDocument[]) {
  const SLICE = 200;
  for (let start = 0; start < documents.length; start += SLICE) {
    const slice = documents.slice(start, start + SLICE);
    await db.query(
      `INSERT INTO phis.site_search_documents (site_id, area_id, locale, path, title, description, body)
       SELECT $1, $2, $3, d.path, d.title, d.description, d.body
       FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[]) AS d(path, title, description, body)`,
      [
        key.siteId,
        key.areaMask,
        key.locale,
        slice.map((document) => document.path),
        slice.map((document) => document.title),
        slice.map((document) => document.description),
        slice.map((document) => document.text),
      ],
    );
  }
}

/** Every Area bit of `areaMask` that a set may be written for, as the `area_id` values to search. */
function listSearchedAreas(areaMask: number): number[] {
  const areas: number[] = [];
  for (const bit of [1, 2]) {
    if ((areaMask & bit) !== 0) areas.push(bit);
  }
  return areas;
}

/**
 * The text query for the words of a visitor's query: each word a prefix, all of them required.
 *
 * Built from `tokenizePhiSearchQuery`'s words only -- letters and digits -- so nothing a visitor types
 * reaches `to_tsquery`'s own grammar. `null` for a query with no word in it.
 */
export function buildSiteSearchTsQuery(query: string): string | null {
  const words = tokenizePhiSearchQuery(query);
  return words.length > 0 ? words.map((word) => `${word}:*`).join(" & ") : null;
}

function splitHeadline(headline: string): PhiSearchSnippetSegment[] {
  if (!headline.includes(HEADLINE_START)) return [];
  const segments: PhiSearchSnippetSegment[] = [];
  const pattern = new RegExp(`${HEADLINE_START}(.*?)${HEADLINE_STOP}`, "gsu");
  let cursor = 0;
  for (const match of headline.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: headline.slice(cursor, start), match: false });
    segments.push({ text: match[1], match: true });
    cursor = start + match[0].length;
  }
  if (cursor < headline.length) segments.push({ text: headline.slice(cursor), match: false });
  return segments;
}

export type SearchSiteDocumentsOptions = {
  siteId: number;
  /** The Areas to search, as bits of `PHI_SEARCH_INDEXED_AREA_MASK`; others are ignored. */
  areaMask: number;
  locale: string;
  /** The query as `readPhiSearchQuery` read it. */
  query: string;
  limit: number;
};

export type SearchSiteDocumentsResult = {
  hits: PhiSearchHit[];
  total: number;
};

/**
 * The Pages matching a query, best first, in one language and the Areas asked for.
 *
 * Title, description and body are weighted in the vector (A, B, C), so a word in a title outranks the
 * same word in a paragraph; `ts_rank_cd` adds how close the words stand. The snippet is read from the
 * body alone -- the title and description are shown whole beside it -- and is empty where the match was
 * in those alone, which the Widget reads as "nothing more to show".
 */
export async function searchSiteDocuments(options: SearchSiteDocumentsOptions): Promise<SearchSiteDocumentsResult> {
  const areas = listSearchedAreas(options.areaMask);
  const tsquery = buildSiteSearchTsQuery(options.query);
  const limit = Math.min(Math.max(1, Math.trunc(options.limit)), PHI_SEARCH_MAX_LIMIT);
  if (!Number.isInteger(options.siteId) || options.siteId <= 0 || areas.length === 0 || !tsquery || !options.locale) {
    return { hits: [], total: 0 };
  }

  const { rows } = await getPool().query<{
    path: string;
    area_id: number;
    title: string;
    description: string;
    headline: string;
    rank: number;
    total: string | number;
  }>(
    `WITH q AS (SELECT to_tsquery('simple'::regconfig, $4) AS query)
     SELECT d.path,
            d.area_id,
            d.title,
            d.description,
            ts_headline('simple'::regconfig, d.body, q.query, $6) AS headline,
            ts_rank_cd(d.search_vector, q.query) AS rank,
            COUNT(*) OVER () AS total
     FROM phis.site_search_documents d, q
     WHERE d.site_id = $1
       AND d.area_id = ANY($2::smallint[])
       AND d.locale = $3
       AND d.search_vector @@ q.query
     ORDER BY rank DESC, d.title ASC, d.path ASC
     LIMIT $5`,
    [options.siteId, areas, options.locale, tsquery, limit, HEADLINE_OPTIONS],
  );

  return {
    hits: rows.map((row) => ({
      path: row.path,
      areaMask: row.area_id,
      title: row.title,
      description: row.description,
      snippet: splitHeadline(row.headline),
      rank: Number(row.rank),
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}
