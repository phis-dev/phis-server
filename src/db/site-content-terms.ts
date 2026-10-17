import "server-only";

import { getPool } from "@/lib/db";
import {
  SITE_CONTENT_VOCABULARY_CATEGORY,
  SITE_CONTENT_VOCABULARY_TAG,
  type DbQueryable,
} from "@/db/site-content";

/*
 * The words a content type's entries are filed under (CONTENT.md, Terms): tags and categories.
 *
 * One table for both vocabularies, one row per term of one kind on one Site, and a link table saying which
 * entry carries which. The links repeat the Site, the kind and the vocabulary so two foreign keys hold a
 * link to its own Site and kind, and so a partial unique index can say "one category per entry" without a
 * trigger. Allowing several categories later is dropping that index.
 *
 * The two vocabularies are written by different hands. Tags are the Author's: a save states the entry's
 * tags and the terms behind them come and go with it. A category is the Publisher's: categories are kept
 * in their own list, and an entry is filed under one by curation, never by a save.
 */

export const SITE_CONTENT_TERM_SLUG_MAX_LENGTH = 128;
export const SITE_CONTENT_TERM_LABEL_MAX_LENGTH = 128;

export type SiteContentTermRecord = {
  id: number;
  slug: string;
  /** The label as it was written; translated where it is read. */
  label: string;
  sortOrder: number;
};

export type SiteContentCategoryRecord = SiteContentTermRecord & {
  /** How many entries are filed under it, published or not. */
  entryCount: number;
};

/**
 * A term's address from its label: lower case, letters and digits of any script, everything else a single
 * hyphen. Diacritics are dropped so "Café" and "cafe" are one address, the way a reader would type it.
 * Empty where the label has no letter or digit at all, which the callers refuse.
 */
export function slugifySiteContentTerm(label: string) {
  return label
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/gu, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SITE_CONTENT_TERM_SLUG_MAX_LENGTH)
    .replace(/-+$/u, "");
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/**
 * States an entry's tags: the terms behind them are found or made, and the entry's tag links replaced in
 * the order given.
 *
 * Two tags that come to the same address are one term, labelled as the first of them was written. A term
 * nobody carries any more is left in the table and leaves the offer by itself -- the offer only names terms
 * an entry carries -- because removing it here would race a save on another entry that is about to carry it.
 */
export async function replaceSiteContentEntryTags(db: DbQueryable, input: {
  siteId: number;
  type: number;
  contentId: number;
  tags: readonly string[];
}) {
  const bySlug = new Map<string, string>();
  for (const tag of input.tags) {
    const slug = slugifySiteContentTerm(tag);
    if (slug && !bySlug.has(slug)) {
      bySlug.set(slug, tag);
    }
  }
  const slugs = [...bySlug.keys()];
  const labels = [...bySlug.values()];

  await db.query(
    `DELETE FROM phis.site_content_term_links
     WHERE content_id = $1 AND vocabulary = $2`,
    [input.contentId, SITE_CONTENT_VOCABULARY_TAG],
  );
  if (slugs.length === 0) {
    return;
  }
  await db.query(
    `INSERT INTO phis.site_content_terms (site_id, type, vocabulary, slug, label)
     SELECT $1, $2, $3, term.slug, term.label
     FROM unnest($4::text[], $5::text[]) AS term(slug, label)
     ON CONFLICT (site_id, type, vocabulary, slug) DO NOTHING`,
    [input.siteId, input.type, SITE_CONTENT_VOCABULARY_TAG, slugs, labels],
  );
  await db.query(
    `INSERT INTO phis.site_content_term_links (content_id, term_id, site_id, type, vocabulary, sort_order)
     SELECT $1, term.id, $2, $3, $4, wanted.ord
     FROM unnest($5::text[]) WITH ORDINALITY AS wanted(slug, ord)
     JOIN phis.site_content_terms term
       ON term.site_id = $2 AND term.type = $3 AND term.vocabulary = $4 AND term.slug = wanted.slug`,
    [input.contentId, input.siteId, input.type, SITE_CONTENT_VOCABULARY_TAG, slugs],
  );
}

/**
 * The tags this Site's entries of a kind carry, which is the offer an author picks from. Labels as they
 * were written, in the order a reader looks for them.
 */
export async function listSiteContentTagsInUse(siteId: number, type: number): Promise<string[]> {
  const { rows } = await getPool().query<{ label: string }>(
    `SELECT term.label
     FROM phis.site_content_terms term
     WHERE term.site_id = $1
       AND term.type = $2
       AND term.vocabulary = $3
       AND EXISTS (SELECT 1 FROM phis.site_content_term_links link WHERE link.term_id = term.id)
     ORDER BY term.label`,
    [siteId, type, SITE_CONTENT_VOCABULARY_TAG],
  );
  return rows.map((row) => row.label);
}

