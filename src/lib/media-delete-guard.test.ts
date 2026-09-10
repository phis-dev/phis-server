import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaAssetRecord } from "@/db/media";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

import { collectMediaAssetDeleteReferences } from "./media-delete-guard";

type Row = {
  source_kind: number;
  source_scope_id: number;
  source_revision_id: number | null;
  source_location: string;
  target_area_id: number | null;
  page_path: string | null;
  source_area_id: number | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    source_kind: 1,
    source_scope_id: 18,
    source_revision_id: 190,
    source_location: "/contentWidgets/0/config/markdown@15",
    target_area_id: null,
    page_path: "/kontakt",
    source_area_id: null,
    ...overrides,
  };
}

function pool(rows: Row[] = []) {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  mocks.getPool.mockReturnValue({
    query: async (text: string, values?: readonly unknown[]) => {
      statements.push({ text, values: values ?? [] });
      return { rows };
    },
  });
  return statements;
}

const asset = (overrides: Partial<MediaAssetRecord> = {}) =>
  ({ id: 9, siteId: 31, ...overrides }) as MediaAssetRecord;

beforeEach(() => {
  mocks.getPool.mockReset();
});

/*
 * The guard behind `media_asset_in_use`. It decides whether an Asset may go, so it must name every
 * source that still points at it -- and no source that only appears to. The second half is why the
 * revision pointers are read: a discarded Working Draft takes its revision but leaves its index rows,
 * and this is the reader that can tell the difference.
 */
describe("The Asset delete guard", () => {
  it("asks for this Site's references to this Asset alone", async () => {
    const statements = pool();
    await collectMediaAssetDeleteReferences(31, asset());
    expect(statements[0].values).toEqual([31, 9]);
    expect(statements[0].text).toMatch(/WHERE ref\.site_id = \$1 AND ref\.target_asset_id = \$2/u);
  });

  it("refuses to answer for an Asset of another Site", async () => {
    const statements = pool([row()]);
    await expect(collectMediaAssetDeleteReferences(31, asset({ siteId: 32 }))).resolves.toEqual([]);
    await expect(collectMediaAssetDeleteReferences(0, asset())).resolves.toEqual([]);
    expect(statements).toHaveLength(0);
  });

  it("disregards a row whose revision the Scope no longer points at", async () => {
    const statements = pool();
    await collectMediaAssetDeleteReferences(31, asset());
    const text = statements[0].text;
    // Page, Navigation and Theme each against their own Scope's two pointers, and an Area against its
    // three: a Module Working Draft is a live source, so leaving it out read the picture a Module had
    // just placed as the residue of a discarded draft.
    expect(text).toMatch(/ref\.source_kind = 1 AND ref\.source_revision_id IN \(\s*page_scope\.published_revision_id, page_scope\.working_draft_revision_id\)/u);
    expect(text).toMatch(/ref\.source_kind = 2 AND ref\.source_revision_id IN \(\s*nav_scope\.published_revision_id, nav_scope\.working_draft_revision_id\)/u);
    expect(text).toMatch(/ref\.source_kind = 4 AND ref\.source_revision_id IN \(\s*area_scope\.published_revision_id, area_scope\.working_draft_revision_id,\s*area_scope\.working_module_draft_revision_id\)/u);
    expect(text).toMatch(/ref\.source_kind = 5 AND ref\.source_revision_id IN \(\s*theme_scope\.published_revision_id, theme_scope\.working_draft_revision_id\)/u);
    expect(text).toMatch(/LEFT JOIN phis\.site_nav_scopes nav_scope/u);
  });

  it("keeps a Content row and a row that names no revision at all", async () => {
    const statements = pool();
    await collectMediaAssetDeleteReferences(31, asset());
    // A Content row's revision is a content version, not a Scope revision, and the orphan collector
    // already removes those rows when a discarded Draft leaves the content unreferenced.
    expect(statements[0].text).toMatch(/ref\.source_revision_id IS NULL\s*\n\s*OR ref\.source_kind = 3/u);
  });

  it("names the source each blocking reference sits in", async () => {
    pool([
      row({ source_kind: 1, source_scope_id: 18, page_path: "/kontakt", target_area_id: 1 }),
      row({ source_kind: 2, source_scope_id: 3, page_path: null, target_area_id: 1 }),
      row({ source_kind: 3, source_scope_id: 19, page_path: null }),
      row({ source_kind: 4, source_scope_id: 11, page_path: null, source_area_id: 2 }),
    ]);
    const references = await collectMediaAssetDeleteReferences(31, asset());
    expect(references.map((entry) => entry.scope)).toEqual(["page", "navigation", "content", "area"]);
    expect(references[0]).toMatchObject({ pageId: 18, pagePath: "/kontakt", areaMask: 1, contentId: null });
    expect(references[2]).toMatchObject({ pageId: null, contentId: 19 });
    // An Asset reference carries no target Area, so an Area source is named by its own Scope's Area.
    expect(references[3]).toMatchObject({ areaMask: 2, pageId: null, contentId: null });
  });

  it("reports the location as the reference's own field path", async () => {
    pool([row({ source_location: "/regions/0/config/logoAssetUri", source_revision_id: 184 })]);
    const [reference] = await collectMediaAssetDeleteReferences(31, asset());
    expect(reference).toMatchObject({
      fieldPath: "/regions/0/config/logoAssetUri",
      contentVersionId: 184,
      matchType: "assetId",
      matchedValue: "9",
    });
  });
});
