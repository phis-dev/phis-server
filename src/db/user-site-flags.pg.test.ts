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
import { USER_SITE_FLAG_DISABLED, USER_SITE_FLAG_NEWSLETTER_OPT_IN } from "@/lib/user-site-flags";

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

  it("leaves a Disabled another request set standing when the newsletter bit moves", async () => {
    const userId = await createPhiTestUser(site);
    const pool = await requirePhiTestDatabase();
    // What an administrator did a moment after the visitor's page read the flags.
    await pool.query(
      `UPDATE phis.user_site_memberships SET user_site_flags = user_site_flags | $3
       WHERE user_id = $1 AND site_id = $2`,
      [userId, site.id, USER_SITE_FLAG_DISABLED],
    );

    const opted = await changeUserSiteFlags(userId, site.id, { set: USER_SITE_FLAG_NEWSLETTER_OPT_IN });
    expect(opted!.siteFlags & USER_SITE_FLAG_DISABLED).toBe(USER_SITE_FLAG_DISABLED);
    expect(opted!.siteFlags & USER_SITE_FLAG_NEWSLETTER_OPT_IN).toBe(USER_SITE_FLAG_NEWSLETTER_OPT_IN);

    const cleared = await changeUserSiteFlags(userId, site.id, {
      clear: USER_SITE_FLAG_NEWSLETTER_OPT_IN,
    });
    expect(cleared!.siteFlags).toBe(USER_SITE_FLAG_DISABLED);
  });
});