type CategoryRow = { id: number; slug: string; label: string; sort_order: number; entry_count: string | number };

function toCategory(row: CategoryRow): SiteContentCategoryRecord {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    sortOrder: row.sort_order,
    entryCount: Number(row.entry_count),
  };
}

/** A kind's categories, in the order the Site gave them. */
export async function listSiteContentCategories(siteId: number, type: number): Promise<SiteContentCategoryRecord[]> {
  const { rows } = await getPool().query<CategoryRow>(
    `SELECT term.id, term.slug, term.label, term.sort_order,
            (SELECT COUNT(*) FROM phis.site_content_term_links link WHERE link.term_id = term.id) AS entry_count
     FROM phis.site_content_terms term
     WHERE term.site_id = $1 AND term.type = $2 AND term.vocabulary = $3
     ORDER BY term.sort_order ASC, term.label ASC, term.id ASC`,
    [siteId, type, SITE_CONTENT_VOCABULARY_CATEGORY],
  );
  return rows.map(toCategory);
}

/** A new category at the address it names; a second category claiming that address is refused. */
export async function createSiteContentCategory(input: {
  siteId: number;
  type: number;
  slug: string;
  label: string;
  sortOrder: number;
}): Promise<SiteContentCategoryRecord | "slug_taken"> {
  const { rows } = await getPool().query<CategoryRow>(
    `INSERT INTO phis.site_content_terms (site_id, type, vocabulary, slug, label, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, type, vocabulary, slug) DO NOTHING
     RETURNING id, slug, label, sort_order, 0 AS entry_count`,
    [input.siteId, input.type, SITE_CONTENT_VOCABULARY_CATEGORY, input.slug, input.label, input.sortOrder],
  );
  return rows[0] ? toCategory(rows[0]) : "slug_taken";
}

/**
 * Renames, readdresses or moves a category. A changed address moves every entry filed under it with it,
 * because the entries name the category and not its address.
 */
export async function updateSiteContentCategory(input: {
  siteId: number;
  type: number;
  id: number;
  slug: string;
  label: string;
  sortOrder: number;
}): Promise<SiteContentCategoryRecord | "missing" | "slug_taken"> {
  try {
    const { rows } = await getPool().query<CategoryRow>(
      `UPDATE phis.site_content_terms term
       SET slug = $5, label = $6, sort_order = $7, updated_at = NOW()
       WHERE term.site_id = $1 AND term.type = $2 AND term.vocabulary = $3 AND term.id = $4
       RETURNING term.id, term.slug, term.label, term.sort_order,
                 (SELECT COUNT(*) FROM phis.site_content_term_links link WHERE link.term_id = term.id) AS entry_count`,
      [input.siteId, input.type, SITE_CONTENT_VOCABULARY_CATEGORY, input.id, input.slug, input.label, input.sortOrder],
    );
    return rows[0] ? toCategory(rows[0]) : "missing";
  } catch (error) {
    if (isUniqueViolation(error)) {
      return "slug_taken";
    }
    throw error;
  }
}

/** Removes a category; the entries filed under it are then filed under none. */
export async function deleteSiteContentCategory(input: { siteId: number; type: number; id: number }) {
  const { rowCount } = await getPool().query(
    `DELETE FROM phis.site_content_terms
     WHERE site_id = $1 AND type = $2 AND vocabulary = $3 AND id = $4`,
    [input.siteId, input.type, SITE_CONTENT_VOCABULARY_CATEGORY, input.id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Files an entry under one category, or under none for `null`.
 *
 * The category must be one of this Site's for this kind; the foreign key would refuse anything else, and
 * the read before the write turns that refusal into an answer a caller can act on.
 */
export async function setSiteContentEntryCategory(db: DbQueryable, input: {
  siteId: number;
  type: number;
  contentId: number;
  categoryId: number | null;
}): Promise<"set" | "category_missing"> {
  if (input.categoryId !== null) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM phis.site_content_terms
       WHERE site_id = $1 AND type = $2 AND vocabulary = $3 AND id = $4`,
      [input.siteId, input.type, SITE_CONTENT_VOCABULARY_CATEGORY, input.categoryId],
    );
    if ((rowCount ?? 0) === 0) {
      return "category_missing";
    }
  }
  await db.query(
    `DELETE FROM phis.site_content_term_links WHERE content_id = $1 AND vocabulary = $2`,
    [input.contentId, SITE_CONTENT_VOCABULARY_CATEGORY],
  );
  if (input.categoryId !== null) {
    await db.query(
      `INSERT INTO phis.site_content_term_links (content_id, term_id, site_id, type, vocabulary, sort_order)
       VALUES ($1, $2, $3, $4, $5, 0)`,
      [input.contentId, input.categoryId, input.siteId, input.type, SITE_CONTENT_VOCABULARY_CATEGORY],
    );
  }
  return "set";
}
