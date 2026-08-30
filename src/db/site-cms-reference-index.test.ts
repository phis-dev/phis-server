import { describe, expect, it } from "vitest";

import {
  PhiCmsReferenceSourceKind,
  collectSiteCmsReferences,
  countSiteCmsReferencesToPageWithDb,
  replaceSiteCmsReferencesWithDb,
  type SiteCmsReferenceWrite,
} from "@/db/site-cms-references";
import { createPhiAssetUri, createPhiPageUri, createPhiPageReference } from "@/lib/internal-references";

type IndexRow = {
  site_id: number;
  source_kind: number;
  source_scope_id: number;
  source_revision_id: number | null;
  source_location: string;
  target_kind: number;
  target_area_id: number | null;
  target_page_scope_id: number | null;
  target_asset_id: number | null;
};

/**
 * A standing `site_cms_references` table rather than a statement recorder: replacement is only correct
 * across several writes, so what matters is the set that is left behind, not the SQL of one call.
 */
function referenceIndex(seed: IndexRow[] = [], options: { siteSpaceAssetIds?: number[] } = {}) {
  let rows = [...seed];
  const db = {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("FROM phis.media_assets")) {
        const asked = values[1] as number[];
        const owned = options.siteSpaceAssetIds;
        return { rows: asked.filter((id) => !owned || owned.includes(id)).map((id) => ({ id })) };
      }
      if (text.includes("DELETE FROM phis.site_cms_references")) {
        rows = rows.filter((row) => !(
          row.site_id === values[0] && row.source_kind === values[1] && row.source_scope_id === values[2]
        ));
        return { rows: [] };
      }
      if (text.includes("INSERT INTO phis.site_cms_references")) {
        const [siteId, sourceKind, sourceScopeId, sourceRevisionId, locations, targetKinds, targetAreaIds,
          pageScopeIds, , , assetIds] = values as [
            number, number, number, number | null, string[], number[], (number | null)[],
            (number | null)[], unknown, unknown, (number | null)[],
          ];
        locations.forEach((location, index) => {
          rows.push({
            site_id: siteId,
            source_kind: sourceKind,
            source_scope_id: sourceScopeId,
            source_revision_id: sourceRevisionId,
            source_location: location,
            target_kind: targetKinds[index],
            target_area_id: targetAreaIds[index],
            target_page_scope_id: pageScopeIds[index],
            target_asset_id: assetIds[index],
          });
        });
        return { rows: [] };
      }
      if (text.includes("FROM phis.site_cms_references")) {
        const counts = new Map<number, number>();
        for (const row of rows) {
          if (row.site_id !== values[0] || row.target_page_scope_id !== values[1]) continue;
          counts.set(row.source_kind, (counts.get(row.source_kind) ?? 0) + 1);
        }
        return {
          rows: [...counts].map(([source_kind, count]) => ({ source_kind, count: String(count) })),
        };
      }
      return { rows: [] };
    },
  };
  return {
    db: db as never,
    all: () => rows,
    of: (sourceKind: number, sourceScopeId: number, siteId = 31) => rows
      .filter((row) => row.site_id === siteId && row.source_kind === sourceKind && row.source_scope_id === sourceScopeId)
      .map((row) => row.source_location)
      .sort(),
  };
}

function pageRef(location: string, pageScopeId: number): SiteCmsReferenceWrite {
  return {
    location,
    reference: {
      kind: "page",
      reference: createPhiPageReference({ kind: "site", pageScopeId }),
      target: { kind: "site", pageScopeId },
      fragment: null,
    },
    targetAreaId: 1,
  };
}

function assetRef(location: string, assetId: number): SiteCmsReferenceWrite {
  return { location, reference: { kind: "asset", assetId } };
}

async function write(
  index: ReturnType<typeof referenceIndex>,
  references: SiteCmsReferenceWrite[],
  overrides: {
    siteId?: number;
    sourceKind?: PhiCmsReferenceSourceKind;
    sourceScopeId?: number;
    sourceRevisionId?: number;
  } = {},
) {
  await replaceSiteCmsReferencesWithDb(index.db, {
    siteId: 31,
    sourceKind: PhiCmsReferenceSourceKind.Page,
    sourceScopeId: 18,
    sourceRevisionId: 200,
    references,
    ...overrides,
  });
}

