import type { Pool, PoolClient } from "pg";

import { computePhiMessageHash, ensurePhiGlobalMessageId, ensurePhiSiteMessageId } from "../db/translation-message.mts";
import { PHI_CANONICAL_SOURCE_LOCALE, requirePhiTranslationLocale } from "../lib/locale.ts";
import {
  buildTranslationContext,
  hasTranslationContextFlag as readContextFlag,
  type TranslationContextFlag,
} from "../lib/translation-context.ts";

/**
 * Translations in and out of a store as a file: `phis translations status|export|import`.
 *
 * The way to translate without a provider -- by hand, by an agent, by another service -- and to review
 * what a provider wrote. `export` writes the messages of the global store (`tr_msg`/`tr_lang`) or of one
 * Site (`tr_site_msg`/`tr_site_lang`) with what each holds for one locale; `import` writes the file back.
 *
 * An entry is matched by its key, the hash and the context, and only while its source text is still the
 * one that was exported: a message changed in between is refused, not overwritten with a translation of
 * the old wording. Its placeholders (`%n`, `%1`, `{name}`) and, for an `html` unit, its tags must be the
 * source's, because a translation that drops one renders broken text everywhere it is read.
 *
 * `import --add` also creates the messages the store does not hold yet, through the function the request
 * path creates them with (`translation-message.mts`), so the key is the runtime's own. A message is
 * always in the canonical source language here; the file carries no source language of its own.
 *
 * `import --replace-source` takes an entry's source text over the stored one where the two share the key but
 * not the words -- an author rewrote a paragraph after its first 50 characters, which the key does not cover,
 * so the runtime meets its old message, cannot store the new one and answers the source forever. The message
 * keeps its id and key; its text becomes the file's, the file's answer becomes its translation for the
 * file's locale, and its answers in every other locale go, because they translate the old words.
 *
 * An import is an editor's write, not a provider fill, so it moves the change markers like any edit and
 * every Site answering from the store reads the new text. Messages a source language other than the
 * canonical one reached (`extern` context) are not exchanged here: their key is the source in that
 * language, and they belong to the request that made them.
 */

export const PHI_TRANSLATION_EXCHANGE_VERSION = 1;

export type PhiTranslationExchangeEntry = {
  /** The message key: hex SHA-256 of the message's first 50 characters. */
  hash: string;
  ctx: string;
  msg: string;
  /** What the store holds for the locale; null where nothing is. The file's answer goes here. */
  translation: string | null;
};

export type PhiTranslationExchangeFile = {
  version: typeof PHI_TRANSLATION_EXCHANGE_VERSION;
  /** `global`, or the Site's key. */
  store: string;
  locale: string;
  exportedAt: string;
  entries: PhiTranslationExchangeEntry[];
};

type Store = { name: string; siteId: number | null };

/** A context that is not one -- a broken flag envelope in a hand-edited file -- carries no flag; the lookup refuses it. */
function hasTranslationContextFlag(ctx: string, flag: TranslationContextFlag) {
  try {
    return readContextFlag(ctx, flag);
  } catch {
    return false;
  }
}

async function resolveStore(pool: Pool | PoolClient, siteKey: string | null | undefined): Promise<Store> {
  if (!siteKey) return { name: "global", siteId: null };
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM phis.sites WHERE key = $1", [siteKey]);
  if (!rows[0]) throw new Error(`No Site has the key "${siteKey}".`);
  return { name: siteKey, siteId: rows[0].id };
}

function tables(store: Store) {
  return store.siteId == null
    ? { msg: "phis.tr_msg", lang: "phis.tr_lang", where: "true", params: [] as unknown[] }
    : { msg: "phis.tr_site_msg", lang: "phis.tr_site_lang", where: "m.site_id = $1", params: [store.siteId] as unknown[] };
}

export type PhiTranslationStatusRow = { locale: string; translated: number; missing: number };

