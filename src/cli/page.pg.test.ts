import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { listPhiStoredPages, resetPhiPageToPreset } from "./page.mts";

afterAll(async () => {
  await closePhiTestPool();
});

describe("phis page list and reset, against PostgreSQL", () => {
  let site: PhiTestSite;
  const owner = "@phis/pgtest-page";
  let presetScopeId: number;
  let ownScopeId: number;

  async function marker() {
    const { rows } = await getPool().query<{ marker: string }>(
      "SELECT marker::text AS marker FROM phis.site_read_marker WHERE site_id = $1",
      [site.id],
    );
    return rows[0]?.marker ?? null;
  }

  async function count(table: string, column: string, id: number) {
    const { rows } = await getPool().query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM phis.${table} WHERE ${column} = $1`, [id]);
    return Number(rows[0]!.n);
  }

  async function addPublishedRevision(scopeId: number) {
    const pool = getPool();
    const { rows } = await pool.query<{ id: number }>(
      "INSERT INTO phis.site_page_revisions (page_scope_id, tree_json) VALUES ($1, '{}'::jsonb) RETURNING id",
      [scopeId],
    );
    await pool.query(
      "UPDATE phis.site_page_scopes SET published_revision_id = $2, working_draft_revision_id = $2 WHERE id = $1",
      [scopeId, rows[0]!.id],
    );
    await pool.query("INSERT INTO phis.site_page_revisions (page_scope_id, tree_json) VALUES ($1, '{}'::jsonb)", [scopeId]);
    return rows[0]!.id;
  }

  const reset = (overrides: Partial<Parameters<typeof resetPhiPageToPreset>[1]> = {}) =>
    resetPhiPageToPreset(getPool(), {
      siteKey: site.key,
      area: "public",
      presetKey: "start",
      confirmed: true,
      dryRun: false,
      ...overrides,
    });

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("page-cli");
    const pool = getPool();
    const { rows } = await pool.query<{ id: number }>(
      "INSERT INTO phis.site_page_scopes (site_id, area_id, owner_module_id, preset_key) VALUES ($1, 1, $2, 'start') RETURNING id",
      [site.id, owner],
    );
    presetScopeId = rows[0]!.id;
    await addPublishedRevision(presetScopeId);
    ownScopeId = await createPhiTestPageScope(site, "/about");
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  it("lists the stored Module Page and the Site's own Page, narrowed by Area", async () => {
    const pages = await listPhiStoredPages(getPool(), { siteKey: site.key });
    expect(pages.map((page) => [page.path, page.ownerModuleId, page.presetKey])).toEqual([
      ["/about", null, null],
      [null, owner, "start"],
    ]);
    const modulePage = pages.find((page) => page.ownerModuleId)!;
    expect(modulePage).toMatchObject({ area: "public", tombstoned: false });
    expect(modulePage.publishedRevisionId).not.toBeNull();
    expect(modulePage.workingDraftRevisionId).toBe(modulePage.publishedRevisionId);
    expect(await listPhiStoredPages(getPool(), { siteKey: site.key, area: "admin" })).toEqual([]);
    await expect(listPhiStoredPages(getPool(), { siteKey: "pgtest-nope" })).rejects.toThrow(/No Site has the key/);
    await expect(listPhiStoredPages(getPool(), { siteKey: site.key, area: "nowhere" })).rejects.toThrow(/not an Area/);
  });

  it("changes nothing without --force or with --dry-run", async () => {
    const before = await marker();
    for (const options of [{ confirmed: false }, { confirmed: true, dryRun: true }]) {
      const plan = await reset(options);
      expect(plan).toMatchObject({ dryRun: true, deleted: false, revisions: 2 });
      expect(plan.page.scopeId).toBe(presetScopeId);
    }
    expect(await count("site_page_scopes", "id", presetScopeId)).toBe(1);
    expect(await count("site_page_revisions", "page_scope_id", presetScopeId)).toBe(2);
    expect(await marker()).toBe(before);
  });

  it("refuses a Site's own Page, an unknown Area, and an address that names both or neither", async () => {
    await expect(reset({ presetKey: null, path: "/about" })).rejects.toThrow(/Site's own, not a Module's/);
    await expect(reset({ area: "nowhere" })).rejects.toThrow(/not an Area/);
    await expect(reset({ siteKey: "pgtest-nope" })).rejects.toThrow(/No Site has the key/);
    await expect(reset({ path: "/about" })).rejects.toThrow(/one of them/);
    expect(await count("site_page_scopes", "id", ownScopeId)).toBe(1);
  });

  it("refuses more than one match until --module names one", async () => {
    const { rows } = await getPool().query<{ id: number }>(
      "INSERT INTO phis.site_page_scopes (site_id, area_id, owner_module_id, preset_key) VALUES ($1, 1, '@phis/pgtest-other', 'start') RETURNING id",
      [site.id],
    );
    await expect(reset()).rejects.toThrow(/More than one stored Page/);
    await expect(reset({ moduleId: "@phis/pgtest-other", dryRun: true })).resolves.toMatchObject({ revisions: 0 });
    await getPool().query("DELETE FROM phis.site_page_scopes WHERE id = $1", [rows[0]!.id]);
  });

  it("resets the Module Page: scope and revisions go, and the change marker moves", async () => {
    const before = await marker();
    const result = await reset();
    expect(result).toMatchObject({ dryRun: false, deleted: true, revisions: 2 });
    expect(await count("site_page_scopes", "id", presetScopeId)).toBe(0);
    expect(await count("site_page_revisions", "page_scope_id", presetScopeId)).toBe(0);
    expect(await count("site_page_scopes", "id", ownScopeId)).toBe(1);
    expect(await marker()).not.toBe(before);
  });

  it("refuses when nothing is stored", async () => {
    await expect(reset()).rejects.toThrow(/Nothing stored for preset "start".*the preset is already live/);
  });
});