/*
 * The index is a projection, not a log: every write states one source's complete set. If replacement
 * ever leaked -- a stale row surviving, a row landing under the wrong scope -- the delete guards would
 * refuse deletions for references that no longer exist, and path-change reporting would count ghosts.
 * Nothing throws when that happens, so it has to be measured over repeated writes.
 */
describe("The reference index holds one set per source, however often it is written", () => {
  it("replaces the previous set instead of adding to it", async () => {
    const index = referenceIndex();
    await write(index, [pageRef("/widgets/0/config/href", 42), pageRef("/widgets/1/config/href", 43), assetRef("/widgets/2/config/src", 9)]);
    expect(index.of(1, 18)).toEqual(["/widgets/0/config/href", "/widgets/1/config/href", "/widgets/2/config/src"]);

    await write(index, [pageRef("/widgets/0/config/href", 42)]);
    expect(index.of(1, 18)).toEqual(["/widgets/0/config/href"]);
  });

  it("does not multiply when the same tree is saved again", async () => {
    const index = referenceIndex();
    const references = [pageRef("/widgets/0/config/href", 42), assetRef("/widgets/1/config/src", 9)];
    for (let attempt = 0; attempt < 3; attempt += 1) await write(index, references);
    expect(index.of(1, 18)).toEqual(["/widgets/0/config/href", "/widgets/1/config/src"]);
  });

  it("empties the set when the last reference is edited out", async () => {
    const index = referenceIndex();
    await write(index, [assetRef("/widgets/0/config/src", 9)]);
    // The write that carries nothing still has to clear: this is the case where the guard would
    // otherwise keep protecting an Asset the Page no longer mentions.
    await write(index, []);
    expect(index.of(1, 18)).toEqual([]);
  });

  it("carries the revision that was just written, so a stale set is recognizable", async () => {
    const index = referenceIndex();
    await write(index, [assetRef("/widgets/0/config/src", 9)], { sourceRevisionId: 201 });
    expect(index.all()[0]).toMatchObject({ source_revision_id: 201, target_kind: 3, target_asset_id: 9 });
  });

  it("keeps a rejected write from destroying the set it would have replaced", async () => {
    const index = referenceIndex([], { siteSpaceAssetIds: [9] });
    await write(index, [assetRef("/widgets/0/config/src", 9)]);
    await expect(write(index, [assetRef("/widgets/0/config/src", 500)]))
      .rejects.toThrow(/Asset reference #500 is not owned/u);
    // The ownership check runs before the delete, so the previous set is still standing.
    expect(index.of(1, 18)).toEqual(["/widgets/0/config/src"]);
  });

  it("refuses a Page reference that names no Area, because a path is only unique inside one", async () => {
    const index = referenceIndex();
    await expect(write(index, [{ ...pageRef("/widgets/0/config/href", 42), targetAreaId: undefined }]))
      .rejects.toThrow(/requires a target Area id/u);
  });
});

describe("The reference index keeps sources apart", () => {
  it("leaves another Scope's references where they are", async () => {
    const index = referenceIndex();
    await write(index, [pageRef("/a", 42)], { sourceScopeId: 18 });
    await write(index, [pageRef("/b", 42)], { sourceScopeId: 19 });
    await write(index, [], { sourceScopeId: 18 });
    expect(index.of(1, 18)).toEqual([]);
    expect(index.of(1, 19)).toEqual(["/b"]);
  });

  it("leaves another Site's references where they are, even under the same Scope id", async () => {
    const index = referenceIndex();
    await write(index, [pageRef("/a", 42)], { siteId: 31 });
    await write(index, [pageRef("/b", 42)], { siteId: 32 });
    await write(index, [], { siteId: 31 });
    expect(index.of(1, 18, 31)).toEqual([]);
    expect(index.of(1, 18, 32)).toEqual(["/b"]);
  });

  it("leaves another source kind alone, because the Scope id means a different thing per kind", async () => {
    const index = referenceIndex();
    // Page Scope #18 and Area Scope #18 are unrelated rows in unrelated tables; `source_scope_id`
    // carries no foreign key and is only readable together with `source_kind`.
    await write(index, [pageRef("/page", 42)], { sourceKind: PhiCmsReferenceSourceKind.Page });
    await write(index, [pageRef("/area", 42)], { sourceKind: PhiCmsReferenceSourceKind.Area });
    await write(index, [pageRef("/content", 42)], { sourceKind: PhiCmsReferenceSourceKind.Content });
    await write(index, [], { sourceKind: PhiCmsReferenceSourceKind.Area });
    expect(index.of(PhiCmsReferenceSourceKind.Page, 18)).toEqual(["/page"]);
    expect(index.of(PhiCmsReferenceSourceKind.Area, 18)).toEqual([]);
    expect(index.of(PhiCmsReferenceSourceKind.Content, 18)).toEqual(["/content"]);
  });

  it("counts only this Site's references to a Page, across all four sources", async () => {
    const index = referenceIndex();
    await write(index, [pageRef("/a", 42), pageRef("/b", 42)], { sourceKind: PhiCmsReferenceSourceKind.Page });
    await write(index, [pageRef("/c", 42)], { sourceKind: PhiCmsReferenceSourceKind.Navigation });
    await write(index, [pageRef("/d", 42)], { sourceKind: PhiCmsReferenceSourceKind.Area });
    await write(index, [pageRef("/e", 42)], { siteId: 32, sourceKind: PhiCmsReferenceSourceKind.Content });
    await expect(countSiteCmsReferencesToPageWithDb(index.db, 31, 42)).resolves.toEqual({
      total: 4,
      bySource: { page: 2, navigation: 1, content: 0, area: 1 },
    });
    // The other Site's reference is counted for that Site alone.
    await expect(countSiteCmsReferencesToPageWithDb(index.db, 32, 42)).resolves.toMatchObject({
      total: 1,
      bySource: { content: 1 },
    });
  });

  it("counts nothing a discarded Working Draft left behind", async () => {
    const statements: string[] = [];
    const db = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [] } as never;
      },
    };
    await countSiteCmsReferencesToPageWithDb(db as never, 31, 42);
    // The same three joins and the same predicate the Asset delete guard reads by, so a rename is not
    // reported as more disruptive than it is.
    expect(statements[0]).toMatch(/LEFT JOIN phis\.site_page_scopes page_scope/u);
    expect(statements[0]).toMatch(/LEFT JOIN phis\.site_nav_scopes nav_scope/u);
    expect(statements[0]).toMatch(/LEFT JOIN phis\.site_area_scopes area_scope/u);
    expect(statements[0]).toMatch(/ref\.source_revision_id IN \(\s*page_scope\.published_revision_id/u);
    expect(statements[0]).toMatch(/ref\.source_revision_id IS NULL\s*\n\s*OR ref\.source_kind = 3/u);
  });

  it("counts nothing for a Page nothing points at", async () => {
    const index = referenceIndex();
    await write(index, [pageRef("/a", 42)]);
    await expect(countSiteCmsReferencesToPageWithDb(index.db, 31, 43)).resolves.toEqual({
      total: 0,
      bySource: { page: 0, navigation: 0, content: 0, area: 0 },
    });
  });
});

describe("What a saved tree contributes to the index", () => {
  it("keeps one location per reference, so a rewrite of the same tree is stable", async () => {
    const tree = {
      contentWidgets: [
        { config: { markdown: `[a](${createPhiPageUri(createPhiPageReference({ kind: "site", pageScopeId: 18 }))}) ![b](${createPhiAssetUri(9)})` } },
      ],
    };
    const index = referenceIndex();
    await write(index, collectSiteCmsReferences(tree, { targetAreaId: 1 }));
    const first = index.of(1, 18);
    await write(index, collectSiteCmsReferences(tree, { targetAreaId: 1 }));
    expect(index.of(1, 18)).toEqual(first);
    // Two references in one string are told apart by their offset, not merged into one row.
    expect(first).toHaveLength(2);
    expect(first.every((location) => /@\d+$/u.test(location))).toBe(true);
  });
});