/** Per locale held anywhere in the store: how many messages it translates and how many it lacks. */
export async function readPhiTranslationStatus(pool: Pool, options: { siteKey?: string | null; locales?: string[] }) {
  const store = await resolveStore(pool, options.siteKey);
  const t = tables(store);
  const { rows: [count] } = await pool.query<{ messages: string }>(
    `SELECT count(*) AS messages FROM ${t.msg} m WHERE ${t.where}`,
    t.params,
  );
  const messages = Number(count?.messages ?? 0);
  const { rows } = await pool.query<{ locale: string; translated: string }>(
    `SELECT l.locale, count(*) AS translated
       FROM ${t.lang} l JOIN ${t.msg} m ON m.id = l.msg_id
      WHERE ${t.where} AND l.source_hash IS NULL
      GROUP BY l.locale ORDER BY l.locale`,
    t.params,
  );
  const byLocale = new Map(rows.map((row) => [row.locale, Number(row.translated)]));
  for (const locale of options.locales ?? []) {
    const normalized = requirePhiTranslationLocale(locale);
    if (!byLocale.has(normalized)) byLocale.set(normalized, 0);
  }
  return {
    store: store.name,
    messages,
    locales: [...byLocale.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([locale, translated]): PhiTranslationStatusRow => ({ locale, translated, missing: messages - translated })),
  };
}

/** The store's messages with what each holds for `locale`; with `missing`, only those it lacks. */
export async function exportPhiTranslations(pool: Pool, options: {
  locale: string;
  siteKey?: string | null;
  missing?: boolean;
  now?: Date;
}): Promise<PhiTranslationExchangeFile> {
  const locale = requirePhiTranslationLocale(options.locale);
  const store = await resolveStore(pool, options.siteKey);
  const t = tables(store);
  const localeParam = `$${t.params.length + 1}`;
  const { rows } = await pool.query<{ hash: string; ctx: string; msg: string; translation: string | null }>(
    `SELECT encode(m.msg_hash, 'hex') AS hash, m.ctx, m.msg, l.translation
       FROM ${t.msg} m
       LEFT JOIN ${t.lang} l ON l.msg_id = m.id AND l.locale = ${localeParam} AND l.source_hash IS NULL
      WHERE ${t.where}
      ORDER BY m.ctx, m.id`,
    [...t.params, locale],
  );
  const entries = rows
    .filter((row) => !hasTranslationContextFlag(row.ctx, "extern"))
    .filter((row) => !options.missing || row.translation == null);
  return {
    version: PHI_TRANSLATION_EXCHANGE_VERSION,
    store: store.name,
    locale,
    exportedAt: (options.now ?? new Date()).toISOString(),
    entries,
  };
}

const PLACEHOLDER_PATTERN = /%n|%\d+|%[sd]|\{[A-Za-z_][\w.]*\}/gu;
const TAG_PATTERN = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu;

function countTokens(text: string, pattern: RegExp, group = 0) {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(pattern)) {
    const token = (match[group] ?? match[0]).toLowerCase();
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(left: Map<string, number>, right: Map<string, number>) {
  if (left.size !== right.size) return false;
  for (const [token, count] of left) if (right.get(token) !== count) return false;
  return true;
}

/** Why a translation cannot stand in for `msg`, or null where it can. */
export function readPhiTranslationDefect(msg: string, ctx: string, translation: string) {
  if (translation.trim().length === 0) return "the translation is empty";
  if (!sameCounts(countTokens(msg, PLACEHOLDER_PATTERN), countTokens(translation, PLACEHOLDER_PATTERN))) {
    return "its placeholders are not the source's";
  }
  if (hasTranslationContextFlag(ctx, "html")
    && !sameCounts(countTokens(msg, TAG_PATTERN, 1), countTokens(translation, TAG_PATTERN, 1))) {
    return "its tags are not the source's";
  }
  return null;
}

export type PhiTranslationImportOutcome =
  | "created"
  | "written"
  | "replaced"
  | "sourceReplaced"
  | "unchanged"
  | "kept"
  | "refused";

/** With `replaceSource`: a message whose stored text the file's took over, and the answers that went with the old. */
export type PhiTranslationSourceReplacement = {
  hash: string;
  ctx: string;
  /** The new source text's opening. */
  msg: string;
  /** Where the old and the new text first differ (UTF-16 units, as the key counts them). */
  differsAt: number;
  /** The old and the new text from a little before that point, so the change shows past the shared opening. */
  oldExcerpt: string;
  newExcerpt: string;
  /** The answers of other locales that translated the old text and were deleted (the opening of each). */
  dropped: Array<{ locale: string; translation: string }>;
};

export type PhiTranslationImportResult = {
  store: string;
  locale: string;
  dryRun: boolean;
  counts: Record<PhiTranslationImportOutcome, number>;
  /** With `add`: the messages the store did not hold and the import created (or, in a dry run, would). */
  created: Array<{ hash: string; ctx: string; msg: string }>;
  /** One line per entry not written, and why. */
  refused: Array<{ hash: string; ctx: string; msg: string; reason: string }>;
  kept: Array<{ hash: string; ctx: string; msg: string }>;
  /** With `replaceSource`: the messages whose source text was (or, in a dry run, would be) replaced. */
  sourceReplaced: PhiTranslationSourceReplacement[];
};

/** Index of the first UTF-16 unit in which two texts differ; the shorter one's length where one opens the other. */
function firstDifference(left: string, right: string) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return index;
  return length;
}

