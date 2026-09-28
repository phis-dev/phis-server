import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestGroupSpace,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createMediaFolder, listMediaFolderDescendantIds, updateMediaFolder } from "./media";

/**
 * A Folder may move anywhere but below itself. Whether it is below itself is a walk over rows, and
 * whether two moves racing each other can together close a loop is a question of locks -- both
 * PostgreSQL's to answer.
 */
describe("moving Media Folders against PostgreSQL", () => {
  let site: PhiTestSite;
  let spaceId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("folder-moves");
    spaceId = await createPhiTestGroupSpace(site, 1_000);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function folder(name: string, parentId: number | null = null) {
    const unique = `pgtest-${name}-${Math.random()}`;
    return createMediaFolder({ siteId: site.id, spaceId, parentId, name: unique });
  }

  function move(folderId: number, parentId: number | null) {
    return updateMediaFolder({ siteId: site.id, spaceId, folderId, parentId });
  }

  async function chain() {
    const top = await folder("top");
    const middle = await folder("middle", top.id);
    const bottom = await folder("bottom", middle.id);
    return { top, middle, bottom };
  }

  it("refuses to move a Folder below its child or grandchild", async () => {
    const { top, middle, bottom } = await chain();

    await expect(move(top.id, middle.id)).rejects.toThrow(/below one of its own Folders/);
    await expect(move(top.id, bottom.id)).rejects.toThrow(/below one of its own Folders/);
    await expect(move(top.id, top.id)).rejects.toThrow(/its own parent/);
    // Nothing moved: the branch still hangs from the top.
    expect(new Set(await listMediaFolderDescendantIds(site.id, spaceId, top.id)))
      .toEqual(new Set([top.id, middle.id, bottom.id]));
  });

  it("still moves a Folder sideways and back to the root", async () => {
    const first = await chain();
    const second = await chain();

    expect((await move(first.bottom.id, second.middle.id))?.parentId).toBe(second.middle.id);
    expect((await move(first.middle.id, null))?.parentId).toBeNull();
  });

  it("lets only one of two crossing moves through, so no loop closes", async () => {
    const left = await folder("left");
    const right = await folder("right");

    const outcomes = await Promise.allSettled([move(left.id, right.id), move(right.id, left.id)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("ends the walk over a loop an earlier version left behind", async () => {
    const pool = await requirePhiTestDatabase();
    const a = await folder("loop");
    const b = await folder("b", a.id);
    await pool.query(`UPDATE phis.media_folders SET parent_id = $1 WHERE id = $2`, [b.id, a.id]);

    const branch = await listMediaFolderDescendantIds(site.id, spaceId, a.id);
    expect(new Set(branch)).toEqual(new Set([a.id, b.id]));
  });
});
