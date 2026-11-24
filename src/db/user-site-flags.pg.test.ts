import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { changeUserSiteFlags } from "./user-site-memberships";
import { USER_SITE_FLAG_DISABLED } from "@/lib/user-site-flags";

/**
 * A flag change touches its own bit and nothing else, whatever another request wrote in between. The
 * statement is the whole guarantee, so it runs against the database that executes it.
 */
describe("membership flags against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("site-flags");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("leaves a bit another request set standing when Disabled moves", async () => {
    const userId = await createPhiTestUser(site);
    const pool = await requirePhiTestDatabase();
    // What another request wrote a moment after this one read the flags. No bit beside Disabled is
    // assigned, so an unassigned one stands in for it: the statement must not care which bit it is.
    const other = 1 << 30;
    await pool.query(
      `UPDATE phis.user_site_memberships SET user_site_flags = user_site_flags | $3
       WHERE user_id = $1 AND site_id = $2`,
      [userId, site.id, other],
    );

    const disabled = await changeUserSiteFlags(userId, site.id, { set: USER_SITE_FLAG_DISABLED });
    expect(disabled!.siteFlags).toBe(other | USER_SITE_FLAG_DISABLED);

    const enabled = await changeUserSiteFlags(userId, site.id, { clear: USER_SITE_FLAG_DISABLED });
    expect(enabled!.siteFlags).toBe(other);
  });
});