function excerptFrom(text: string, start: number) {
  const body = text.slice(start, start + 80);
  return `${start > 0 ? "..." : ""}${body}${start + 80 < text.length ? "..." : ""}`;
}

/**
 * Reads and checks an exchange file; throws on a file that is not one.
 *
 * For `add` and `replaceSource`, an entry may leave `hash` out -- a file written by hand has none to copy -- and it
 * is computed from `msg`. A `hash` that is given must still be that message's. `ctx` is never defaulted (`""` is a context): it is
 * part of the key, and a message created under another context than the one the runtime asks with is never read.
 */
export function readPhiTranslationExchangeFile(
  raw: string,
  options: { add?: boolean; replaceSource?: boolean } = {},
): PhiTranslationExchangeFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = parsed as Partial<PhiTranslationExchangeFile> | null;
  if (!file || file.version !== PHI_TRANSLATION_EXCHANGE_VERSION || typeof file.store !== "string"
    || typeof file.locale !== "string" || !Array.isArray(file.entries)) {
    throw new Error(`The file is not a translations export of version ${PHI_TRANSLATION_EXCHANGE_VERSION}.`);
  }
  file.entries.forEach((entry, index) => {
    if ((options.add || options.replaceSource) && entry && typeof entry === "object" && entry.hash === undefined && typeof entry.msg === "string") {
      entry.hash = computePhiMessageHash(entry.msg);
    }
    if (!entry || typeof entry.hash !== "string" || typeof entry.ctx !== "string" || typeof entry.msg !== "string"
      || !(entry.translation === null || typeof entry.translation === "string")) {
      throw new Error(`Entry ${index + 1} needs hash, ctx and msg as text and translation as text or null.`);
    }
  });
  return file as PhiTranslationExchangeFile;
}

/**
 * What a message needs to be created, checked before anything is written. Every problem is named, so a
 * hand-written file is corrected in one go.
 */
