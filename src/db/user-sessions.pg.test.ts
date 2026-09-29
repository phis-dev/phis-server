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
import { upsertUserSiteMembership } from "./user-site-memberships";
import { PhiBaseRole } from "@/lib/constants/phi-base-roles";

// One pool for the file: the harness does not reopen one it has closed.
afterAll(async () => {
  await closePhiTestPool();
});

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

/**
 * A factor policy may be scoped to roles, and a role granted after sign-in changes whom it reaches
 * without moving the Site policy revision. The grant is what has to make the sessions look again.
 */
describe("a Core role change against the sessions it concerns", () => {
  let pool: Pool;
  let site: PhiTestSite;

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("roles-stale");
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  async function revisionOf(sessionId: string) {
    const { rows } = await pool.query<{ auth_policy_revision: number }>(
      `SELECT auth_policy_revision FROM phis.user_sessions WHERE id = $1`,
      [sessionId],
    );
    return rows[0]!.auth_policy_revision;
  }

  it("sets the live sessions of that membership to be reevaluated, and nobody else's", async () => {
    const userId = await createPhiTestUser(site);
    const otherUserId = await createPhiTestUser(site);
    const session = await createUserSession({ userId, siteId: site.id, authMethodKeys: ["password"] });
    const other = await createUserSession({
      userId: otherUserId, siteId: site.id, authMethodKeys: ["password"],
    });

    await upsertUserSiteMembership({ userId, siteId: site.id, coreRoleFlags: PhiBaseRole.Author });

    expect(await revisionOf(session.id)).toBe(0);
    expect(await revisionOf(other.id)).toBe(1);
  });

  it("leaves the sessions alone when the roles stay what they were", async () => {
    const userId = await createPhiTestUser(site);
    await upsertUserSiteMembership({ userId, siteId: site.id, coreRoleFlags: PhiBaseRole.Author });
    const session = await createUserSession({ userId, siteId: site.id, authMethodKeys: ["password"] });

    await upsertUserSiteMembership({ userId, siteId: site.id, coreRoleFlags: PhiBaseRole.Author });

    expect(await revisionOf(session.id)).toBe(1);
  });
});
