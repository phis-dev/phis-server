import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiCmsStatus } from "@phis/contracts/cms";
import { validateCmsPageWriteInput } from "@/lib/cms/write-validation";
import {
  deleteSitePageDraftRevision,
  getResolvedSitePageTree,
  listSitePublishedPageAddresses,
  publishSitePageRevision,
  saveSitePageDraftRevision,
} from "./site-pages";

/**
 * When a Site Page stops being a Site Page.
 *
 * Deletion is a draft like any other change, and the tombstone on the Scope is the published side of it:
 * published listings, Navigation targets, the sitemap and Module usage read that column, and it moves the
 * Site read marker, so every Site process empties its caches when it changes. The draft save used to write
 * it -- which took the Page off the live Site the moment somebody marked it for deletion, republished
 * every Site process for a change nobody had approved, and left the mark behind when the draft was
 * discarded.
 */
function pageInput(path: string, status: number) {
  const validated = validateCmsPageWriteInput({
    area: "public",
    path,
    sourcePreset: null,
    page: {
      status,
      flags: 0,
      visibilityMask: 1,
      heroRootLayoutNodeId: null,
      headerBottomRootLayoutNodeId: null,
      siderRightRootLayoutNodeId: null,
      contentRootLayoutNodeId: null,
      footerTopRootLayoutNodeId: null,
      drawerRightRootLayoutNodeId: null,
      layoutConfig: { pageRegionConfigs: {} },
    },
    overlays: [],
    layoutNodes: [],
    contentWidgets: [],
    controllerSettings: [],
  });
  if (!validated.ok) throw new Error(`Invalid test page input: ${validated.error}`);
  return validated.value;
}

describe("the Site Page tombstone against PostgreSQL", () => {
  let site: PhiTestSite;

  async function scopeIdOf(path: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM phis.site_page_scopes WHERE site_id = $1 AND area_id = 1 AND path = $2`,
      [site.id, path],
    );
    return rows[0]!.id;
  }

  async function tombstoneOf(scopeId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ tombstoned_at: Date | null; published_revision_id: number | null }>(
      `SELECT tombstoned_at, published_revision_id FROM phis.site_page_scopes WHERE id = $1`,
      [scopeId],
    );
    return rows[0]!;
  }

  async function readMarker() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ marker: string }>(
      `SELECT marker::text AS marker FROM phis.site_read_marker WHERE site_id = $1`,
      [site.id],
    );
    return rows[0]?.marker ?? null;
  }

  /** A published Site Page, which is what a deletion needs to have something to take away. */
  async function publishedPage(path: string) {
    const created = await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Published), {
      createOnly: true,
    });
    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: created.revisionId,
    });
    return scopeIdOf(path);
  }

  async function listsPath(path: string) {
    const addresses = await listSitePublishedPageAddresses(site.id, 1);
    return addresses.some((address) => address.path === path);
  }

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("page-tombstone");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("leaves the published Page standing while the deletion is only a draft", async () => {
    const path = "/pgtest-tombstone-draft";
    const scopeId = await publishedPage(path);
    const marker = await readMarker();

    await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Deleted));

    expect((await tombstoneOf(scopeId)).tombstoned_at).toBeNull();
    expect(await getResolvedSitePageTree(site.id, 1, { kind: "path", path })).not.toBeNull();
    expect(await listsPath(path)).toBe(true);
    // Nothing a Site reads changed, so no Site process has a reason to empty its caches.
    expect(await readMarker()).toBe(marker);
  });

  it("tombstones the Page when the deletion is published, and moves the read marker doing it", async () => {
    const path = "/pgtest-tombstone-publish";
    const scopeId = await publishedPage(path);
    const draft = await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Deleted));
    const marker = await readMarker();

    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: draft.revisionId,
    });

    expect((await tombstoneOf(scopeId)).tombstoned_at).toBeInstanceOf(Date);
    expect(await getResolvedSitePageTree(site.id, 1, { kind: "path", path })).toBeNull();
    expect(await listsPath(path)).toBe(false);
    expect(await readMarker()).not.toBe(marker);
  });

  it("leaves the published Page untouched when the deletion draft is discarded", async () => {
    const path = "/pgtest-tombstone-discard";
    const scopeId = await publishedPage(path);
    const published = (await tombstoneOf(scopeId)).published_revision_id;
    await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Deleted));

    const discarded = await deleteSitePageDraftRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
    });

    expect(discarded.deleted).toBe(true);
    expect(await tombstoneOf(scopeId)).toMatchObject({
      tombstoned_at: null,
      published_revision_id: published,
    });
    expect(await getResolvedSitePageTree(site.id, 1, { kind: "path", path })).not.toBeNull();
    expect(await listsPath(path)).toBe(true);
  });

  it("keeps the Page deleted while a draft that would restore it is unpublished, and restores it on publish", async () => {
    const path = "/pgtest-tombstone-restore";
    const scopeId = await publishedPage(path);
    const deletion = await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Deleted));
    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: deletion.revisionId,
    });
    const deletedAt = (await tombstoneOf(scopeId)).tombstoned_at;

    const restore = await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Published));

    // The Page is still deleted as far as the Site is concerned: nobody has published the restore.
    expect((await tombstoneOf(scopeId)).tombstoned_at).toEqual(deletedAt);
    expect(await getResolvedSitePageTree(site.id, 1, { kind: "path", path })).toBeNull();

    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: restore.revisionId,
    });

    expect((await tombstoneOf(scopeId)).tombstoned_at).toBeNull();
    expect(await getResolvedSitePageTree(site.id, 1, { kind: "path", path })).not.toBeNull();
    expect(await listsPath(path)).toBe(true);
  });

  it("keeps the time the deletion was published when the same deletion is published again", async () => {
    const path = "/pgtest-tombstone-republish";
    const scopeId = await publishedPage(path);
    const deletion = await saveSitePageDraftRevision(site.id, pageInput(path, PhiCmsStatus.Deleted));
    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: deletion.revisionId,
    });
    const deletedAt = (await tombstoneOf(scopeId)).tombstoned_at;

    await publishSitePageRevision(site.id, {
      areaMask: 1,
      address: { kind: "path", path },
      revisionId: deletion.revisionId,
    });

    expect((await tombstoneOf(scopeId)).tombstoned_at).toEqual(deletedAt);
  });
});
