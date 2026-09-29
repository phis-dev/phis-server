import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createPhiDraftCmsInstanceId } from "@/lib/cms/instance-id";
import { saveSiteNavigationDraftRevision } from "./site-navigation";

/**
 * A custom Navigation item's id names the Draft revision it was made in. The save checked that revision
 * for every item on every save, so deleting it from the history made the Navigation unsaveable.
 */
describe("Navigation custom item identities against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("nav-draft-ids");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function overlay(key: string, itemIds: string[]) {
    return {
      navKey: key,
      itemOverrides: [],
      customItems: itemIds.map((id, index) => ({
        id, kind: "separator" as const, label: "", placement: { parentId: null, index },
      })),
      tombstones: [],
    };
  }

  it("keeps saving an item whose Draft revision was deleted, and refuses a new one from elsewhere", async () => {
    const key = "public:pgtest-ids";
    const first = await saveSiteNavigationDraftRevision(site.id, {
      key, overlay: overlay(key, []), nextNodeSequence: 1,
    });
    const itemId = createPhiDraftCmsInstanceId({
      domain: "navigation", draftRevisionId: first.revisionId, sequence: 1,
    });
    await saveSiteNavigationDraftRevision(site.id, {
      key, overlay: overlay(key, [itemId]), nextNodeSequence: 2,
    });
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.site_nav_revisions WHERE id = $1`, [first.revisionId]);

    await expect(saveSiteNavigationDraftRevision(site.id, {
      key, overlay: overlay(key, [itemId]), nextNodeSequence: 2,
    })).resolves.toMatchObject({ overlay: { customItems: [{ id: itemId }] } });

    const otherKey = "public:pgtest-ids-other";
    const other = await saveSiteNavigationDraftRevision(site.id, {
      key: otherKey, overlay: overlay(otherKey, []), nextNodeSequence: 1,
    });
    const foreignId = createPhiDraftCmsInstanceId({
      domain: "navigation", draftRevisionId: other.revisionId, sequence: 1,
    });
    await expect(saveSiteNavigationDraftRevision(site.id, {
      key, overlay: overlay(key, [itemId, foreignId]), nextNodeSequence: 2,
    })).rejects.toThrow(/outside its scope/u);
  });
});
