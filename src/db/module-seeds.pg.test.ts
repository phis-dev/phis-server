import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "@/../test/pg/harness";
import { materializeSiteModuleSeedsWithDb } from "@/db/module-seeds";

const configured = process.env.PHIS_PG_TEST === "1";

/**
 * A seed is the one declaration that writes rows, so the cases that matter are the ones availability
 * never had: what a second publish does, what an administrator's edit survives, and what happens when
 * the Module stops being published.
 */
describe.skipIf(!configured)("materializeSiteModuleSeedsWithDb", () => {
  let site: PhiTestSite;

  const SEED = [{
    moduleId: "@phis/support/modules/support",
    groups: [{ key: "support", name: "Support" }],
    supportQueues: [{ key: "entry", name: "Support", groupKey: "support", flags: 1 }],
    supportTicketTypes: [{ key: "request", name: "Request" }],
  }];

  /** One published Area carrying `seed` in its Module namespace, as the Builder writes it. */
  async function publishArea(target: PhiTestSite, areaId: number, seed: unknown) {
    const pool = await requirePhiTestDatabase();
    const { rows: scopes } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_area_scopes (site_id, area_id) VALUES ($1, $2)
       ON CONFLICT (site_id, area_id) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [target.id, areaId],
    );
    const scopeId = scopes[0]!.id;
    const { rows: revisions } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_area_revisions (area_scope_id, tree_json) VALUES ($1, $2) RETURNING id`,
      [scopeId, JSON.stringify({ preset: { config: { modules: { seed } } } })],
    );
    await pool.query(
      `UPDATE phis.site_area_scopes SET published_revision_id = $2 WHERE id = $1`,
      [scopeId, revisions[0]!.id],
    );
  }

  async function readQueue() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      id: number; name: string; flags: number; group_id: number; provider_id: string;
    }>(
      `SELECT queue.id, queue.name, queue.flags, queue.group_id, grp.provider_id
       FROM phis.support_queues queue
       JOIN phis.site_groups grp ON grp.id = queue.group_id
       WHERE queue.site_id = $1 AND queue.key = 'entry'`,
      [site.id],
    );
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    site = await createPhiTestSite("module-seeds");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("writes the group, the queue and the type a published Module declares", async () => {
    const pool = await requirePhiTestDatabase();
    await publishArea(site, 2, SEED);
    await materializeSiteModuleSeedsWithDb(pool, site.id);

    const queue = await readQueue();
    expect(queue).not.toBeNull();
    // The queue routes to the group the same declaration named, and the group records who asked.
    expect(queue!.flags).toBe(1);
    expect(queue!.provider_id).toBe("@phis/support/modules/support");

    const { rows: types } = await pool.query<{ key: string; flags: number }>(
      `SELECT key, flags FROM phis.support_ticket_types WHERE site_id = $1`,
      [site.id],
    );
    expect(types).toHaveLength(1);
    // Not requestable: who may ask for a type is the Site's decision, never one it inherits.
    expect(types[0]).toMatchObject({ key: "request", flags: 0 });
  });

  it("leaves what the Site did with the rows alone on the next publish", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.support_queues SET name = 'Kundendienst', flags = 0
       WHERE site_id = $1 AND key = 'entry'`,
      [site.id],
    );
    await materializeSiteModuleSeedsWithDb(pool, site.id);

    const queue = await readQueue();
    expect(queue).toMatchObject({ name: 'Kundendienst', flags: 0 });
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.support_queues WHERE site_id = $1`,
      [site.id],
    );
    // Found by its key, so a second publish repairs nothing and duplicates nothing.
    expect(rows[0]!.count).toBe("1");
  });

  it("writes one set of rows for a Module published in two Areas", async () => {
    const pool = await requirePhiTestDatabase();
    await publishArea(site, 256, SEED);
    await materializeSiteModuleSeedsWithDb(pool, site.id);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.site_groups WHERE site_id = $1 AND key = 'support'`,
      [site.id],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("keeps the rows when the Module stops being published", async () => {
    const pool = await requirePhiTestDatabase();
    await publishArea(site, 2, []);
    await publishArea(site, 256, []);
    await materializeSiteModuleSeedsWithDb(pool, site.id);

    // Availability narrows on publish; rows a ticket could be pointed at do not.
    expect(await readQueue()).not.toBeNull();
  });

  it("writes no queue when its group is not in the same declaration", async () => {
    const pool = await requirePhiTestDatabase();
    const other = await createPhiTestSite("module-seeds-orphan");
    await publishArea(other, 2, [{
      moduleId: "@phis/example/modules/example",
      supportQueues: [{ key: "entry", name: "Nowhere", groupKey: "absent" }],
    }]);
    await materializeSiteModuleSeedsWithDb(pool, other.id);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.support_queues WHERE site_id = $1`,
      [other.id],
    );
    // Half a queue -- one that routes nowhere -- would be worse than none.
    expect(rows[0]!.count).toBe("0");
  });
});
