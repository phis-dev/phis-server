import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { searchSiteMembers } from "./user-admin";

/**
 * The Site's members for a picker that names a person by user id (`GET /api/site/members`): found by name
 * or address, a page at a time, answered by id and name -- never by the address searched for.
 */
describe("searching the Site's members", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let ada: number;
  let alan: number;
  let nameless: number;
  let stranger: number;

  async function profile(userId: number, first: string, last: string, displayName: string | null = null) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.user_profiles (user_id, first_name, last_name, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, first, last, displayName],
    );
  }

  async function addressOf(userId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ email_normalized: string }>(
      `SELECT email_normalized FROM phis.user_emails WHERE user_id = $1`,
      [userId],
    );
    return rows[0]!.email_normalized;
  }

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("site-members");
    other = await createPhiTestSite("site-members-other");
    ada = await createPhiTestUser(site);
    await profile(ada, "Ada", "Lovelace");
    alan = await createPhiTestUser(site);
    await profile(alan, "Alan", "Turing", "Prof. 100% Turing");
    nameless = await createPhiTestUser(site);
    stranger = await createPhiTestUser(other);
    await profile(stranger, "Ada", "Elsewhere");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  const search = (query: string, page = 1, pageSize = 20) =>
    searchSiteMembers({ siteId: site.id, query, page, pageSize });

  it("answers every member of this Site, ordered by name, and nobody of another", async () => {
    expect(await search("")).toEqual([
      // No name sorts first, shown by id: an address never stands in for a name.
      { userId: nameless, displayName: `#${nameless}` },
      { userId: ada, displayName: "Ada Lovelace" },
      { userId: alan, displayName: "Prof. 100% Turing" },
    ]);
  });

  it("finds a member by a part of the name, and by an address without showing it", async () => {
    expect(await search("lovel")).toEqual([{ userId: ada, displayName: "Ada Lovelace" }]);
    expect(await search("ADA")).toEqual([{ userId: ada, displayName: "Ada Lovelace" }]);
    expect(await search(await addressOf(nameless))).toEqual([{ userId: nameless, displayName: `#${nameless}` }]);
  });

  it("takes % and _ as the characters they are", async () => {
    expect(await search("100%")).toEqual([{ userId: alan, displayName: "Prof. 100% Turing" }]);
    expect(await search("_")).toEqual([]);
  });

  it("answers one page at a time", async () => {
    expect((await search("", 1, 2)).map((row) => row.userId)).toEqual([nameless, ada]);
    expect((await search("", 2, 2)).map((row) => row.userId)).toEqual([alan]);
    expect(await search("", 3, 2)).toEqual([]);
  });
});
