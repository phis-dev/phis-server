import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  PhiCmsReferenceSourceKind,
  collectSiteCmsReferences,
  countSiteCmsReferencesToPageWithDb,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import { createPhiAssetUri, createPhiPageUri, createPhiPageReference } from "@/lib/internal-references";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

/*
 * A reference sitting in Area Region or widget config carries no content binding, so the Content source
 * never sees it. Before the Area source existed it was in no index at all: the delete guard let its
 * target go and path-change reporting counted it as zero. These pin the fourth source, because the way
 * it fails is silence -- nothing throws, the reference simply is not there.
 */
describe("An Area's own tree is a reference source", () => {
  it("finds a reference in Region config, where no content binding reaches", () => {
    const references = collectSiteCmsReferences(
      {
        regions: [
          {
            key: "header",
            config: {
              logoAssetUri: createPhiAssetUri(9),
              ctaHref: createPhiPageUri(createPhiPageReference({ kind: "site", pageScopeId: 42 })),
            },
          },
        ],
      },
      { targetAreaId: 2 },
    );
    expect(references.map((entry) => entry.reference.kind).sort()).toEqual(["asset", "page"]);
    const page = references.find((entry) => entry.reference.kind === "page");
    expect(page).toMatchObject({ targetAreaId: 2 });
    expect(page!.location).toBe("/regions/0/config/ctaHref");
  });

  it("is written by the Area save, inside the transaction that persists the revision", async () => {
    const source = await read("src/db/site-pages.ts");
    const fn = /export async function saveSiteAreaDraftRevision[\s\S]*?\n\}\n/u.exec(source);
    expect(fn, "the Area write stays findable").not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/sourceKind: PhiCmsReferenceSourceKind\.Area/u);
    expect(body).toMatch(/sourceScopeId: scope\.id/u);
    // The index write sits before the commit, so a rolled-back save leaves no reference behind.
    expect(body.indexOf("PhiCmsReferenceSourceKind.Area")).toBeLessThan(body.indexOf('COMMIT"'));
  });

  it("carries the Area as the target Area, the way the Page source does", async () => {
    const source = await read("src/db/site-pages.ts");
    const areaWrite = /sourceKind: PhiCmsReferenceSourceKind\.Area[\s\S]*?\}\);/u.exec(source);
    expect(areaWrite).not.toBeNull();
    expect(areaWrite![0]).toMatch(/collectSiteCmsReferences\(nextRevisionInput, \{ targetAreaId: areaMask \}\)/u);
  });

  it("persists under the fourth source kind the schema allows", async () => {
    expect(PhiCmsReferenceSourceKind.Area).toBe(4);
    const ddl = await read("scripts/sql/001_create_phis.pgsql");
    expect(ddl).toMatch(/source_kind_check CHECK \(source_kind IN \(1, 2, 3, 4\)\)/u);
  });

  it("replaces one Area Scope's whole set rather than appending to it", async () => {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    const db = {
      query: async (text: string, values?: readonly unknown[]) => {
        statements.push({ text, values: values ?? [] });
        // The Asset ownership check runs first; answering it keeps this about the write itself.
        return { rows: text.includes("FROM phis.media_assets") ? [{ id: 9 }] : [] } as never;
      },
    };
    await replaceSiteCmsReferencesWithDb(db as never, {
      siteId: 31,
      sourceKind: PhiCmsReferenceSourceKind.Area,
      sourceScopeId: 11,
      sourceRevisionId: 189,
      references: collectSiteCmsReferences(
        { regions: [{ config: { logo: createPhiAssetUri(9) } }] },
        { targetAreaId: 2 },
      ),
    });
    const deletion = statements.find((entry) => entry.text.includes("DELETE FROM phis.site_cms_references"));
    expect(deletion, "the previous set goes first").toBeDefined();
    expect(deletion!.values).toEqual([31, 4, 11]);
    const insertion = statements.find((entry) => entry.text.includes("INSERT INTO phis.site_cms_references"));
    expect(insertion!.values.slice(0, 4)).toEqual([31, 4, 11, 189]);
  });
});

describe("An Area reference is visible where references are read", () => {
  it("is counted by path-change reporting instead of being dropped", async () => {
    const db = {
      query: async () => ({
        rows: [
          { source_kind: 1, count: "2" },
          { source_kind: 4, count: "3" },
        ],
      }) as never,
    };
    const result = await countSiteCmsReferencesToPageWithDb(db as never, 31, 42);
    expect(result.bySource.area).toBe(3);
    // Without the Area term the total would say 2 and the operator would move the path believing it.
    expect(result.total).toBe(5);
  });

  it("names the Area it sits in when it blocks an Asset delete", async () => {
    const source = await read("src/lib/media-delete-guard.ts");
    expect(source).toMatch(/scope: "page" \| "navigation" \| "content" \| "area"/u);
    expect(source).toMatch(/LEFT JOIN phis\.site_area_scopes area_scope\s*\n\s*ON ref\.source_kind = 4/u);
    // An Asset reference carries no target Area, so the Area is read from the source Scope.
    expect(source).toMatch(/areaMask: row\.target_area_id \?\? row\.source_area_id/u);
    expect(source).toMatch(/row\.source_kind === 4\s*\n?\s*\? "area"/u);
  });
});
