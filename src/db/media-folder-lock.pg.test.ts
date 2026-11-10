import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhiMediaFolderFlags } from "@phis/contracts/media";

import {
  closePhiTestPool,
  createPhiTestGroupSpace,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  createMediaFolder,
  getMediaFolderBySiteAndId,
  hasLockedMediaFolder,
  hasLockedMediaFolderInBranch,
  pruneEmptyMediaFolderBranch,
  updateMediaFolder,
} from "./media";

/**
 * The lock is a flag on the Folder row, and the questions the routes ask about it are asked here of
 * real rows: is one of these Folders locked, is anything in this branch locked, and does the tidy-up
 * after a deleted file leave a locked Folder alone.
 */
describe("locked Media Folders against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let spaceId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("folder-lock");
    other = await createPhiTestSite("folder-lock-other");
    spaceId = await createPhiTestGroupSpace(site, 1_000);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function folder(name: string, parentId: number | null = null, flags = 0) {
    return createMediaFolder({ siteId: site.id, spaceId, parentId, name: `pgtest-${name}-${Math.random()}`, flags });
  }

  function lock(folderId: number) {
    return updateMediaFolder({ siteId: site.id, spaceId, folderId, flags: PhiMediaFolderFlags.Locked });
  }

  it("says whether one of the named Folders is locked, and never for the root", async () => {
    const open = await folder("open");
    const locked = await folder("locked", null, PhiMediaFolderFlags.Locked);
    // Hidden and collapsed are how a Folder is shown, not whether it may change.
    const hidden = await folder("hidden", null, PhiMediaFolderFlags.Hidden | PhiMediaFolderFlags.Collapsed);

    expect(await hasLockedMediaFolder(site.id, spaceId, [open.id, hidden.id, null, undefined])).toBe(false);
    expect(await hasLockedMediaFolder(site.id, spaceId, [open.id, locked.id])).toBe(true);
    expect(await hasLockedMediaFolder(site.id, spaceId, [])).toBe(false);
  });

  it("does not answer for a Folder of another Site or Space", async () => {
    const locked = await folder("locked-here", null, PhiMediaFolderFlags.Locked);

    expect(await hasLockedMediaFolder(other.id, spaceId, [locked.id])).toBe(false);
    expect(await hasLockedMediaFolder(site.id, site.siteSpaceId, [locked.id])).toBe(false);
  });

  it("finds a lock anywhere below a Folder, so a branch cannot be deleted around it", async () => {
    const top = await folder("top");
    const middle = await folder("middle", top.id);
    const bottom = await folder("bottom", middle.id);
    expect(await hasLockedMediaFolderInBranch(site.id, spaceId, top.id)).toBe(false);

    await lock(bottom.id);

    expect(await hasLockedMediaFolderInBranch(site.id, spaceId, top.id)).toBe(true);
    expect(await hasLockedMediaFolderInBranch(site.id, spaceId, middle.id)).toBe(true);
  });

  it("can be unlocked again, which is the one change a locked Folder takes", async () => {
    const locked = await folder("relock", null, PhiMediaFolderFlags.Locked);

    await updateMediaFolder({ siteId: site.id, spaceId, folderId: locked.id, flags: 0 });

    expect(await hasLockedMediaFolder(site.id, spaceId, [locked.id])).toBe(false);
  });

  it("leaves an empty locked Folder, and an empty Folder inside a locked one, when tidying up", async () => {
    const lockedEmpty = await folder("locked-empty", null, PhiMediaFolderFlags.Locked);
    await pruneEmptyMediaFolderBranch(site.id, spaceId, lockedEmpty.id);
    expect(await getMediaFolderBySiteAndId(site.id, spaceId, lockedEmpty.id)).not.toBeNull();

    const lockedParent = await folder("locked-parent", null, PhiMediaFolderFlags.Locked);
    const child = await folder("child", lockedParent.id);
    await pruneEmptyMediaFolderBranch(site.id, spaceId, child.id);
    expect(await getMediaFolderBySiteAndId(site.id, spaceId, child.id)).not.toBeNull();

    // The same tidy-up still removes an empty branch nobody locked.
    const openParent = await folder("open-parent");
    const openChild = await folder("open-child", openParent.id);
    await pruneEmptyMediaFolderBranch(site.id, spaceId, openChild.id);
    expect(await getMediaFolderBySiteAndId(site.id, spaceId, openChild.id)).toBeNull();
    expect(await getMediaFolderBySiteAndId(site.id, spaceId, openParent.id)).toBeNull();
  });
});
