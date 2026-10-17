import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { SITE_CONTENT_STATUS_DRAFT, SITE_CONTENT_STATUS_PUBLISHED } from "./site-content";
import { createPhiPageReference } from "@/lib/internal-references";
import {
  deleteSiteContentEntry,
  listPublishedSiteContentEntries,
  listSiteContentEntriesForEditor,
  publishSiteContentEntry,
  saveSiteContentEntryDraft,
  SITE_CONTENT_ENTRY_KINDS,
  submitSiteContentEntry,
  withdrawSiteContentEntry,
  type SiteContentEntryInput,
} from "./site-content-entries";

/*
 * News is the first content type on the generic entry path (CONTENT.md). These shorthands state the kind,
 * and stand in for the writer who read the entry: a save builds on the current version and a publish
 * names it, unless a case states otherwise.
 */
const PHI_NEWS_TRANSLATION_CONTEXTS = SITE_CONTENT_ENTRY_KINDS.news.contexts;

async function currentVersionOf(contentId: number) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ current_version_id: number | null }>(
    `SELECT current_version_id FROM phis.site_content WHERE id = $1`,
    [contentId],
  );
  return rows[0]?.current_version_id ?? null;
}

async function saveSiteContentNewsDraft(input: Omit<SiteContentEntryInput, "kind">) {
  const baseVersionId = input.baseVersionId !== undefined || !input.contentId
    ? input.baseVersionId
    : await currentVersionOf(input.contentId);
  return saveSiteContentEntryDraft({ ...input, kind: "news", baseVersionId });
}

async function publishSiteContentNews(input: {
  siteId: number;
  contentId: number;
  versionId?: number;
  publishedAt: string | null;
  expiresAt: string | null;
}) {
  const versionId = input.versionId ?? await currentVersionOf(input.contentId);
  const outcome = await publishSiteContentEntry({ ...input, kind: "news", versionId: versionId ?? 0 });
  return typeof outcome === "string" ? null : outcome;
}

const listPublishedNews = (siteId: number, locale: string, options?: { limit?: number }) =>
  listPublishedSiteContentEntries("news", siteId, locale, options);
const listSiteContentNewsForEditor = (input: Omit<Parameters<typeof listSiteContentEntriesForEditor>[0], "kind">) =>
  listSiteContentEntriesForEditor({ ...input, kind: "news" });
const withdrawSiteContentNews = (input: { siteId: number; contentId: number }) =>
  withdrawSiteContentEntry({ ...input, kind: "news" });
const deleteSiteContentNews = (input: { siteId: number; contentId: number }) =>
  deleteSiteContentEntry({ ...input, kind: "news" });

/**
 * The News write path against PostgreSQL, because every question it raises is the database's answer.
 *
 * What a draft is, what a publish moves, whether a schedule needs anything to run and whether an expiry
 * needs anything written -- none of that can be shown by mocking the store that decides it.
 */
