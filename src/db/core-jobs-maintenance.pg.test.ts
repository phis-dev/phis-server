import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PhisSupportQueueFlag, PhisSupportTicketStatus } from "@phis/contracts/support";
import { PhisSiteThreadKindFlag } from "@phis/contracts/threads";

import { PHI_MAINTENANCE_TASKS } from "../cli/maintain.mts";
import { findPhiCoreJob } from "@/lib/jobs/core-jobs";
import { ensureAddonMediaSpace, ensureSiteMediaSpace } from "@/db/media-spaces";
import { createSupportTicket } from "./support";
import {
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * A Core job and the `phis maintain` task it took over do one thing, because they call one function.
 *
 * Each case seeds the same rows twice, runs them once as the job the clock starts and once as the task
 * an operator starts, and expects the same effect both times. One case a job is enough: the statements
 * themselves are covered where they were written (`maintain.pg.test.ts`).
 */

const ADDON = "@pgtest/core-jobs";

const runners = [
  {
    name: "the job",
    run: async (jobId: string) => { await findPhiCoreJob(jobId)!.run(new AbortController().signal); },
  },
  {
    name: "the task",
    run: async (_jobId: string, taskId: string) => {
      const pool = await requirePhiTestDatabase();
      const result = await PHI_MAINTENANCE_TASKS.find((task) => task.id === taskId)!.run(pool, { dryRun: false });
      expect(result.detail.length).toBeGreaterThan(0);
    },
  },
];

describe("housekeeping through the clock and through `phis maintain`", () => {
  let site: PhiTestSite;
  let actor: number;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("core-jobs");
    actor = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.addon_hook_deliveries WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  async function expiredSession(spaceId: number, profileId: number, bytes: number) {
    const pool = await requirePhiTestDatabase();
    const token = `pgtest-${crypto.randomUUID()}`;
    await pool.query(
      `INSERT INTO phis.media_upload_sessions
         (token, site_id, actor_user_id, space_id, storage_profile_id, status, filename,
          content_type, size_bytes, kind, staging_storage_key, expires_at)
       VALUES ($1, $2, $3, $4, $5, 0, 'x.bin', 'application/octet-stream', $6, 'file', $7, NOW() - interval '1 hour')`,
      [token, site.id, actor, spaceId, profileId, bytes, `staging/${token}`],
    );
    await pool.query(`UPDATE phis.media_spaces SET reserved_bytes = reserved_bytes + $2 WHERE id = $1`, [spaceId, bytes]);
    return token;
  }

  const sessionRows = async (token: string) =>
    (await (await requirePhiTestDatabase()).query(`SELECT 1 FROM phis.media_upload_sessions WHERE token = $1`, [token])).rowCount;
  const reserved = async (spaceId: number) =>
    Number((await (await requirePhiTestDatabase()).query<{ reserved_bytes: string }>(
      `SELECT reserved_bytes FROM phis.media_spaces WHERE id = $1`, [spaceId],
    )).rows[0]!.reserved_bytes);

  for (const { name, run } of runners) {
    describe(name, () => {
      it("upload-sessions: releases an expired reservation and gives the Space its figure back", async () => {
        const { space } = await ensureSiteMediaSpace(site.id);
        const before = await reserved(space.id);
        const token = await expiredSession(space.id, space.defaultStorageProfileId, 700);
        expect(await reserved(space.id)).toBe(before + 700);

        await run("upload-sessions.prune", "upload-sessions");

        expect(await sessionRows(token)).toBe(0);
        expect(await reserved(space.id)).toBe(before);
      });

      it("addon-assets: sweeps an Add-on's Space, the lapsed reservations included", async () => {
        const space = await ensureAddonMediaSpace(site.id, ADDON);
        const before = await reserved(space.id);
        const token = await expiredSession(space.id, space.defaultStorageProfileId, 300);

        await run("addon-assets.collect", "addon-assets");

        expect(await sessionRows(token)).toBe(0);
        expect(await reserved(space.id)).toBe(before);
      });

      it("queue-retention: forgets what settled past its window and keeps what is owed", async () => {
        const pool = await requirePhiTestDatabase();
        const mail = (occasion: string, sentDaysAgo: number | null) => pool.query(
          `INSERT INTO phis.notification_outbox
             (site_id, occasion, flags, recipient_address, locale, attempts, created_at, sent_at, last_error)
           VALUES ($1, $2, 0, 'who@example.invalid', 'en', 0, NOW() - interval '400 days',
                   CASE WHEN $3::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $3::int) END, 'x')`,
          [site.id, occasion, sentDaysAgo],
        );
        await mail("pgtest.old", 91);
        await mail("pgtest.fresh", 89);
        await mail("pgtest.owed", null);

        await run("queues.prune", "queue-retention");

        const { rows } = await pool.query<{ occasion: string }>(
          `SELECT occasion FROM phis.notification_outbox WHERE site_id = $1 AND occasion LIKE 'pgtest.%' ORDER BY occasion`,
          [site.id],
        );
        expect(rows.map((row) => row.occasion)).toEqual(["pgtest.fresh", "pgtest.owed"]);
        await pool.query(`DELETE FROM phis.notification_outbox WHERE site_id = $1`, [site.id]);
      });

      it("hook-deliveries: forgets a delivery older than the window and keeps a recent one", async () => {
        const pool = await requirePhiTestDatabase();
        await pool.query(
          `INSERT INTO phis.addon_hook_deliveries (addon_id, delivery_id, received_at)
           VALUES ($1, 'old', NOW() - make_interval(days => 31)), ($1, 'recent', NOW() - make_interval(days => 29))`,
          [ADDON],
        );

        await run("hook-deliveries.prune", "hook-deliveries");

        const { rows } = await pool.query<{ delivery_id: string }>(
          `SELECT delivery_id FROM phis.addon_hook_deliveries WHERE addon_id = $1`, [ADDON],
        );
        expect(rows.map((row) => row.delivery_id)).toEqual(["recent"]);
        await pool.query(`DELETE FROM phis.addon_hook_deliveries WHERE addon_id = $1`, [ADDON]);
      });

      it("support-requester-window: writes down as closed a resolved ticket past its window", async () => {
        const pool = await requirePhiTestDatabase();
        await pool.query(
          `INSERT INTO phis.site_thread_config (site_id, flags, requester_window_days)
           VALUES ($1, $2, 14)
           ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags, requester_window_days = 14`,
          [site.id, PhisSiteThreadKindFlag.Support],
        );
        const groupId = await createPhiTestGroup(site, `pgtest-core-jobs-${crypto.randomUUID().slice(0, 8)}`);
        await pool.query(
          `INSERT INTO phis.support_queues (site_id, group_id, key, name, flags)
           VALUES ($1, $2, $3, 'Entry', $4)`,
          [site.id, groupId, `entry-${crypto.randomUUID().slice(0, 8)}`, PhisSupportQueueFlag.Entry],
        );
        const { rows: types } = await pool.query<{ id: number }>(
          `INSERT INTO phis.support_ticket_types (site_id, key, name, flags, close_policy, requester_window_days)
           VALUES ($1, $2, 'Request', 0, 0, NULL) RETURNING id`,
          [site.id, `request-${crypto.randomUUID().slice(0, 8)}`],
        );
        const created = await createSupportTicket({
          siteId: site.id, typeId: types[0]!.id, channel: 0, subject: "The export fails", message: "It fails.",
          requesterUserId: actor, createdByUserId: actor,
        });
        const ticketId = created!.ticket.id;
        await pool.query(
          `UPDATE phis.support_tickets
              SET status = ${PhisSupportTicketStatus.Resolved}, resolved_at = NOW() - make_interval(days => 20)
            WHERE id = $1`,
          [ticketId],
        );

        await run("support-tickets.close", "support-requester-window");

        const { rows } = await pool.query<{ status: number }>(`SELECT status FROM phis.support_tickets WHERE id = $1`, [ticketId]);
        expect(rows[0]!.status).toBe(PhisSupportTicketStatus.Closed);
      });
    });
  }
});