function readPhiTranslationCreationProblems(file: PhiTranslationExchangeFile) {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  file.entries.forEach((entry, index) => {
    if (entry.translation == null) return;
    const label = `Entry ${index + 1}`;
    if (entry.msg.trim().length === 0) {
      problems.push(`${label}: msg must be the source text, not empty.`);
      return;
    }
    try {
      if (buildTranslationContext({ context: entry.ctx }) !== entry.ctx) {
        problems.push(`${label}: ctx "${entry.ctx}" is not in the canonical form the runtime stores.`);
        return;
      }
    } catch (error) {
      problems.push(`${label}: ctx is not a valid context: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const key = `${entry.hash.toLowerCase()}\u0000${entry.ctx}`;
    const earlier = seen.get(key);
    if (earlier !== undefined && earlier !== entry.translation) {
      problems.push(`${label}: the key of msg "${entry.msg.slice(0, 40)}" in ctx "${entry.ctx}" occurs twice with different translations.`);
    }
    seen.set(key, entry.translation);
  });
  return problems;
}

/**
 * Writes a file's translations into the store it was exported from.
 *
 * An entry with `translation: null` is skipped. A message that is gone, whose source changed, or whose
 * translation breaks a placeholder or a tag is refused, unless `add`: then a message the store does not
 * hold is created first, as the request path would, and filled. With `add`, an entry lacking what creation
 * needs aborts the import before anything is written. A message in the canonical source language is not
 * given a translation into it. A translation the store already holds is kept
 * unless `overwrite`. Everything is one transaction, and a dry run rolls it back.
 *
 * With `replaceSource`, a message found by the key whose text is not the entry's takes the entry's text (same
 * id, same key: the hash was checked against the new text above and the context is the lookup's), gets the
 * entry's translation for the file's locale whatever it held, and loses its answers in every other locale.
 * Refused instead: a translation into the canonical source language, a message holding a protected external
 * variant, a product's text (its supplier's `register` replaces it), one that content versions read as their
 * own text (replacing it would rewrite them), and a second, different source for a key the run replaced.
 */
export async function importPhiTranslations(pool: Pool, file: PhiTranslationExchangeFile, options: {
  siteKey?: string | null;
  overwrite?: boolean;
  dryRun?: boolean;
  add?: boolean;
  replaceSource?: boolean;
}): Promise<PhiTranslationImportResult> {
  const locale = requirePhiTranslationLocale(file.locale);
  if (options.add) {
    const problems = readPhiTranslationCreationProblems(file);
    if (problems.length > 0) throw new Error(`--add cannot create from this file; nothing was written:\n  ${problems.join("\n  ")}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const store = await resolveStore(client, options.siteKey);
    if (store.name !== file.store) {
      throw new Error(`The file was exported from the store "${file.store}", not "${store.name}"; name that store.`);
    }
    const t = tables(store);
    const result: PhiTranslationImportResult = {
      store: store.name,
      locale,
      dryRun: options.dryRun === true,
      counts: { created: 0, written: 0, replaced: 0, sourceReplaced: 0, unchanged: 0, kept: 0, refused: 0 },
      created: [],
      refused: [],
      kept: [],
      sourceReplaced: [],
    };
    /** The source each message replaced in this run was given: a later entry naming another one is refused. */
    const replacedInRun = new Map<number, string>();
    const refuse = (entry: PhiTranslationExchangeEntry, reason: string) => {
      result.counts.refused += 1;
      result.refused.push({ hash: entry.hash, ctx: entry.ctx, msg: entry.msg.slice(0, 80), reason });
    };
    for (const entry of file.entries) {
      if (entry.translation == null) continue;
      if (hasTranslationContextFlag(entry.ctx, "extern")) {
        refuse(entry, "an `extern` unit is not exchanged; its key is a source in another language");
        continue;
      }
      if (computePhiMessageHash(entry.msg) !== entry.hash.toLowerCase()) {
        refuse(entry, "its hash is not the hash of its msg");
        continue;
      }
      const defect = readPhiTranslationDefect(entry.msg, entry.ctx, entry.translation);
      if (defect) {
        refuse(entry, defect);
        continue;
      }
      const hashParam = `$${t.params.length + 1}`;
      const ctxParam = `$${t.params.length + 2}`;
      const { rows: [found] } = await client.query<{ id: number; msg: string }>(
        `SELECT m.id, m.msg FROM ${t.msg} m
          WHERE ${t.where} AND m.msg_hash = decode(${hashParam}, 'hex') AND m.ctx = ${ctxParam}`,
        [...t.params, entry.hash.toLowerCase(), entry.ctx],
      );
      let message = found;
      let created = false;
      if (!message) {
        if (!options.add) {
          refuse(entry, "the store holds no such message any more");
          continue;
        }
        if (locale === PHI_CANONICAL_SOURCE_LOCALE) {
          refuse(entry, `its source language is ${locale}, the language it would be translated into`);
          continue;
        }
        const id = store.siteId == null
          ? await ensurePhiGlobalMessageId(client, entry.msg, entry.ctx, entry.hash.toLowerCase())
          : await ensurePhiSiteMessageId(client, store.siteId, entry.msg, entry.ctx);
        message = { id, msg: entry.msg };
        created = true;
      }
      if (message.msg !== entry.msg) {
        if (!options.replaceSource) {
          refuse(entry, "its source text changed since the export (same key; --replace-source takes the file's text)");
          continue;
        }
        const replaced = await replaceSource(client, store, message, entry, locale, replacedInRun);
        if (typeof replaced === "string") {
          refuse(entry, replaced);
          continue;
        }
        result.counts.sourceReplaced += 1;
        result.sourceReplaced.push(replaced);
        continue;
      }
      const { rows: [held] } = await client.query<{ translation: string; external: boolean }>(
        `SELECT translation, source_hash IS NOT NULL AS external FROM ${t.lang} WHERE msg_id = $1 AND locale = $2`,
        [message.id, locale],
      );
      if (held?.external) {
        refuse(entry, "the store holds it as an external unit for this locale");
        continue;
      }
      if (held && held.translation === entry.translation) {
        result.counts.unchanged += 1;
        continue;
      }
      if (held && !options.overwrite) {
        result.counts.kept += 1;
        result.kept.push({ hash: entry.hash, ctx: entry.ctx, msg: entry.msg.slice(0, 80) });
        continue;
      }
      await client.query(
        `INSERT INTO ${t.lang} (msg_id, locale, translation)
           VALUES ($1, $2, $3)
         ON CONFLICT (msg_id, locale) DO UPDATE SET translation = EXCLUDED.translation, updated_at = now()`,
        [message.id, locale, entry.translation],
      );
      if (created) {
        result.counts.created += 1;
        result.created.push({ hash: entry.hash, ctx: entry.ctx, msg: entry.msg.slice(0, 80) });
      } else {
        result.counts[held ? "replaced" : "written"] += 1;
      }
    }
    await client.query(options.dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Replaces a message's source text under its unchanged key, on the import's transaction: the reason it cannot
 * as text, or what it did. The caller has checked that the entry's hash is its text's and its translation's
 * placeholders and tags against the new text.
 *
 * The Site store's change marker moves through the trigger on `tr_site_msg`; the global store has none on
 * `tr_msg`, and its marker moves with the write of the answer into `tr_lang`, which this always makes.
 */
async function replaceSource(
  client: PoolClient,
  store: Store,
  message: { id: number; msg: string },
  entry: PhiTranslationExchangeEntry,
  locale: string,
  replacedInRun: Map<number, string>,
): Promise<PhiTranslationSourceReplacement | string> {
  const t = tables(store);
  const earlier = replacedInRun.get(message.id);
  if (earlier !== undefined) {
    return `an earlier entry of this file gave this key another source ("${earlier.slice(0, 40)}")`;
  }
  if (locale === PHI_CANONICAL_SOURCE_LOCALE) {
    return `its source language is ${locale}, the language it would be translated into`;
  }
  const { rows: answers } = await client.query<{ locale: string; translation: string; external: boolean }>(
    `SELECT locale, translation, source_hash IS NOT NULL AS external FROM ${t.lang} WHERE msg_id = $1 ORDER BY locale`,
    [message.id],
  );
  const external = answers.find((answer) => answer.external);
  if (external) return `it holds a protected external source variant (${external.locale}), which a replaced source would orphan`;
  if (store.siteId != null) {
    const { rows: [use] } = await client.query<{ product: boolean; content: string }>(
      `SELECT EXISTS (SELECT 1 FROM phis.product_texts WHERE msg_id = $1) AS product,
              (SELECT count(*) FROM phis.site_content_version_text WHERE msg_id = $1) AS content`,
      [message.id],
    );
    if (use?.product) return "it is a product's text; its supplier's register replaces it";
    const versions = Number(use?.content ?? 0);
    if (versions > 0) {
      return `${versions} content version${versions === 1 ? "" : "s"} read it as their own text; replacing it would rewrite them`;
    }
  }
  const dropped = answers.filter((answer) => answer.locale !== locale);
  if (dropped.length > 0) {
    await client.query(`DELETE FROM ${t.lang} WHERE msg_id = $1 AND locale <> $2`, [message.id, locale]);
  }
  await client.query(`UPDATE ${t.msg} SET msg = $2 WHERE id = $1`, [message.id, entry.msg]);
  await client.query(
    `INSERT INTO ${t.lang} (msg_id, locale, translation)
       VALUES ($1, $2, $3)
     ON CONFLICT (msg_id, locale) DO UPDATE SET translation = EXCLUDED.translation, updated_at = now()`,
    [message.id, locale, entry.translation],
  );
  replacedInRun.set(message.id, entry.msg);
  const differsAt = firstDifference(message.msg, entry.msg);
  const start = Math.max(0, differsAt - 20);
  return {
    hash: entry.hash,
    ctx: entry.ctx,
    msg: entry.msg.slice(0, 80),
    differsAt,
    oldExcerpt: excerptFrom(message.msg, start),
    newExcerpt: excerptFrom(entry.msg, start),
    dropped: dropped.map((answer) => ({ locale: answer.locale, translation: answer.translation.slice(0, 80) })),
  };
}