describe("the content entry write path, as News, against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("news");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function readRow(contentId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      status: number;
      current_version_id: number | null;
      published_version_id: number | null;
      published_at: string | null;
      expires_at: string | null;
    }>(
      `SELECT status, current_version_id, published_version_id, published_at, expires_at
       FROM phis.site_content WHERE id = $1`,
      [contentId],
    );
    return rows[0];
  }

  async function editorEntries() {
    const { rows } = await listSiteContentNewsForEditor({
      siteId: site.id, locale: "en", page: 1, pageSize: 100,
    });
    return rows;
  }

  function draft(slug: string, overrides: Record<string, unknown> = {}) {
    return saveSiteContentNewsDraft({
      siteId: site.id,
      slug,
      title: `Title ${slug}`,
      content: `Content ${slug}`,
      ...overrides,
    });
  }

  it("keeps a saved draft out of the public answer and in the editor's list", async () => {
    const saved = await draft("first-draft");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const row = await readRow(saved.contentId);
    expect(row?.status).toBe(SITE_CONTENT_STATUS_DRAFT);
    expect(row?.current_version_id).toBe(saved.versionId);
    expect(row?.published_version_id).toBeNull();

    expect((await listPublishedNews(site.id, "en")).map((item) => item.slug)).not.toContain("first-draft");

    const editorEntry = (await editorEntries())
      .find((entry) => entry.slug === "first-draft");
    expect(editorEntry).toMatchObject({
      title: "Title first-draft",
      content: "Content first-draft",
      hasUnpublishedChanges: true,
    });
  });

  it("refuses a second entry claiming an address instead of editing the first", async () => {
    await draft("taken-address");
    const second = await saveSiteContentNewsDraft({
      siteId: site.id,
      slug: "taken-address",
      title: "Someone else's title",
      content: "Someone else's content",
    });

    expect(second).toEqual({ ok: false, reason: "slug_taken" });
    const claimants = (await editorEntries()).filter((entry) => entry.slug === "taken-address");
    expect(claimants).toHaveLength(1);
    expect(claimants[0]?.title).toBe("Title taken-address");
  });

  it("answers a save against an id no entry has with `missing`", async () => {
    const outcome = await saveSiteContentNewsDraft({
      siteId: site.id,
      contentId: 2_147_483_600,
      title: "Nobody's title",
      content: "Nobody's content",
    });
    expect(outcome).toEqual({ ok: false, reason: "missing" });
  });

  it("publishes the draft version and answers the entry", async () => {
    const saved = await draft("published-entry", {
      link: { kind: "external", href: "https://example.test/somewhere" },
      tags: ["One", "two", " one "],
    });
    if (!saved.ok) throw new Error("the draft did not save");

    const publication = await publishSiteContentNews({
      siteId: site.id,
      contentId: saved.contentId,
      publishedAt: null,
      expiresAt: null,
    });
    expect(publication?.status).toBe(SITE_CONTENT_STATUS_PUBLISHED);
    expect(publication?.publishedAt).not.toBeNull();

    const row = await readRow(saved.contentId);
    expect(row?.published_version_id).toBe(saved.versionId);

    const item = (await listPublishedNews(site.id, "en")).find((entry) => entry.slug === "published-entry");
    expect(item).toMatchObject({
      title: { text: "Title published-entry", source: "Title published-entry", translated: false },
      link: { kind: "external", href: "https://example.test/somewhere" },
      // Trimmed, lower-cased and deduplicated: the string is the tag's identity.
      tags: ["one", "two"],
      // Nothing was declared, so the words are the Site's own language and may be translated.
      sourceLocale: null,
      translate: true,
    });
  });

  /*
   * A Page an entry links to is guarded like any other referenced Page (REFERENCES.md): the entry's link
   * is in the index from the save on, a save that drops it drops the row, and deleting the entry frees
   * the Page again.
   */
  it("indexes a linked Page and lets it go with the link and with the entry", async () => {
    const pool = await requirePhiTestDatabase();
    const target = await createPhiTestPageScope(site, "/pgtest-entry-link-target");
    const link = { kind: "page", reference: createPhiPageReference({ kind: "site", pageScopeId: target }) };
    const references = async (contentId: number) => (await pool.query<{ target_page_scope_id: number; target_area_id: number }>(
      `SELECT target_page_scope_id, target_area_id FROM phis.site_cms_references
       WHERE site_id = $1 AND source_kind = 3 AND source_scope_id = $2`,
      [site.id, contentId],
    )).rows;

    const saved = await draft("linked-entry", { link });
    if (!saved.ok) throw new Error("the draft did not save");
    // A target that names no Area is a Public Page: an entry is read there.
    expect(await references(saved.contentId)).toEqual([{ target_page_scope_id: target, target_area_id: 1 }]);
    expect((await editorEntries()).find((entry) => entry.contentId === saved.contentId)?.link).toEqual(link);

    const unlinked = await draft("linked-entry", { contentId: saved.contentId, link: null });
    if (!unlinked.ok) throw new Error("the second save did not go through");
    expect(await references(saved.contentId)).toEqual([]);

    const relinked = await draft("linked-entry", { contentId: saved.contentId, link });
    if (!relinked.ok) throw new Error("the third save did not go through");
    expect(await deleteSiteContentEntry({ kind: "news", siteId: site.id, contentId: saved.contentId })).toBe("deleted");
    expect(await references(saved.contentId)).toEqual([]);
  });

  it("keeps an edit made after a publish back until it is published in turn", async () => {
    const saved = await draft("edited-after-publish");
    if (!saved.ok) throw new Error("the draft did not save");
    await publishSiteContentNews({
      siteId: site.id, contentId: saved.contentId, publishedAt: null, expiresAt: null,
    });

    const edited = await saveSiteContentNewsDraft({
      siteId: site.id,
      contentId: saved.contentId,
      title: "The corrected title",
      content: "The corrected content",
    });
    if (!edited.ok) throw new Error("the edit did not save");
    expect(edited.versionId).not.toBe(saved.versionId);

    const publicItem = (await listPublishedNews(site.id, "en"))
      .find((entry) => entry.slug === "edited-after-publish");
    expect(publicItem?.title.text).toBe("Title edited-after-publish");

    const editorEntry = (await editorEntries())
      .find((entry) => entry.slug === "edited-after-publish");
    expect(editorEntry?.title).toBe("The corrected title");
    expect(editorEntry?.hasUnpublishedChanges).toBe(true);

    await publishSiteContentNews({
      siteId: site.id, contentId: saved.contentId, publishedAt: null, expiresAt: null,
    });
    const afterSecondPublish = (await listPublishedNews(site.id, "en"))
      .find((entry) => entry.slug === "edited-after-publish");
    expect(afterSecondPublish?.title.text).toBe("The corrected title");
  });

  it("does not answer an entry whose date has not come, and needs nothing to run when it does", async () => {
    const saved = await draft("scheduled-entry");
    if (!saved.ok) throw new Error("the draft did not save");

    const future = new Date(Date.now() + 3_600_000).toISOString();
    await publishSiteContentNews({
      siteId: site.id, contentId: saved.contentId, publishedAt: future, expiresAt: null,
    });
    expect((await listPublishedNews(site.id, "en")).map((item) => item.slug))
      .not.toContain("scheduled-entry");

    // The same row, the same status, nothing written in between: only the clock moved.
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `UPDATE phis.site_content SET published_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [saved.contentId],
    );
    expect((await listPublishedNews(site.id, "en")).map((item) => item.slug))
      .toContain("scheduled-entry");
  });

  it("stops answering an expired entry without anything being written", async () => {
    const saved = await draft("expired-entry");
    if (!saved.ok) throw new Error("the draft did not save");

    /*
     * A past expiry straight from the write layer, which the route refuses as a contradiction -- here it
     * is the shortest way to the state the clock reaches on its own an hour after a legitimate publish.
     */
    await publishSiteContentNews({
      siteId: site.id,
      contentId: saved.contentId,
      publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
    });

    expect((await listPublishedNews(site.id, "en")).map((item) => item.slug))
      .not.toContain("expired-entry");
    // Still published, and still the editor's to see -- expiry is a filter, not a state change.
    const row = await readRow(saved.contentId);
    expect(row?.status).toBe(SITE_CONTENT_STATUS_PUBLISHED);
    expect((await editorEntries()).map((entry) => entry.slug))
      .toContain("expired-entry");
  });

  it("refuses to delete a published entry and takes the draft once it is withdrawn", async () => {
    const saved = await draft("deleted-entry");
    if (!saved.ok) throw new Error("the draft did not save");
    await publishSiteContentNews({
      siteId: site.id,
      contentId: saved.contentId,
      publishedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(await deleteSiteContentNews({ siteId: site.id, contentId: saved.contentId }))
      .toBe("published");

    expect(await withdrawSiteContentNews({ siteId: site.id, contentId: saved.contentId })).toBe(true);
    const row = await readRow(saved.contentId);
    expect(row).toMatchObject({
      status: SITE_CONTENT_STATUS_DRAFT,
      published_version_id: null,
      published_at: null,
      expires_at: null,
    });
    // The words stayed: what was withdrawn is the publication.
    expect((await editorEntries())
      .find((entry) => entry.slug === "deleted-entry")?.title).toBe("Title deleted-entry");

    expect(await deleteSiteContentNews({ siteId: site.id, contentId: saved.contentId }))
      .toBe("deleted");
    expect(await deleteSiteContentNews({ siteId: site.id, contentId: saved.contentId }))
      .toBe("missing");
  });

  /*
   * The two values a save states about its own words. They live on the version rather than the entry
   * because a later version may be written in another language, and the read path needs both: one to know
   * which way to translate, one to know whether it may.
   */
  it("keeps the declared language and the switch with the version that was written", async () => {
    const saved = await draft("declared-german", { sourceLocale: "de", translate: false });
    if (!saved.ok) throw new Error("the draft did not save");

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ meta: { sourceLocale?: string; translate?: boolean } }>(
      "SELECT meta FROM phis.site_content_versions WHERE id = $1",
      [saved.versionId],
    );
    expect(rows[0]?.meta).toEqual({ sourceLocale: "de", translate: false });

    await publishSiteContentNews({
      siteId: site.id, contentId: saved.contentId, publishedAt: null, expiresAt: null,
    });
    const item = (await listPublishedNews(site.id, "en"))
      .find((entry) => entry.slug === "declared-german");
    expect(item).toMatchObject({ sourceLocale: "de", translate: false });

    // And the editor sees the same, because it is what a form has to show back.
    expect((await editorEntries())
      .find((entry) => entry.slug === "declared-german"))
      .toMatchObject({ sourceLocale: "de", translate: false });
  });

  /*
   * The context is part of a message's identity, and the read path states the same values when it asks for
   * a translation. If these drift apart, every read creates a second row for the same sentence and the
   * cache never hits -- which is invisible until somebody counts provider calls.
   */
  it("keeps each field's words under the context the read path asks with", async () => {
    const saved = await draft("spoken-context", { subtitle: "A subtitle" });
    if (!saved.ok) throw new Error("the draft did not save");

    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ field_name: string; ctx: string }>(
      `SELECT t.field_name, m.ctx
       FROM phis.site_content_version_text t
       JOIN phis.tr_site_msg m ON m.id = t.msg_id
       WHERE t.version_id = $1
       ORDER BY t.field_name`,
      [saved.versionId],
    );

    expect(rows).toEqual([
      { field_name: "content", ctx: PHI_NEWS_TRANSLATION_CONTEXTS.content },
      { field_name: "subtitle", ctx: PHI_NEWS_TRANSLATION_CONTEXTS.subtitle },
      { field_name: "title", ctx: PHI_NEWS_TRANSLATION_CONTEXTS.title },
    ]);
  });

  it("withdraws a draft without complaining, and finds nothing at an id no entry has", async () => {
    const saved = await draft("idempotent-withdraw");
    if (!saved.ok) throw new Error("the draft did not save");
    expect(await withdrawSiteContentNews({ siteId: site.id, contentId: saved.contentId })).toBe(true);
    expect(await withdrawSiteContentNews({ siteId: site.id, contentId: 2_147_483_600 })).toBe(false);
  });

  it("refuses a save that does not build on the current version, and writes nothing", async () => {
    const saved = await saveSiteContentNewsDraft({
      siteId: site.id, slug: "two-authors", title: "First", content: "Body.",
    });
    if (!saved.ok) throw new Error("save failed");
    const base = saved.versionId;
    const second = await saveSiteContentNewsDraft({
      siteId: site.id, contentId: saved.contentId, baseVersionId: base, title: "Second", content: "Body.",
    });
    if (!second.ok) throw new Error("second save failed");

    const stale = await saveSiteContentNewsDraft({
      siteId: site.id, contentId: saved.contentId, baseVersionId: base, title: "Stale", content: "Body.",
    });
    expect(stale).toEqual({ ok: false, reason: "conflict", currentVersionId: second.versionId });
    expect(await currentVersionOf(saved.contentId)).toBe(second.versionId);
  });

  it("publishes the version that was submitted, not the one written after it", async () => {
    const saved = await saveSiteContentNewsDraft({
      siteId: site.id, slug: "submitted-entry", title: "Submitted", content: "Body.",
    });
    if (!saved.ok) throw new Error("save failed");
    expect(await submitSiteContentEntry({
      kind: "news", siteId: site.id, contentId: saved.contentId, versionId: saved.versionId,
    })).toBe("submitted");
    await saveSiteContentNewsDraft({
      siteId: site.id, contentId: saved.contentId, title: "Written on", content: "Body.",
    });

    const editorRow = (await editorEntries()).find((entry) => entry.contentId === saved.contentId);
    expect(editorRow?.submittedVersionId).toBe(saved.versionId);
    expect(editorRow?.versionId).not.toBe(saved.versionId);

    await publishSiteContentNews({
      siteId: site.id, contentId: saved.contentId, versionId: saved.versionId, publishedAt: null, expiresAt: null,
    });
    const item = (await listPublishedNews(site.id, "en")).find((entry) => entry.slug === "submitted-entry");
    expect(item?.title.source).toBe("Submitted");
    expect((await editorEntries()).find((entry) => entry.contentId === saved.contentId)?.submittedVersionId)
      .toBeNull();
  });

  it("refuses to publish a version that is not the entry's", async () => {
    const saved = await saveSiteContentNewsDraft({
      siteId: site.id, slug: "foreign-version", title: "Mine", content: "Body.",
    });
    if (!saved.ok) throw new Error("save failed");
    expect(await publishSiteContentEntry({
      kind: "news", siteId: site.id, contentId: saved.contentId, versionId: saved.versionId + 100_000,
      publishedAt: null, expiresAt: null,
    })).toBe("version_mismatch");
  });
});
