import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { Pool } from "pg";

import { createUserSession, revokeUserSessions } from "./user-sessions";

/**
 * Whether a session falls with the password is something only PostgreSQL can answer: the statement
 * compares the session id with the one to spare, and the column is a `uuid`. A fake accepts any
 * comparison; the database refuses one between a uuid and a text, and did, on every call, so the
 * sessions a new password was meant to end stayed open. These run the statement for real.
 */
describe("revokeUserSessions against PostgreSQL", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let userId: number;

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("sessions");
    userId = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function openSession() {
    const session = await createUserSession({ userId, siteId: site.id, authMethodKeys: ["password"] });
    return session.id;
  }

  // Straight from the column: the session reader joins the Site's auth configuration, which the test
  // Site does not carry, and a reader that answers "no session" would pass as "revoked".
  async function isRevoked(sessionId: string) {
    const { rows } = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM phis.user_sessions WHERE id = $1`,
      [sessionId],
    );
    if (rows.length === 0) {
      throw new Error(`Session ${sessionId} is gone; the test expected it revoked or spared, not deleted.`);
    }
    return rows[0]!.revoked_at != null;
  }

  it("ends every session of the account when nobody is spared", async () => {
    const first = await openSession();
    const second = await openSession();

    await revokeUserSessions(userId);

    expect(await isRevoked(first)).toBe(true);
    expect(await isRevoked(second)).toBe(true);
  });

  it("spares the session that changed the password and ends the others", async () => {
    const changing = await openSession();
    const stolen = await openSession();

    await revokeUserSessions(userId, { exceptSessionId: changing });

    expect(await isRevoked(changing)).toBe(false);
    expect(await isRevoked(stolen)).toBe(true);
  });

  it("leaves other accounts' sessions alone", async () => {
    const otherUserId = await createPhiTestUser(site);
    const other = await createUserSession({
      userId: otherUserId,
      siteId: site.id,
      authMethodKeys: ["password"],
    });

    await revokeUserSessions(userId);

    expect(await isRevoked(other.id)).toBe(false);
  });
});
