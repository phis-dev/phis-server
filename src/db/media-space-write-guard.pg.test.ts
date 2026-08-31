import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  addPhiTestGroupMember,
  createPhiTestGroup,
  createPhiTestGroupSpace,
  createPhiTestSite,
  createPhiTestSpaceForGroup,
  createPhiTestUser,
  createPhiTestUserSpace,
  dropPhiTestSites,
  requirePhiTestDatabase,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiMediaSpaceKind, resolveAuthorizedMediaSpace } from "./media-spaces";

/**
 * What a Media write is authorized against.
 *
 * The write guard asks `resolveAuthorizedMediaSpace` for the actor's own Space and compares ids, so
 * the three answers that matter are decided here rather than in the route: an unavailable kind is
 * refused before ownership is considered, an actor's own Space resolves to exactly one row, and a
 * Space that belongs to someone else never does.
 */
describe("Media Space write authority against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("write-guard");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function enableUserSpaces(enabled: boolean) {
    const pool = await requirePhiTestDatabase();
    await setPhiTestMediaConfig(site, {});
    await pool.query(
      `UPDATE phis.site_media_config SET flags = $2 WHERE site_id = $1`,
      [site.id, enabled ? 1 : 0],
    );
  }

  it("refuses the actor's own Space while no Module declares User Spaces", async () => {
    const userId = await createPhiTestUser(site);
    await enableUserSpaces(false);

    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id, userId, requestedSpaceId: "user", intent: "write",
    });

    expect(resolution).toMatchObject({ ok: false, reason: "space_kind_unavailable" });
  });

  it("materializes the actor's own Space once a Module has declared the kind", async () => {
    const userId = await createPhiTestUser(site);
    await enableUserSpaces(true);

    const first = await resolveAuthorizedMediaSpace({
      siteId: site.id, userId, requestedSpaceId: "user", intent: "write",
    });
    const again = await resolveAuthorizedMediaSpace({
      siteId: site.id, userId, requestedSpaceId: "user", intent: "write",
    });

    expect(first.ok && again.ok).toBe(true);
    expect(first.ok && first.space.kind).toBe(PhiMediaSpaceKind.User);
    // The same Space both times: a second write must not mint a second one.
    expect(first.ok && again.ok && first.space.id).toBe(again.ok ? again.space.id : -1);
  });

  it("never resolves another person's Space as the actor's own", async () => {
    await enableUserSpaces(true);
    const actorId = await createPhiTestUser(site);
    const strangerSpaceId = await createPhiTestUserSpace(site, 1_000);

    const own = await resolveAuthorizedMediaSpace({
      siteId: site.id, userId: actorId, requestedSpaceId: "user", intent: "write",
    });

    expect(own.ok).toBe(true);
    expect(own.ok && own.space.id).not.toBe(strangerSpaceId);
  });

  it("answers a group's Space to an Author who administers no Media", async () => {
    await enableUserSpaces(true);
    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE phis.site_media_config SET flags = 3 WHERE site_id = $1`, [site.id]);
    const actorId = await createPhiTestUser(site);
    const groupId = await createPhiTestGroup(site, "pgtest-contributor");
    const groupSpaceId = await createPhiTestSpaceForGroup(site, groupId);
    // Membership flag 2 is Author; nothing here grants Site Media authority.
    await addPhiTestGroupMember({ site, groupId, userId: actorId, membershipFlags: 3 });

    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id,
      userId: actorId,
      requestedSpaceId: { kind: "group", groupId },
      intent: "write",
    });

    expect(resolution.ok).toBe(true);
    expect(resolution.ok && resolution.space.id).toBe(groupSpaceId);
  });

  it("does not answer a group's Space to someone who is not in it", async () => {
    await enableUserSpaces(true);
    const actorId = await createPhiTestUser(site);
    const pool = await requirePhiTestDatabase();
    const groupSpaceId = await createPhiTestGroupSpace(site, 1_000);
    const { rows } = await pool.query<{ group_id: number }>(
      `SELECT group_id FROM phis.media_spaces WHERE id = $1`,
      [groupSpaceId],
    );

    const resolution = await resolveAuthorizedMediaSpace({
      siteId: site.id,
      userId: actorId,
      requestedSpaceId: { kind: "group", groupId: rows[0]!.group_id },
      intent: "write",
    });

    expect(resolution.ok).toBe(false);
  });
});
