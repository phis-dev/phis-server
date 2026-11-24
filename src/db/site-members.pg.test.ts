import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { phisPhoneQueryDigits, searchSiteMembers } from "./user-admin";

/**
 * The Site's members for a picker that names a person by user id (`GET /api/site/members`): found by name,
 * address or telephone number, a page at a time, answered by id and name -- never by what was searched for.
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

  it("finds a member by the digits of a telephone number however it is written, and only by a number", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE phis.user_profiles SET phone = '+41 (0)44 123 45 67' WHERE user_id = $1`, [ada]);
    await pool.query(`UPDATE phis.user_profiles SET mobile = '079/555.01.02' WHERE user_id = $1`, [alan]);
    await pool.query(`UPDATE phis.user_profiles SET phone = '079 555 01 02' WHERE user_id = $1`, [stranger]);
    expect(await search("044 123 45")).toEqual([{ userId: ada, displayName: "Ada Lovelace" }]);
    expect(await search("+41 79 555 01 02")).toEqual([]);
    expect(await search("079 555-01-02")).toEqual([{ userId: alan, displayName: "Prof. 100% Turing" }]);
    expect(await search("0041795550102")).toEqual([]);
    expect(await search("5550102")).toEqual([{ userId: alan, displayName: "Prof. 100% Turing" }]);
    // Digits beside letters are a name, and fewer than three digits are no number.
    expect(await search("Ada 044")).toEqual([]);
    expect(phisPhoneQueryDigits("Ada 044")).toBeNull();
    expect(phisPhoneQueryDigits("44")).toBeNull();
    expect(phisPhoneQueryDigits("007")).toBeNull();
    expect(phisPhoneQueryDigits("+41 (0)44")).toBe("41044");
  });

  it("answers one page at a time", async () => {
    expect((await search("", 1, 2)).map((row) => row.userId)).toEqual([nameless, ada]);
    expect((await search("", 2, 2)).map((row) => row.userId)).toEqual([alan]);
    expect(await search("", 3, 2)).toEqual([]);
  });
});
