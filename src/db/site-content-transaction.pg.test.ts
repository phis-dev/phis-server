import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  withPhiTestClient,
  type PhiTestSite,
} from "../../test/pg/harness";
import { upsertSiteContentTextWithClient } from "./site-content";

/**
 * A content save writes its text as a site message. Whether that row belongs to the save's transaction
 * -- and goes when the save is rolled back -- is something only the database can show.
 */
describe("a content save's message row against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("content-tx");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function messageExists(text: string) {
    const pool = await requirePhiTestDatabase();
    const { rowCount } = await pool.query(
      `SELECT 1 FROM phis.tr_site_msg WHERE site_id = $1 AND msg = $2`,
      [site.id, text],
    );
    return (rowCount ?? 0) > 0;
  }

  it("takes the message with it when the save is rolled back", async () => {
    const text = `pgtest rolled back ${Math.random()}`;
    await withPhiTestClient(async (client) => {
      await client.query("BEGIN");
      await upsertSiteContentTextWithClient(client, {
        siteId: site.id, slug: `pgtest-${Math.random()}`, text,
      });
      await client.query("ROLLBACK");
    });
    expect(await messageExists(text)).toBe(false);
  });

  it("keeps it when the save commits", async () => {
    const text = `pgtest committed ${Math.random()}`;
    await withPhiTestClient(async (client) => {
      await client.query("BEGIN");
      await upsertSiteContentTextWithClient(client, {
        siteId: site.id, slug: `pgtest-${Math.random()}`, text,
      });
      await client.query("COMMIT");
    });
    expect(await messageExists(text)).toBe(true);
  });
});
