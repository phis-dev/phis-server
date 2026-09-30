import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { collectSiteCmsReferences } from "@/db/site-cms-references";
import { createPhiAssetUri } from "@/lib/internal-references";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const locationsOf = (value: unknown) => collectSiteCmsReferences(value)
  .filter((entry) => entry.reference.kind === "asset")
  .map((entry) => entry.location)
  .sort();

const assetIdsOf = (value: unknown) => collectSiteCmsReferences(value)
  .flatMap((entry) => (entry.reference.kind === "asset" ? [entry.reference.assetId] : []))
  .sort((left, right) => left - right);

/*
 * A picture in config is stored as its id, not as a `phis:asset/<id>` URI: the URI form belongs to
 * Markdown and HTML bodies, and the walk that reads it only ever looked at strings. Everything a
 * picker writes -- a Widget image, a Region background, the Theme's ground and brand logo -- is a
 * number sitting next to its variant and geometry, and was therefore in no index at all. The way that
 * fails is silence: the delete guard reads the Theme or the Widget as referencing nothing and lets the
 * Asset go, while the page it is on keeps pointing at it.
 */
describe("An Asset id in persisted config is a reference", () => {
  it("finds the image source a Widget stores, at the field that carries the id", () => {
    expect(locationsOf({
      layoutNodes: [
        { key: "hero", config: { source: { kind: "image", sourceKind: "asset", assetId: 9 } } },
      ],
    })).toEqual(["/layoutNodes/0/config/source/assetId"]);
  });

  it("finds the ground a Module brought into the Site, in both modes", () => {
    const references = collectSiteCmsReferences({
      root: {
        background: {
          light: { base: { kind: "image", sourceKind: "asset", assetId: 12 } },
          dark: { base: { kind: "image", sourceKind: "asset", assetId: 13 } },
        },
      },
    });
    expect(references.map((entry) => entry.location).sort()).toEqual([
      "/root/background/dark/base/assetId",
      "/root/background/light/base/assetId",
    ]);
  });

  it("finds the brand logo of each mode, which names its Asset without an image source around it", () => {
    const theme = {
      brand: {
        logo: {
          light: { sourceKind: "asset", assetId: 4711 },
          dark: { sourceKind: "asset", assetId: 4712 },
        },
      },
    };
    expect(locationsOf(theme)).toEqual(["/brand/logo/dark/assetId", "/brand/logo/light/assetId"]);
    expect(assetIdsOf(theme)).toEqual([4711, 4712]);
  });

  /*
   * A font slot names its Asset as a URI rather than as an id, because what a slot holds is either a
   * family name or a reference and one field carries both. The string walk is what finds it -- and it
   * has to, or a typeface could be deleted out from under the Theme that renders in it.
   */
  it("finds the typeface a Theme renders in, named as a URI in a font slot", () => {
    const value = {
      fonts: { body: "phis:asset/91", mono: "Fira Mono", serif: "phis:asset/92" },
    };
    expect(locationsOf(value).sort()).toEqual(["/fonts/body", "/fonts/serif"]);
    expect(assetIdsOf(value).sort((left, right) => left - right)).toEqual([91, 92]);
  });

  it("keeps one row per field when two of them name the same Asset", () => {
    // Two places hold it, so two places lose their picture if it goes: the guard should name both.
    const value = {
      root: {
        background: {
          light: { base: { sourceKind: "asset", assetId: 12 } },
          dark: { base: { sourceKind: "asset", assetId: 12 } },
        },
      },
    };
    expect(locationsOf(value)).toHaveLength(2);
    expect(assetIdsOf(value)).toEqual([12, 12]);
  });

  it("reads nothing from a field that carries no Asset", () => {
    // A picture somebody removed leaves the field behind as null, and an id is a positive integer:
    // anything else would make the write fail on ownership validation for an Asset nobody named.
    expect(collectSiteCmsReferences({
      a: { assetId: null },
      b: { assetId: 0 },
      c: { assetId: -3 },
      d: { assetId: 1.5 },
      e: { assetId: "9" },
      f: { sourceKind: "url", sourceUrl: "https://example.test/a.png" },
    })).toEqual([]);
  });

  it("leaves the URI form to the string walk, so a body and a config agree on one target", () => {
    const references = collectSiteCmsReferences({
      markdown: `![Logo](${createPhiAssetUri(9)})`,
      config: { sourceKind: "asset", assetId: 9 },
    });
    expect(references).toHaveLength(2);
    expect(assetIdsOf({
      markdown: `![Logo](${createPhiAssetUri(9)})`,
      config: { sourceKind: "asset", assetId: 9 },
    })).toEqual([9, 9]);
  });

  it("does not mistake a field of a Page reference for an Asset", () => {
    expect(collectSiteCmsReferences({ target: { pageScopeId: 42 } })).toEqual([]);
  });
});

/*
 * The Theme is Site wide -- one Scope per Site, a key without an Area prefix -- and it is the carrier
 * nothing indexed. Its draft save is where a Module's ground becomes an Asset of this Site, so it is
 * also where the reference has to be registered, in the transaction that persists the revision.
 */
