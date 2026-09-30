import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createPhiAssetUri } from "@/lib/internal-references";
import { SiteCmsDraftConflictError } from "./site-revision-scopes";
import { listSiteRevisionHistory } from "./site-revisions";
import {
  deleteSiteThemeDraftRevision,
  publishSiteThemeRevision,
  saveSiteThemeDraftRevision,
} from "./site-theme";

let site: PhiTestSite;

beforeAll(async () => {
  await requirePhiTestDatabase();
  await dropPhiTestSites();
  site = await createPhiTestSite("keyed-revisions");
});

afterAll(async () => {
  await dropPhiTestSites();
  await closePhiTestPool();
});

/**
 * A Theme runs on the same revision machine as a Navigation and follows the same rules: a publish takes
 * the Working Draft only, and discarding the only Draft of a Theme that was never published removes the
 * scope it created. Before, a Theme published any of its revisions and dropped the open Draft unsaid,
 * and a discarded first Draft left an empty scope behind.
 */
describe("Theme revisions against PostgreSQL", () => {
  async function themeScopeOf(key: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      id: number;
      published_revision_id: number | null;
      working_draft_revision_id: number | null;
    }>(
      `SELECT id, published_revision_id, working_draft_revision_id
       FROM phis.site_theme_scopes WHERE site_id = $1 AND key = $2`,
      [site.id, key],
    );
    return rows[0] ?? null;
  }

  async function themeReferenceCount(scopeId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM phis.site_cms_references
       WHERE site_id = $1 AND source_kind = 5 AND source_scope_id = $2`,
      [site.id, scopeId],
    );
    return Number(rows[0]!.count);
  }

  it("publishes the Working Draft and refuses any other revision of the scope", async () => {
    const key = "pgtest-publish";
    const first = await saveSiteThemeDraftRevision(site.id, { key, theme: { preset: "first" } });
    await publishSiteThemeRevision(site.id, { key, revisionId: first.revisionId });
    const draft = await saveSiteThemeDraftRevision(site.id, { key, theme: { preset: "second" } });

    await expect(
      publishSiteThemeRevision(site.id, { key, revisionId: first.revisionId }),
    ).rejects.toBeInstanceOf(SiteCmsDraftConflictError);
    expect(await themeScopeOf(key)).toMatchObject({
      published_revision_id: first.revisionId,
      working_draft_revision_id: draft.revisionId,
    });

    await publishSiteThemeRevision(site.id, { key, revisionId: draft.revisionId });
    expect(await themeScopeOf(key)).toMatchObject({
      published_revision_id: draft.revisionId,
      working_draft_revision_id: null,
    });
    // With no Draft open, naming the published revision again is a retry and goes through.
    await publishSiteThemeRevision(site.id, { key, revisionId: draft.revisionId });
  });

  it("drops a never-published scope with its only Draft, and the Draft's references", async () => {
    const key = "pgtest-discard-new";
    const logo = await createPhiTestAsset(site, `pgtest/theme-logo-${Math.random()}`);
    await saveSiteThemeDraftRevision(site.id, {
      key,
      theme: { preset: "first", brand: { logo: createPhiAssetUri(logo) } },
    });
    const scope = await themeScopeOf(key);
    expect(scope).not.toBeNull();
    expect(await themeReferenceCount(scope!.id)).toBe(1);

    expect(await deleteSiteThemeDraftRevision(site.id, { key })).toEqual({ deleted: true });
    expect(await themeScopeOf(key)).toBeNull();
    expect(await themeReferenceCount(scope!.id)).toBe(0);
  });

  it("keeps a published scope and its published revision when the Draft is discarded", async () => {
    const key = "pgtest-discard-published";
    const first = await saveSiteThemeDraftRevision(site.id, { key, theme: { preset: "first" } });
    await publishSiteThemeRevision(site.id, { key, revisionId: first.revisionId });
    await saveSiteThemeDraftRevision(site.id, { key, theme: { preset: "second" } });

    expect(await deleteSiteThemeDraftRevision(site.id, { key })).toEqual({ deleted: true });
    expect(await themeScopeOf(key)).toMatchObject({
      published_revision_id: first.revisionId,
      working_draft_revision_id: null,
    });
  });
});

/*
 * The revision history reads a Navigation scope by the Navigation module's own key rule. It kept a
 * looser copy that took keys no Navigation could have been saved under.
 */
describe("Navigation keys in the revision history against PostgreSQL", () => {
  it.each([
    ["a local key with characters a Navigation key cannot hold", "public:main menu"],
    ["a local key ending on a separator", "public:main-"],
    ["a key longer than the scope column", `public:${"a".repeat(64)}`],
    ["a key without an Area", "main"],
  ])("refuses %s", async (_label, key) => {
    await expect(listSiteRevisionHistory(site.id, { kind: "navigation", key })).rejects.toThrow(
      "Navigation key must be formatted as area:key.",
    );
  });

  it("reads a well-formed key, normalised, as an empty history", async () => {
    const history = await listSiteRevisionHistory(site.id, { kind: "navigation", key: " Public:Main " });
    expect(history.scope).toMatchObject({ kind: "navigation", area: "public", navKey: "main" });
    expect(history.rows).toEqual([]);
  });
});
