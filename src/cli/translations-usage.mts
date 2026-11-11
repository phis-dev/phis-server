import type { Pool } from "pg";

/**
 * Which texts nothing has read in a while: `phis translations usage`.
 *
 * Reads `tr_msg_usage` and `tr_site_msg_usage` (DB.md, TRANSLATIONS.md "When a message was last read")
 * beside the stores they describe. It changes nothing; deleting by it is a decision for later.
 *
 * A message is unread for N days when it has no usage row or its last read lies further back, and it is
 * older than that itself -- a text created yesterday has not had the chance to be read. "Read" is Core
 * answering a Site from a translation, so a text only ever shown in its source language never counts.
 */

export type PhiTranslationUsageStore = {
  /** `global`, or the Site's key. */
  store: string;
  messages: number;
  /** The first day anything was noted for this store, or null when nothing has been yet. */
  trackedSince: string | null;
  readWithin: number;
  unread: number;
  unreadCharacters: number;
  examples: Array<{ msg: string; ctx: string; lastUsedOn: string | null; createdOn: string }>;
};

type StoreRow = {
  messages: string;
  tracked_since: string | null;
  read_within: string;
  unread: string;
  unread_characters: string | null;
};

type ExampleRow = { msg: string; ctx: string; last_used_on: string | null; created_on: string };

async function readStore(pool: Pool, input: {
  store: string;
  messages: string;
  usage: string;
  where: string;
  params: unknown[];
  days: number;
  examples: number;
}): Promise<PhiTranslationUsageStore> {
  const daysParam = `$${input.params.length + 1}`;
  const unread = `(u.last_used_on IS NULL OR u.last_used_on < current_date - ${daysParam}::int)
    AND m.created_at < current_date - ${daysParam}::int`;
  const { rows: [row] } = await pool.query<StoreRow>(
    `SELECT count(*) AS messages,
            min(u.last_used_on)::text AS tracked_since,
            count(*) FILTER (WHERE u.last_used_on >= current_date - ${daysParam}::int) AS read_within,
            count(*) FILTER (WHERE ${unread}) AS unread,
            sum(length(m.msg)) FILTER (WHERE ${unread}) AS unread_characters
       FROM ${input.messages} m
       LEFT JOIN ${input.usage} u ON u.msg_id = m.id
      WHERE ${input.where}`,
    [...input.params, input.days],
  );
  const { rows: examples } = input.examples > 0
    ? await pool.query<ExampleRow>(
        `SELECT left(m.msg, 80) AS msg, m.ctx, u.last_used_on::text AS last_used_on,
                m.created_at::date::text AS created_on
           FROM ${input.messages} m
           LEFT JOIN ${input.usage} u ON u.msg_id = m.id
          WHERE ${input.where} AND ${unread}
          ORDER BY u.last_used_on NULLS FIRST, m.id
          LIMIT ${Math.max(0, Math.floor(input.examples))}`,
        [...input.params, input.days],
      )
    : { rows: [] };
  return {
    store: input.store,
    messages: Number(row?.messages ?? 0),
    trackedSince: row?.tracked_since ?? null,
    readWithin: Number(row?.read_within ?? 0),
    unread: Number(row?.unread ?? 0),
    unreadCharacters: Number(row?.unread_characters ?? 0),
    examples: examples.map((example) => ({
      msg: example.msg,
      ctx: example.ctx,
      lastUsedOn: example.last_used_on,
      createdOn: example.created_on,
    })),
  };
}

/** The global store and every Site's, or one Site's alone. */
export async function readPhiTranslationUsage(pool: Pool, options: {
  days: number;
  siteKey?: string | null;
  examples?: number;
}): Promise<PhiTranslationUsageStore[]> {
  const examples = options.examples ?? 5;
  const { rows: sites } = await pool.query<{ id: number; key: string }>(
    options.siteKey
      ? "SELECT id, key FROM phis.sites WHERE key = $1"
      : "SELECT id, key FROM phis.sites ORDER BY key",
    options.siteKey ? [options.siteKey] : [],
  );
  if (options.siteKey && sites.length === 0) {
    throw new Error(`No Site has the key "${options.siteKey}".`);
  }
  const stores: PhiTranslationUsageStore[] = [];
  if (!options.siteKey) {
    stores.push(await readStore(pool, {
      store: "global",
      messages: "phis.tr_msg",
      usage: "phis.tr_msg_usage",
      where: "true",
      params: [],
      days: options.days,
      examples,
    }));
  }
  for (const site of sites) {
    stores.push(await readStore(pool, {
      store: site.key,
      messages: "phis.tr_site_msg",
      usage: "phis.tr_site_msg_usage",
      where: "m.site_id = $1",
      params: [site.id],
      days: options.days,
      examples,
    }));
  }
  return stores;
}

/** `90d`, `12w` or a plain number of days. */
export function parsePhiUsageDays(raw: string | boolean | undefined, fallback: number) {
  if (raw === undefined) return fallback;
  const match = /^(\d+)\s*([dw]?)$/u.exec(String(raw).trim());
  if (!match) {
    throw new Error(`--unused-for takes days such as 90d or 12w, not "${String(raw)}".`);
  }
  const value = Number(match[1]) * (match[2] === "w" ? 7 : 1);
  if (value <= 0) {
    throw new Error("--unused-for takes at least one day.");
  }
  return value;
}
