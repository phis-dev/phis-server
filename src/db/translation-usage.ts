import { getPool } from "@/lib/db";

/**
 * When a message was last read: kept per message and day in `tr_msg_usage` and `tr_site_msg_usage`
 * (DB.md), so an operator can see which texts nothing has asked for in a while (`phis translations usage`).
 * Nothing deletes by it.
 *
 * A read is Core answering a request for a message from a translation it holds -- the lookups in
 * db/translations.ts call `notePhiTranslationUse` with the ids they found. A Site keeps what it read for a
 * day at most (phis-ui gateway/CACHES.md, "Translation Caching"), so a text a Site still shows is read
 * here again within a day; a text nobody shows is not.
 *
 * Written at most once per message and day. The process notes what it saw today in memory and writes the
 * new ones in one statement a minute later; the statement only moves a date forward, so another instance
 * or a restart writing the same day is a no-op. A crash loses at most a minute of notes, which the next
 * read puts back. The usage tables carry no change-marker trigger: writing them empties no Site cache.
 */

type PhiTranslationUseScope = "global" | "site";

const FLUSH_DELAY_MS = 60_000;

type PhiTranslationUseState = {
  /** The day the sets below belong to. The date written is the database's; this one only resets the sets. */
  day: string;
  /** Noted today, written or waiting to be. */
  seen: Record<PhiTranslationUseScope, Set<number>>;
  pending: Record<PhiTranslationUseScope, Set<number>>;
  timer: ReturnType<typeof setTimeout> | null;
};

const USAGE_STATE_KEY = Symbol.for("phis.translation-usage.state");
const STATE: PhiTranslationUseState = (() => {
  const holder = globalThis as typeof globalThis & { [USAGE_STATE_KEY]?: PhiTranslationUseState };
  holder[USAGE_STATE_KEY] ??= {
    day: "",
    seen: { global: new Set(), site: new Set() },
    pending: { global: new Set(), site: new Set() },
    timer: null,
  };
  return holder[USAGE_STATE_KEY];
})();

function today() {
  return new Date().toISOString().slice(0, 10);
}

const TABLES: Record<PhiTranslationUseScope, { usage: string; messages: string }> = {
  global: { usage: "phis.tr_msg_usage", messages: "phis.tr_msg" },
  site: { usage: "phis.tr_site_msg_usage", messages: "phis.tr_site_msg" },
};

/** Notes that these messages were read now. Cheap: a message already noted today costs a Set lookup. */
export function notePhiTranslationUse(scope: PhiTranslationUseScope, msgIds: Iterable<number>) {
  const day = today();
  if (STATE.day !== day) {
    STATE.day = day;
    STATE.seen.global.clear();
    STATE.seen.site.clear();
  }
  let added = false;
  for (const msgId of msgIds) {
    if (!Number.isInteger(msgId) || msgId <= 0 || STATE.seen[scope].has(msgId)) continue;
    STATE.seen[scope].add(msgId);
    STATE.pending[scope].add(msgId);
    added = true;
  }
  if (added && !STATE.timer) {
    STATE.timer = setTimeout(() => {
      STATE.timer = null;
      void flushPhiTranslationUse().catch(() => {
        // A lost note is put back by the next read on another day; it is never worth a failed request.
      });
    }, FLUSH_DELAY_MS);
    STATE.timer.unref?.();
  }
}

/**
 * Writes what is waiting. Only a message that still exists gets a row (one deleted meanwhile is skipped,
 * not a failed batch), and a row's date only ever moves forward.
 */
export async function flushPhiTranslationUse() {
  // Writing now settles what a waiting timer would have written; the next new read starts another.
  if (STATE.timer) {
    clearTimeout(STATE.timer);
    STATE.timer = null;
  }
  for (const scope of ["global", "site"] as const) {
    const ids = [...STATE.pending[scope]];
    STATE.pending[scope].clear();
    if (ids.length === 0) continue;
    const { usage, messages } = TABLES[scope];
    await getPool().query(
      `INSERT INTO ${usage} (msg_id, last_used_on)
       SELECT id, current_date FROM ${messages} WHERE id = ANY($1::int[])
       ON CONFLICT (msg_id) DO UPDATE SET last_used_on = EXCLUDED.last_used_on
       WHERE ${usage}.last_used_on < EXCLUDED.last_used_on`,
      [ids],
    );
  }
}
