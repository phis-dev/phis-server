import { describe, expect, it } from "vitest";

import { listPhisAddonRowsReferencingMediaAsset, type PhisAddonMediaReferenceColumn } from "./server-addon-media-references.mts";

const cover: PhisAddonMediaReferenceColumn = {
  addonId: "@acme/shop", packageName: "@acme/shop", schemaName: "phis_addon_acme_shop", table: "offerings", column: "cover_asset_id", primaryKey: ["id"],
};
const gallery: PhisAddonMediaReferenceColumn = {
  addonId: "@acme/shop", packageName: "@acme/shop", schemaName: "phis_addon_acme_shop", table: "gallery", column: "asset_id", primaryKey: ["offering_id", "position"],
};
const pending: PhisAddonMediaReferenceColumn = {
  addonId: "@acme/next", packageName: "@acme/next", schemaName: "phis_addon_acme_next", table: "icons", column: "icon", primaryKey: ["id"],
};

function db(present: number[], rows: { source: number; row_id: string }[] = []) {
  const statements: { text: string; values: readonly unknown[] }[] = [];
  return {
    statements,
    query: async (text: string, values?: readonly unknown[]) => {
      statements.push({ text, values: values ?? [] });
      return { rows: statements.length === 1 ? present.map((ord) => ({ ord: String(ord) })) : rows };
    },
  };
}

/*
 * The reader behind the guard's `addon` scope. A descriptor says which columns should exist; the catalog
 * says which do, and only those are read -- an upgrade whose migration is pending must not turn every
 * delete into a missing-relation error.
 */
describe("Add-on rows naming a Media Asset", () => {
  it("asks nothing where no installed Add-on has such a column", async () => {
    const connection = db([]);
    await expect(listPhisAddonRowsReferencingMediaAsset(connection as never, { siteId: 3, assetId: 9, columns: [] })).resolves.toEqual([]);
    expect(connection.statements).toHaveLength(0);
  });

  it("asks the catalog which columns exist and reads those alone, in one statement, on this Site and Asset", async () => {
    const connection = db([1, 2], [{ source: 0, row_id: "4" }, { source: 1, row_id: "4,2" }]);
    const rows = await listPhisAddonRowsReferencingMediaAsset(connection as never, { siteId: 3, assetId: 9, columns: [cover, gallery, pending] });
    expect(connection.statements).toHaveLength(2);
    const [catalog, read] = connection.statements;
    expect(catalog!.values).toEqual([
      ["phis_addon_acme_shop", "phis_addon_acme_shop", "phis_addon_acme_next"],
      ["offerings", "gallery", "icons"],
      ["cover_asset_id", "asset_id", "icon"],
    ]);
    expect(catalog!.text).toMatch(/to_regclass\(format\('%I\.%I', c\.schema_name, c\.table_name\)\)/u);
    expect(read!.values).toEqual([3, 9]);
    expect(read!.text).toContain(`FROM "phis_addon_acme_shop"."offerings"\n      WHERE "site_id" = $1 AND "cover_asset_id" = $2`);
    expect(read!.text).toContain(`concat_ws(',', "offering_id"::text, "position"::text)`);
    expect(read!.text).toMatch(/UNION ALL/u);
    expect(read!.text).not.toContain("icons");
    expect(rows).toEqual([{ source: cover, rowId: "4" }, { source: gallery, rowId: "4,2" }]);
  });

  it("reads nothing where none of the columns exists yet", async () => {
    const connection = db([]);
    await expect(listPhisAddonRowsReferencingMediaAsset(connection as never, { siteId: 3, assetId: 9, columns: [pending] })).resolves.toEqual([]);
    expect(connection.statements).toHaveLength(1);
  });

  it("quotes what a descriptor names", async () => {
    const odd = { ...cover, table: 'we"ird', column: 'co"l' };
    const connection = db([1]);
    await listPhisAddonRowsReferencingMediaAsset(connection as never, { siteId: 3, assetId: 9, columns: [odd] });
    expect(connection.statements[1]!.text).toContain(`"phis_addon_acme_shop"."we""ird"`);
    expect(connection.statements[1]!.text).toContain(`"co""l" = $2`);
  });
});
