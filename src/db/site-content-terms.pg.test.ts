import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@phis/contracts/access";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@phis/contracts/media";
import {
  curateSiteContentEntry,
  listPublishedSiteContentEntries,
  listRelatedSiteContentEntries,
  listSiteContentEntriesForEditor,
  listSiteContentEntryAuthorCandidates,
  publishSiteContentEntry,
  readPublishedSiteContentEntry,
  saveSiteContentEntryDraft,
  SITE_CONTENT_ENTRY_KINDS,
} from "./site-content-entries";
import {
  createSiteContentCategory,
  deleteSiteContentCategory,
  listSiteContentCategories,
  listSiteContentTagsInUse,
  slugifySiteContentTerm,
  updateSiteContentCategory,
} from "./site-content-terms";

const BLOG = SITE_CONTENT_ENTRY_KINDS.blog.type;
const NEWS = SITE_CONTENT_ENTRY_KINDS.news.type;

/**
 * Terms and bylines against PostgreSQL (CONTENT.md, Terms and Curation): what the foreign keys and the
 * one-category index hold, which entries count as close, and that a reader is only ever given a name and
 * a picture that is already public.
 */
describe("content entry terms and authors, against PostgreSQL", () => {
  let site: PhiTestSite;
  let otherSite: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("terms");
    otherSite = await createPhiTestSite("terms-other");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function grantRoles(userId: number, roleFlags: number, onSite = site) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags) VALUES ($1, $2, $3, $4)`,
      [onSite.id, userId, PHI_CORE_ROLE_PROVIDER_ID, roleFlags],
    );
  }

  async function nameUser(userId: number, names: { first: string; last: string; display?: string | null }) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.user_profiles (user_id, first_name, last_name, display_name) VALUES ($1, $2, $3, $4)`,
      [userId, names.first, names.last, names.display ?? null],
    );
  }

  async function writer(names?: { first: string; last: string; display?: string | null }) {
    const userId = await createPhiTestUser(site);
    await grantRoles(userId, PhiBaseRole.Author);
    if (names) await nameUser(userId, names);
    return userId;
  }

  async function publishedPost(slug: string, input: { tags?: string[]; createdByUserId?: number | null } = {}) {
    const saved = await saveSiteContentEntryDraft({
      kind: "blog",
      siteId: site.id,
      slug,
      title: `Title ${slug}`,
      content: `Body ${slug}`,
      tags: input.tags,
      createdByUserId: input.createdByUserId ?? null,
    });
    if (!saved.ok) throw new Error(`the draft ${slug} did not save`);
    const published = await publishSiteContentEntry({
      kind: "blog", siteId: site.id, contentId: saved.contentId, versionId: saved.versionId,
      publishedAt: null, expiresAt: null,
    });
    if (typeof published === "string") throw new Error(`${slug} did not publish`);
    return saved.contentId;
  }

  it("makes one address of every spelling a reader would type", () => {
    expect(slugifySiteContentTerm("Reisen & Essen")).toBe("reisen-essen");
    expect(slugifySiteContentTerm("Café")).toBe("cafe");
    expect(slugifySiteContentTerm("Größe")).toBe("grosse");
    expect(slugifySiteContentTerm("日本")).toBe("日本");
    expect(slugifySiteContentTerm(" -- ")).toBe("");
  });

  it("keeps an entry's tags as terms, offered while somebody carries them", async () => {
    const contentId = await publishedPost("tagged", { tags: ["travel", "food"] });
    const entry = await readPublishedSiteContentEntry("blog", site.id, "en", "tagged");
    expect(entry?.tags).toEqual([{ slug: "travel", label: "travel" }, { slug: "food", label: "food" }]);
    expect(await listSiteContentTagsInUse(site.id, BLOG)).toEqual(expect.arrayContaining(["food", "travel"]));

    const saved = await saveSiteContentEntryDraft({
      kind: "blog", siteId: site.id, contentId, title: "Title tagged", content: "Body tagged", tags: ["food"],
      baseVersionId: (await listSiteContentEntriesForEditor({
        kind: "blog", siteId: site.id, locale: "en", page: 1, pageSize: 100,
      })).rows.find((row) => row.contentId === contentId)?.versionId ?? null,
    });
    expect(saved.ok).toBe(true);
    // The tag nobody carries any more has left the offer by itself.
    expect(await listSiteContentTagsInUse(site.id, BLOG)).not.toContain("travel");
    // The kind keeps its own terms: News has none of the Blog's.
    expect(await listSiteContentTagsInUse(site.id, NEWS)).not.toContain("food");
  });

  it("names the writer of a new entry as its author, by the name they chose and never an address", async () => {
    const userId = await writer({ first: "Ada", last: "Lovelace", display: "Countess Ada" });
    await publishedPost("by-ada", { createdByUserId: userId });
    const entry = await readPublishedSiteContentEntry("blog", site.id, "en", "by-ada");
    expect(entry?.author).toEqual({ name: "Countess Ada", avatar: null });

    const nameless = await writer();
    await publishedPost("by-nobody-named", { createdByUserId: nameless });
    // No name to show is no byline -- the address the account has is never the answer.
    expect((await readPublishedSiteContentEntry("blog", site.id, "en", "by-nobody-named"))?.author).toBeNull();
    const editorRow = (await listSiteContentEntriesForEditor({
      kind: "blog", siteId: site.id, locale: "en", page: 1, pageSize: 100,
    })).rows.find((row) => row.slug === "by-nobody-named");
    // Administration names them by the address, which a reader never sees.
    expect(editorRow?.authorUserId).toBe(nameless);
    expect(editorRow?.author).toMatch(/@example\.invalid$/u);
  });

  it("shows an author's picture only while the Asset is a Public, ready image", async () => {
    const userId = await writer({ first: "Grace", last: "Hopper" });
    const assetId = await createPhiTestAsset(site, `avatar-${userId}`);
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.media_assets SET lifecycle_status = $2, delivery_policy = $3 WHERE id = $1`,
      [assetId, PhiMediaLifecycleStatus.Ready, PhiMediaDeliveryPolicy.Public],
    );
    await pool.query(
      `INSERT INTO phis.user_site_avatars (user_id, site_id, asset_id) VALUES ($1, $2, $3)`,
      [userId, site.id, assetId],
    );
    await publishedPost("by-grace", { createdByUserId: userId });
    expect((await readPublishedSiteContentEntry("blog", site.id, "en", "by-grace"))?.author?.avatar)
      .toMatchObject({ assetId, contentType: "image/png" });

    await pool.query(`UPDATE phis.media_assets SET delivery_policy = $2 WHERE id = $1`, [assetId, PhiMediaDeliveryPolicy.User]);
    expect((await readPublishedSiteContentEntry("blog", site.id, "en", "by-grace"))?.author)
      .toEqual({ name: "Grace Hopper", avatar: null });
  });

  it("clears the byline and keeps the entry when its author leaves the Site", async () => {
    const userId = await writer({ first: "Leaving", last: "Soon" });
    const contentId = await publishedPost("by-leaver", { createdByUserId: userId });
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`, [userId, site.id]);
    const { rows } = await pool.query<{ author_user_id: number | null }>(
      `SELECT author_user_id FROM phis.site_content WHERE id = $1`,
      [contentId],
    );
    expect(rows[0]?.author_user_id).toBeNull();
  });

  it("names as author only somebody who may write entries here", async () => {
    const contentId = await publishedPost("curated");
    const member = await createPhiTestUser(site);
    expect(await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId, authorUserId: member }))
      .toBe("author_not_eligible");

    const author = await writer({ first: "Named", last: "Later" });
    expect(await listSiteContentEntryAuthorCandidates(site.id)).toEqual(
      expect.arrayContaining([{ userId: author, name: "Named Later" }]),
    );
    expect(await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId, authorUserId: author }))
      .toEqual({ contentId, authorUserId: author, categoryId: null });
    expect(await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId, authorUserId: null }))
      .toEqual({ contentId, authorUserId: null, categoryId: null });
  });

  it("files an entry under one category of its own kind, and writes nothing of a refused curation", async () => {
    const contentId = await publishedPost("filed");
    const travel = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "travel", label: "Travel", sortOrder: 1 });
    const newsOnly = await createSiteContentCategory({ siteId: site.id, type: NEWS, slug: "press", label: "Press", sortOrder: 0 });
    if (travel === "slug_taken" || newsOnly === "slug_taken") throw new Error("category not created");
    expect(await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "travel", label: "Again", sortOrder: 0 }))
      .toBe("slug_taken");

    const author = await writer({ first: "Kept", last: "Author" });
    expect(await curateSiteContentEntry({
      kind: "blog", siteId: site.id, contentId, authorUserId: author, categoryId: newsOnly.id,
    })).toBe("category_missing");
    const editorRow = async () => (await listSiteContentEntriesForEditor({
      kind: "blog", siteId: site.id, locale: "en", page: 1, pageSize: 100,
    })).rows.find((row) => row.contentId === contentId);
    // The author half of the refused curation did not stand either.
    expect((await editorRow())?.authorUserId).toBeNull();

    expect(await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId, categoryId: travel.id }))
      .toMatchObject({ categoryId: travel.id });
    expect((await readPublishedSiteContentEntry("blog", site.id, "en", "filed"))?.category)
      .toEqual({ slug: "travel", label: "Travel" });
    expect((await listSiteContentCategories(site.id, BLOG)).find((row) => row.id === travel.id)?.entryCount).toBe(1);

    const renamed = await updateSiteContentCategory({
      siteId: site.id, type: BLOG, id: travel.id, slug: "journeys", label: "Journeys", sortOrder: 1,
    });
    expect(renamed).toMatchObject({ slug: "journeys", entryCount: 1 });
    expect((await editorRow())?.category).toBe("Journeys");

    expect(await deleteSiteContentCategory({ siteId: site.id, type: BLOG, id: travel.id })).toBe(true);
    expect((await readPublishedSiteContentEntry("blog", site.id, "en", "filed"))?.category).toBeNull();
  });

  it("holds one category per entry, and a link to its own Site and kind, in the database itself", async () => {
    const contentId = await publishedPost("guarded");
    const pool = await requirePhiTestDatabase();
    const first = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "first", label: "First", sortOrder: 0 });
    const second = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "second", label: "Second", sortOrder: 0 });
    const foreign = await createSiteContentCategory({ siteId: otherSite.id, type: BLOG, slug: "foreign", label: "Foreign", sortOrder: 0 });
    if (first === "slug_taken" || second === "slug_taken" || foreign === "slug_taken") throw new Error("not created");
    const link = (termId: number, siteId = site.id) => pool.query(
      `INSERT INTO phis.site_content_term_links (content_id, term_id, site_id, type, vocabulary) VALUES ($1, $2, $3, $4, 2)`,
      [contentId, termId, siteId, BLOG],
    );
    // Another Site's category, named as this Site's or as its own: both foreign keys refuse.
    await expect(link(foreign.id)).rejects.toMatchObject({ code: "23503" });
    await expect(link(foreign.id, otherSite.id)).rejects.toMatchObject({ code: "23503" });
    await link(first.id);
    await expect(link(second.id)).rejects.toMatchObject({ code: "23505" });
  });

  it("lists only the categories a list is set to, filed under none among them, before the cut", async () => {
    const pool = await requirePhiTestDatabase();
    const kept = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "kept", label: "Kept", sortOrder: 0 });
    const other = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "other", label: "Other", sortOrder: 0 });
    if (kept === "slug_taken" || other === "slug_taken") throw new Error("not created");
    const inKept = await publishedPost("filter-kept");
    const inOther = await publishedPost("filter-other");
    await publishedPost("filter-none");
    await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId: inKept, categoryId: kept.id });
    await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId: inOther, categoryId: other.id });
    // The kept entry is the oldest, so a cut of one before the filter would never reach it.
    await pool.query(`UPDATE phis.site_content SET published_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [inKept]);

    const slugs = async (categories: { categoryIds: number[]; uncategorized: boolean }, limit?: number) =>
      (await listPublishedSiteContentEntries("blog", site.id, "en", { categories, ...(limit ? { limit } : {}) }))
        .map((entry) => entry.slug);

    expect(await slugs({ categoryIds: [kept.id], uncategorized: false }, 1)).toEqual(["filter-kept"]);
    const keptAndNone = await slugs({ categoryIds: [kept.id], uncategorized: true });
    expect(keptAndNone).toEqual(expect.arrayContaining(["filter-kept", "filter-none"]));
    expect(keptAndNone).not.toContain("filter-other");
    const none = await slugs({ categoryIds: [], uncategorized: true });
    expect(none).toContain("filter-none");
    expect(none).not.toContain("filter-kept");
    expect(none).not.toContain("filter-other");
    // Neither is no filter.
    expect(await slugs({ categoryIds: [], uncategorized: false }))
      .toEqual(expect.arrayContaining(["filter-kept", "filter-other", "filter-none"]));
  });

  it("puts the closest entries first: the same category, then shared tags, then the newest", async () => {
    const pool = await requirePhiTestDatabase();
    const category = await createSiteContentCategory({ siteId: site.id, type: BLOG, slug: "near", label: "Near", sortOrder: 0 });
    if (category === "slug_taken") throw new Error("not created");
    const subject = await publishedPost("rel-subject", { tags: ["alpha", "beta"] });
    const sameCategory = await publishedPost("rel-category");
    const twoTags = await publishedPost("rel-two-tags", { tags: ["alpha", "beta"] });
    const oneTag = await publishedPost("rel-one-tag", { tags: ["beta"] });
    const unrelated = await publishedPost("rel-unrelated", { tags: ["gamma"] });
    for (const contentId of [subject, sameCategory]) {
      await curateSiteContentEntry({ kind: "blog", siteId: site.id, contentId, categoryId: category.id });
    }
    // "The newest among equals" needs the unrelated one to be the newest of all.
    await pool.query(`UPDATE phis.site_content SET published_at = NOW() - INTERVAL '1 day' WHERE id = ANY($1)`, [[subject, sameCategory, twoTags, oneTag]]);

    const related = await listRelatedSiteContentEntries("blog", site.id, "en", { contentId: subject, limit: 12 });
    const order = related.map((entry) => entry.slug);
    expect(order).not.toContain("rel-subject");
    // Category plus nothing else scores two, like two shared tags; the tie goes to the newer.
    expect(order.indexOf("rel-one-tag")).toBeGreaterThan(Math.max(order.indexOf("rel-two-tags"), order.indexOf("rel-category")));
    expect(order.indexOf("rel-unrelated")).toBeGreaterThan(order.indexOf("rel-one-tag"));
    expect(related.find((entry) => entry.contentId === unrelated)).toBeDefined();
    expect((await listPublishedSiteContentEntries("blog", site.id, "en")).length).toBeGreaterThan(related.length);
  });
});