describe("The Theme is a reference source of its own", () => {
  /*
   * The Theme writes through the revision machine it shares with the Navigation, so the source kind is
   * the one its descriptor names and the shared save is what indexes the Draft it inserts.
   */
  it("is indexed under the Theme's own source kind", async () => {
    const scopes = await read("src/db/site-revision-scopes.ts");
    const theme = /theme: \{[\s\S]*?\n {2}\},\n/u.exec(scopes);
    expect(theme, "the Theme descriptor stays findable").not.toBeNull();
    expect(theme![0]).toMatch(/referenceSourceKind: PhiCmsReferenceSourceKind\.Theme/u);
    const save = /export async function saveSiteKeyedDraftRevisionWithDb[\s\S]*?\n\}\n/u.exec(scopes);
    expect(save, "the shared Draft save stays findable").not.toBeNull();
    // After the insert, under the revision it inserted.
    expect(save![0].indexOf("insertSiteRevisionWithDb")).toBeLessThan(
      save![0].indexOf("replaceSiteRevisionReferencesWithDb"),
    );
    expect(save![0]).toMatch(/revisionId: revision\.id,\s*references: input\.references/u);
  });

  it("is written by the Theme draft save, before the commit", async () => {
    const source = await read("src/db/site-theme.ts");
    const fn = /export async function saveSiteThemeDraftRevision[\s\S]*?\n\}\n/u.exec(source);
    expect(fn, "the Theme write stays findable").not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/saveSiteKeyedDraftRevisionWithDb\(client, THEME,/u);
    expect(body).toMatch(/references: collectSiteCmsReferences\(tree\)/u);
    // Inside the transaction body, which commits only after it returns.
    const transaction = body.indexOf("withTransaction(async (client) => {");
    expect(transaction).toBeGreaterThan(-1);
    expect(transaction).toBeLessThan(body.indexOf("saveSiteKeyedDraftRevisionWithDb"));
  });

  it("is kept by the Theme publish, which only makes the Draft live whose save indexed it", async () => {
    const source = await read("src/db/site-theme.ts");
    const fn = /export async function publishSiteThemeRevision[\s\S]*?\n\}\n/u.exec(source);
    expect(fn, "the Theme publish stays findable").not.toBeNull();
    const body = fn![0];
    // The Working Draft guard lives in the shared selection, so no other revision reaches this point.
    expect(body).toMatch(/selectSiteKeyedRevisionForPublishWithDb\(client, THEME,/u);
    expect(body).not.toMatch(/replaceSiteRevisionReferencesWithDb/u);
  });

  it("carries no Area, because a Site-wide Scope has none to resolve a Page in", async () => {
    const source = await read("src/db/site-theme.ts");
    expect(source).not.toMatch(/targetAreaId/u);
  });

  it("persists under the fifth source kind the schema allows", async () => {
    const schema = await read("scripts/sql/001_create_phis.pgsql");
    expect(schema).toMatch(/site_cms_references_source_kind_check CHECK \(source_kind IN \(1, 2, 3, 4, 5\)\)/u);
  });

  it("is reconciled against the Theme Scope's own pointers where the guard reads", async () => {
    const references = await read("src/db/site-cms-references.ts");
    expect(references).toMatch(/LEFT JOIN phis\.site_theme_scopes theme_scope/u);
    expect(references).toMatch(/ref\.source_kind = 5 AND ref\.source_revision_id IN \(\s*theme_scope\.published_revision_id, theme_scope\.working_draft_revision_id\)/u);
    // The guard names the source it found, so a blocked deletion says the Theme is what holds it.
    expect(await read("src/lib/media-delete-guard.ts")).toMatch(/"theme"/u);
  });
});

/*
 * An Area Scope points at three revisions, not two. The Module draft is the one a Module writes when
 * somebody edits what it contributes, and a reader that only knows the other two reads every reference
 * of that draft as the residue of a discarded one.
 */
describe("An Area's Module draft is a live source", () => {
  it("is reconciled by both readers of the index", async () => {
    // The Asset query the delete guard reads by, and the count behind a path change: one rule, so it
    // has to be the same three pointers in both places.
    const references = await read("src/db/site-cms-references.ts");
    const clause = /area_scope\.published_revision_id, area_scope\.working_draft_revision_id,\s*area_scope\.working_module_draft_revision_id/gu;
    expect(references.match(clause) ?? []).toHaveLength(2);
  });

  it("has its references rewritten when the structure publish merges the published config back in", async () => {
    const source = await read("src/db/site-pages.ts");
    const fn = /export async function publishSiteAreaRevision[\s\S]*?\n\}\n/u.exec(source);
    expect(fn, "the Area publish stays findable").not.toBeNull();
    const body = fn![0];
    expect(body).toMatch(/references: collectSiteCmsReferences\(materializedTree, \{ targetAreaId: input\.areaMask \}\)/u);
    // After the merge, so the rows describe the tree that was published rather than the draft's copy.
    expect(body.indexOf("mergePhiAreaTreeForPublish")).toBeLessThan(body.indexOf("replaceSiteCmsReferencesWithDb"));
    // Inside the transaction body, which commits only after it returns.
    const transaction = body.indexOf("withTransaction(async (client) => {");
    expect(transaction).toBeGreaterThan(-1);
    expect(transaction).toBeLessThan(body.indexOf("replaceSiteCmsReferencesWithDb"));
  });
});
