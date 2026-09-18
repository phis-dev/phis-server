import "server-only";

import type { PoolClient } from "pg";

import { logRuntimeEvent } from "@/lib/log";

type DbQueryable = Pick<PoolClient, "query">;

/**
 * The rows a Module needs a Site to have, written when the Area carrying that Module is published.
 *
 * This is deliberately not the shape `materializeSiteMediaAvailabilityWithDb` and
 * `materializeSiteThreadKindsWithDb` have, although it is called from beside them. Those recompute
 * availability as the union across published Areas, which is safe to redo on every publish because a
 * narrowing loses nothing. These are rows other rows point at -- a ticket names its queue and its type
 * -- so the rules are the opposite ones:
 *
 * - found by the key the Module gives them, never by position or by name;
 * - created when absent, and **never rewritten**, so a publish cannot take an administrator's rename
 *   or re-flag away again;
 * - never deleted, because a Module that stops being published stops offering its surfaces and has no
 *   business taking a queue that open tickets are routed through with it. Retirement is the Site's,
 *   through administration.
 *
 * See design/SUPPORT.md section 4.
 */

/** As `site_groups_key_check` and `support_queues`/`support_ticket_types` keys are spelled. */
const GROUP_KEY = /^[a-z0-9][a-z0-9._-]{0,159}$/u;
const ROW_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

type DeclaredGroup = { key: string; name: string };
type DeclaredQueue = { key: string; name: string; groupKey: string; flags?: number };
type DeclaredTicketType = {
  key: string;
  name: string;
  flags?: number;
  closePolicy?: number;
};
type DeclaredSeed = {
  moduleId: string;
  groups?: DeclaredGroup[];
  supportQueues?: DeclaredQueue[];
  supportTicketTypes?: DeclaredTicketType[];
};

function readString(value: unknown, max: number) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;
}

