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
import {
  createMediaAsset,
  createMediaFolder,
  listMediaFolderDescendantIds,
  listPublicSiteSpaceMediaImagesInFolders,
} from "./media";

/**
 * What a public page gets out of a Folder: the pictures it may show, in the order it asked for, and
 * nothing a Folder holds that is not a public picture -- a document, a draft, a Group's own.
 */
describe("public pictures of a Media Folder against PostgreSQL", () => {
  let site: PhiTestSite;
  let groupSpaceId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("folder-images");
    groupSpaceId = await createPhiTestGroupSpace(site, 1_000);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function asset(input: {
    spaceId: number;
    folderId: number | null;
    name: string;
    contentType?: string;
    lifecycleStatus?: number;
    deliveryPolicy?: number;
  }) {
    return createMediaAsset({
      siteId: site.id,
      spaceId: input.spaceId,
      folderId: input.folderId,
      storageProfileId: site.storageProfileId,
      storageKey: `pgtest/${input.name}-${Math.random()}`,
      originalName: input.name,
      contentType: input.contentType ?? "image/jpeg",
      lifecycleStatus: input.lifecycleStatus ?? PhiMediaLifecycleStatus.Ready,
      deliveryPolicy: input.deliveryPolicy ?? PhiMediaDeliveryPolicy.Public,
    });
  }

  it("lists the public pictures of a branch, by name, and leaves the rest where it is", async () => {
    const top = await createMediaFolder({ siteId: site.id, spaceId: site.siteSpaceId, name: `pgtest-top-${Math.random()}` });
    const child = await createMediaFolder({ siteId: site.id, spaceId: site.siteSpaceId, parentId: top.id, name: "child" });
    const other = await createMediaFolder({ siteId: site.id, spaceId: site.siteSpaceId, name: `pgtest-other-${Math.random()}` });

    await asset({ spaceId: site.siteSpaceId, folderId: top.id, name: "b.jpg" });
    await asset({ spaceId: site.siteSpaceId, folderId: child.id, name: "a.jpg" });
    await asset({ spaceId: site.siteSpaceId, folderId: top.id, name: "C.png" });
    // Not pictures, not ready, not public, not this branch: none of them is in a slideshow.
    await asset({ spaceId: site.siteSpaceId, folderId: top.id, name: "notes.pdf", contentType: "application/pdf" });
    await asset({ spaceId: site.siteSpaceId, folderId: top.id, name: "draft.jpg", lifecycleStatus: PhiMediaLifecycleStatus.Pending });
    await asset({ spaceId: site.siteSpaceId, folderId: top.id, name: "private.jpg", deliveryPolicy: PhiMediaDeliveryPolicy.Group });
    await asset({ spaceId: site.siteSpaceId, folderId: other.id, name: "elsewhere.jpg" });

    const branch = await listMediaFolderDescendantIds(site.id, site.siteSpaceId, top.id);
    const byName = await listPublicSiteSpaceMediaImagesInFolders(site.id, { folderIds: branch, sort: "name_asc", limit: 50 });
    expect(byName.map((row) => row.originalName)).toEqual(["a.jpg", "b.jpg", "C.png"]);

    const topOnly = await listPublicSiteSpaceMediaImagesInFolders(site.id, { folderIds: [top.id], sort: "name_asc", limit: 50 });
    expect(topOnly.map((row) => row.originalName)).toEqual(["b.jpg", "C.png"]);

    const newest = await listPublicSiteSpaceMediaImagesInFolders(site.id, { folderIds: branch, sort: "created_at_desc", limit: 2 });
    expect(newest.map((row) => row.originalName)).toEqual(["C.png", "a.jpg"]);
  });

  it("answers nothing for a Group's Folder, whatever it holds", async () => {
    const folder = await createMediaFolder({ siteId: site.id, spaceId: groupSpaceId, name: `pgtest-group-${Math.random()}` });
    await asset({ spaceId: groupSpaceId, folderId: folder.id, name: "team.jpg" });
    // The Site Space does not know this Folder, so the branch walk finds nothing to begin with.
    expect(await listMediaFolderDescendantIds(site.id, site.siteSpaceId, folder.id)).toEqual([]);
    // And a caller that hands the id over anyway is refused by the Space condition.
    expect(await listPublicSiteSpaceMediaImagesInFolders(site.id, { folderIds: [folder.id], sort: "name_asc", limit: 50 })).toEqual([]);
  });
});
