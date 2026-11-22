import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestGroupSpace,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@phis/contracts/media";
import { countMediaAssetsBySiteWithFilters, createMediaAsset, listMediaAssetsBySiteWithFilters } from "./media";

/**
 * The Media list asked for several Assets by id (`GET /api/site/media?id=1&id=2`): the ones named, in one
 * query, and never one outside the Space the listing is for or another Site's.
 */
describe("the Media list by ids against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let groupSpaceId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("media-list-ids");
    other = await createPhiTestSite("media-list-ids-other");
    groupSpaceId = await createPhiTestGroupSpace(site, 1_000);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function asset(owner: PhiTestSite, spaceId: number, name: string) {
    const created = await createMediaAsset({
      siteId: owner.id,
      spaceId,
      storageProfileId: owner.storageProfileId,
      storageKey: `pgtest/${name}-${Math.random()}`,
      originalName: name,
      contentType: "image/png",
      lifecycleStatus: PhiMediaLifecycleStatus.Ready,
      deliveryPolicy: PhiMediaDeliveryPolicy.Public,
    });
    return created!.id;
  }

  it("answers exactly the named Assets of the Space, and one id as before", async () => {
    const first = await asset(site, site.siteSpaceId, "first.png");
    const second = await asset(site, site.siteSpaceId, "second.png");
    await asset(site, site.siteSpaceId, "unnamed.png");
    const inGroup = await asset(site, groupSpaceId, "group.png");
    const elsewhere = await asset(other, other.siteSpaceId, "elsewhere.png");

    const filters = { spaceId: site.siteSpaceId, ids: [first, second, inGroup, elsewhere], sort: "created_at_desc" as const };
    const listed = await listMediaAssetsBySiteWithFilters(site.id, { ...filters, limit: 50, offset: 0 });
    expect(listed.map((row) => row.id).sort((a, b) => a - b)).toEqual([first, second]);
    expect(await countMediaAssetsBySiteWithFilters(site.id, filters)).toBe(2);

    const one = await listMediaAssetsBySiteWithFilters(site.id, { spaceId: site.siteSpaceId, ids: [second], limit: 50 });
    expect(one.map((row) => row.id)).toEqual([second]);

    // No ids is no restriction: the Space's whole listing.
    expect(await countMediaAssetsBySiteWithFilters(site.id, { spaceId: site.siteSpaceId, ids: [] })).toBe(3);
  });
});