function readFlags(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * What a published Area's preset says, as far as this release can read it.
 *
 * A row it cannot make sense of is dropped rather than refused, the way an unknown thread kind is: a
 * newer Module must not make an older control plane reject a publish. A dropped row is logged, because
 * unlike a narrowed availability it leaves a Site that cannot do the thing the Module came for.
 */
function readDeclaredSeeds(value: unknown, siteId: number): DeclaredSeed[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seeds: DeclaredSeed[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const moduleId = readString(record.moduleId, 255);
    if (!moduleId || !/^@[^/]+\/[^/]+(?:\/[^/]+)*$/u.test(moduleId)) {
      logRuntimeEvent("warn", "site.module_seed.unreadable", { meta: { siteId, reason: "module_id" } });
      continue;
    }
    const seed: DeclaredSeed = { moduleId };

    const groups: DeclaredGroup[] = [];
    for (const candidate of Array.isArray(record.groups) ? record.groups : []) {
      const row = candidate as Record<string, unknown>;
      const key = readString(row.key, 160);
      const name = readString(row.name, 255);
      if (!key || !name || !GROUP_KEY.test(key)) {
        logRuntimeEvent("warn", "site.module_seed.unreadable", { meta: { siteId, moduleId, kind: "group" } });
        continue;
      }
      groups.push({ key, name });
    }
    if (groups.length) seed.groups = groups;

    const queues: DeclaredQueue[] = [];
    for (const candidate of Array.isArray(record.supportQueues) ? record.supportQueues : []) {
      const row = candidate as Record<string, unknown>;
      const key = readString(row.key, 64);
      const name = readString(row.name, 128);
      const groupKey = readString(row.groupKey, 160);
      if (!key || !name || !groupKey || !ROW_KEY.test(key)) {
        logRuntimeEvent("warn", "site.module_seed.unreadable", { meta: { siteId, moduleId, kind: "queue" } });
        continue;
      }
      queues.push({ key, name, groupKey, flags: readFlags(row.flags) });
    }
    if (queues.length) seed.supportQueues = queues;

    const types: DeclaredTicketType[] = [];
    for (const candidate of Array.isArray(record.supportTicketTypes) ? record.supportTicketTypes : []) {
      const row = candidate as Record<string, unknown>;
      const key = readString(row.key, 64);
      const name = readString(row.name, 128);
      if (!key || !name || !ROW_KEY.test(key)) {
        logRuntimeEvent("warn", "site.module_seed.unreadable", { meta: { siteId, moduleId, kind: "ticket_type" } });
        continue;
      }
      types.push({ key, name, flags: readFlags(row.flags), closePolicy: readFlags(row.closePolicy) });
    }
    if (types.length) seed.supportTicketTypes = types;

    seeds.push(seed);
  }
  return seeds;
}

/**
 * The group's id, made if this Module has not made it before.
 *
 * `provider_id` is the declaring Module and is supplied here rather than taken from the declaration, so
 * a Module cannot name itself into a group another Module owns. `DO NOTHING` rather than an upsert is
 * the rule above: the name is a starting value, and what the Site called it afterwards stays.
 */
async function ensureSeededGroup(
  db: DbQueryable,
  siteId: number,
  moduleId: string,
  group: DeclaredGroup,
) {
  await db.query(
    `INSERT INTO phis.site_groups (site_id, provider_id, key, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, provider_id, key) DO NOTHING`,
    [siteId, moduleId, group.key, group.name],
  );
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM phis.site_groups
     WHERE site_id = $1 AND provider_id = $2 AND key = $3`,
    [siteId, moduleId, group.key],
  );
  return rows[0]?.id ?? null;
}

/**
 * Writes what the Site's published Areas declare their Modules need, and nothing else.
 *
 * Group before queue, because `support_queues.group_id` is `NOT NULL` and the group has no id until
 * this pass gives it one. That ordering is why a declaration names a group by key and never by id, and
 * why it is resolved here rather than scripted by the Module.
 */
export async function materializeSiteModuleSeedsWithDb(db: DbQueryable, siteId: number) {
  const { rows } = await db.query<{ seed: unknown }>(
    `SELECT revision.tree_json #> '{preset,config,modules,seed}' AS seed
     FROM phis.site_area_scopes scope
     JOIN phis.site_area_revisions revision ON revision.id = scope.published_revision_id
     WHERE scope.site_id = $1`,
    [siteId],
  );

  /*
   * One Module may be published in more than one Area and then declares the same rows twice. The keys
   * make that harmless -- the second pass finds what the first made -- but doing the work once keeps
   * the publish from growing with the number of Areas that happen to carry the Module.
   */
  const byModule = new Map<string, DeclaredSeed>();
  for (const row of rows) {
    for (const seed of readDeclaredSeeds(row.seed, siteId)) {
      if (!byModule.has(seed.moduleId)) {
        byModule.set(seed.moduleId, seed);
      }
    }
  }

  for (const [moduleId, seed] of byModule) {
    const groupIdsByKey = new Map<string, number>();
    for (const group of seed.groups ?? []) {
      const id = await ensureSeededGroup(db, siteId, moduleId, group);
      if (id != null) {
        groupIdsByKey.set(group.key, id);
      }
    }

    for (const queue of seed.supportQueues ?? []) {
      const groupId = groupIdsByKey.get(queue.groupKey);
      if (groupId == null) {
        // A queue whose group the same declaration does not carry. Nothing to route to, so nothing is
        // written: half a queue would be worse than none.
        logRuntimeEvent("warn", "site.module_seed.queue_group_missing", {
          meta: { siteId, moduleId, queue: queue.key, groupKey: queue.groupKey },
        });
        continue;
      }
      await db.query(
        `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (site_id, key) DO NOTHING`,
        [siteId, groupId, queue.key, queue.name, queue.flags ?? 0],
      );
    }

    for (const type of seed.supportTicketTypes ?? []) {
      await db.query(
        `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (site_id, key) DO NOTHING`,
        [siteId, type.key, type.name, type.flags ?? 0, type.closePolicy ?? 0],
      );
    }
  }
}
