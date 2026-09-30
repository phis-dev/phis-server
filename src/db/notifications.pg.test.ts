import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  claimDuePhiNotifications,
  claimPhiNotificationById,
  claimPhiNotificationLinkSalt,
  countOwedPhiNotifications,
  ensurePhiNotificationLinkSalt,
  enqueuePhiNotification,
  markPhiNotificationDropped,
  markPhiNotificationFailed,
  markPhiNotificationSent,
  PHI_NOTIFICATION_FLAG_DROPPED,
  PHI_NOTIFICATION_FLAG_SENT,
} from "./notifications";

/**
 * The outbox is three single statements whose answers depend on what PostgreSQL does when two drains
 * arrive together, plus one rule about secrets: a settled row keeps no parameters, because a reset link
 * carries a token that is only ever stored hashed.
 */
describe("the notification outbox against PostgreSQL", () => {
  let pool: Pool;
  let site: PhiTestSite;

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("notifications");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function readRow(id: string) {
    const { rows } = await pool.query<{
      flags: number;
      attempts: number;
      params: Record<string, unknown>;
      sent_at: string | null;
      message_id: string | null;
      last_error: string | null;
    }>(
      `SELECT flags, attempts, params, sent_at, message_id, last_error
       FROM phis.notification_outbox WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  it("refuses a second row under a key the first one used", async () => {
    const first = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "news_digest",
      recipient: { address: "one@example.invalid", locale: "en" },
      dedupeKey: "digest:1",
    });
    const second = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "news_digest",
      recipient: { address: "one@example.invalid", locale: "en" },
      dedupeKey: "digest:1",
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    // Without a key there is no protection, which is right for a message somebody just triggered.
    const third = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "password_reset",
      recipient: { address: "one@example.invalid", locale: "en" },
    });
    expect(third).not.toBeNull();
  });

  it("claims a row by id, counts the attempt, and does not hand it out again while it waits", async () => {
    const id = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "password_reset",
      recipient: { address: "claim@example.invalid", locale: "en" },
      params: { verificationUrl: "https://site.test/reset?token=plain-token" },
    });

    // Returning the row's own columns is what broke first: the CTE carries an `id` too.
    const claimed = await claimPhiNotificationById(id!);
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.params).toMatchObject({ verificationUrl: expect.stringContaining("plain-token") });

    expect(await claimPhiNotificationById(id!)).toBeNull();
    const due = await claimDuePhiNotifications(50);
    expect(due.map((row) => row.id)).not.toContain(id);
  });

  it("empties the parameters when the row is sent, and keeps the record", async () => {
    const id = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "password_reset",
      recipient: { address: "sent@example.invalid", locale: "en" },
      params: { verificationUrl: "https://site.test/reset?token=secret-token" },
    });

    await markPhiNotificationSent(id!, "<message@id>");
    const row = await readRow(id!);
    expect(row.params).toEqual({});
    expect(row.sent_at).not.toBeNull();
    expect(row.message_id).toBe("<message@id>");
    expect(await claimPhiNotificationById(id!)).toBeNull();
  });

  it("keeps the parameters while another attempt is coming, and drops them at the ceiling", async () => {
    const id = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "password_reset",
      recipient: { address: "failing@example.invalid", locale: "en" },
      params: { verificationUrl: "https://site.test/reset?token=still-needed" },
    });

    await markPhiNotificationFailed(id!, "the transport refused");
    expect((await readRow(id!)).params).toMatchObject({
      verificationUrl: expect.stringContaining("still-needed"),
    });

    await pool.query(`UPDATE phis.notification_outbox SET attempts = 8 WHERE id = $1`, [id]);
    await markPhiNotificationFailed(id!, "the transport refused for the last time");
    const row = await readRow(id!);
    expect(row.params).toEqual({});
    expect(row.last_error).toContain("last time");

    // Past the ceiling it is no longer offered, with or without a due time.
    await pool.query(`UPDATE phis.notification_outbox SET next_attempt_at = NOW() WHERE id = $1`, [id]);
    expect((await claimDuePhiNotifications(50)).map((entry) => entry.id)).not.toContain(id);
  });

  it("settles a dropped row without sending it, and never offers it again", async () => {
    const id = await enqueuePhiNotification({
      siteId: site.id,
      occasion: "news_digest",
      recipient: { userId: await createPhiTestUser(site) },
      flags: PHI_NOTIFICATION_FLAG_SENT,
      params: { anything: "goes" },
    });

    await markPhiNotificationDropped(id!, "consent was withdrawn");
    const row = await readRow(id!);
    expect(row.flags & PHI_NOTIFICATION_FLAG_DROPPED).toBe(PHI_NOTIFICATION_FLAG_DROPPED);
    expect(row.sent_at).toBeNull();
    expect(row.params).toEqual({});

    expect(await claimPhiNotificationById(id!)).toBeNull();
    expect((await claimDuePhiNotifications(50)).map((entry) => entry.id)).not.toContain(id);

    const counts = await countOwedPhiNotifications(site.id);
    expect(counts.dropped).toBeGreaterThanOrEqual(1);
  });

  it("mints one link salt per membership and hands the same one back", async () => {
    const userId = await createPhiTestUser(site);
    const first = await ensurePhiNotificationLinkSalt(userId, site.id, "a".repeat(32));
    const second = await ensurePhiNotificationLinkSalt(userId, site.id, "b".repeat(32));

    expect(first).toBe("a".repeat(32));
    expect(second).toBe("a".repeat(32));

    expect(await claimPhiNotificationLinkSalt(userId, site.id)).toBe("a".repeat(32));
    // A membership nobody has is not an error to be dressed up as success.
    expect(await claimPhiNotificationLinkSalt(userId + 99_000, site.id)).toBeNull();
  });
});
