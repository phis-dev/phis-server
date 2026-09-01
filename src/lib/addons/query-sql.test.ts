import { describe, expect, it } from "vitest";

import { compilePhiServerAddonQueries } from "./query-sql.ts";
import { validatePhiServerAddonQueryCatalog } from "./query-descriptor.ts";
import type {
  PhiServerAddonQueryCatalog,
  PhiServerAddonSchemaDescriptor,
} from "./contract.ts";

/**
 * What a declared query becomes, and what it refuses to become.
 *
 * The statements are asserted as text because that text is the contract with the operator: `phis-cli`
 * is meant to be able to print every statement an installed Add-on can run, and a change here is a
 * change to what an Add-on is able to do.
 */

const SCHEMA = "phis_addon_acme_shop";

const schema: PhiServerAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "listing",
      siteScoped: true,
      groupScoped: true,
      ownerScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "title", type: "string", maxLength: 200 },
        { name: "state", type: "string", maxLength: 32 },
        { name: "retired_at", type: "instant", nullable: true },
      ],
      primaryKey: ["id"],
    },
  ],
};

const catalog: PhiServerAddonQueryCatalog = {
  parameters: {
    mine: [{ name: "state", type: "text" }],
    add: [{ name: "title", type: "text" }, { name: "group_id", type: "integer" }],
    rename: [{ name: "id", type: "bigInteger" }, { name: "title", type: "text" }],
    drop: [{ name: "id", type: "bigInteger" }],
  },
  queries: [
    {
      kind: "select",
      name: "mine",
      table: "listing",
      columns: ["id", "title"],
      where: {
        kind: "all",
        conditions: [
          { kind: "compare", column: "state", operator: "=", value: { kind: "parameter", name: "state" } },
          { kind: "isNull", column: "retired_at" },
        ],
      },
      orderBy: [{ column: "id", direction: "desc" }],
      limit: 50,
    },
    {
      kind: "insert",
      name: "add",
      table: "listing",
      values: [
        { column: "title", value: { kind: "parameter", name: "title" } },
        { column: "state", value: { kind: "literal", value: "draft" } },
      ],
      groupParameter: "group_id",
    },
    {
      kind: "update",
      name: "rename",
      table: "listing",
      set: [{ column: "title", value: { kind: "parameter", name: "title" } }],
      idParameter: "id",
    },
    { kind: "delete", name: "drop", table: "listing", idParameter: "id" },
  ],
};

function compiled() {
  return compilePhiServerAddonQueries(SCHEMA, schema, catalog);
}

function validate(value: unknown) {
  const issues: string[] = [];
  const result = validatePhiServerAddonQueryCatalog(value, schema, "queries", issues);
  return { result, issues };
}

describe("compiling a declared query", () => {
  it("puts the Site filter into a select the Add-on never wrote", () => {
    const query = compiled().get("mine")!;
    expect(query.sql).toBe(
      'SELECT "id", "title" FROM "phis_addon_acme_shop"."listing" ' +
      'WHERE "site_id" = $1 AND ("state" = $2 AND "retired_at" IS NULL) ' +
      'ORDER BY "id" DESC LIMIT $3',
    );
    expect(query.bindings).toEqual([
      { from: "site" },
      { from: "parameter", name: "state" },
      { from: "limit" },
    ]);
  });

  it("writes the scope columns itself on insert, and the Add-on's values after them", () => {
    const query = compiled().get("add")!;
    expect(query.sql).toContain('("site_id", "group_id", "owner_user_id", "title", "state")');
    expect(query.sql).toContain("VALUES ($1, $2, $3, $4, $5)");
    expect(query.bindings).toEqual([
      { from: "site" },
      { from: "group" },
      { from: "actor" },
      { from: "parameter", name: "title" },
      { from: "literal", value: "draft" },
    ]);
  });

  it("addresses one row and carries the Site with it", () => {
    expect(compiled().get("rename")!.sql).toBe(
      'UPDATE "phis_addon_acme_shop"."listing" SET "title" = $1 WHERE "id" = $2 AND "site_id" = $3',
    );
    expect(compiled().get("drop")!.sql).toBe(
      'DELETE FROM "phis_addon_acme_shop"."listing" WHERE "id" = $1 AND "site_id" = $2',
    );
  });

  it("returns the scope columns alongside the declared ones when none are named", () => {
    const everything = compilePhiServerAddonQueries(SCHEMA, schema, {
      parameters: { all: [] },
      queries: [{ kind: "select", name: "all", table: "listing", limit: 5 }],
    });
    expect(everything.get("all")!.sql).toContain(
      'SELECT "site_id", "group_id", "owner_user_id", "id", "title", "state", "retired_at"',
    );
  });

  it("caps a limit above the ceiling instead of trusting it", () => {
    const overreaching = compilePhiServerAddonQueries(SCHEMA, schema, {
      parameters: { all: [] },
      queries: [{ kind: "select", name: "all", table: "listing", limit: 10_000 }],
    });
    expect(overreaching.get("all")!.paging!.limit).toBe(500);
  });
});

const pagingSchema: PhiServerAddonSchemaDescriptor = {
  descriptorVersion: 1,
  version: 1,
  tables: [
    {
      name: "offering",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "kind", type: "string", maxLength: 64 },
        { name: "updated_at", type: "instant" },
        { name: "withdrawn_at", type: "instant", nullable: true },
      ],
      primaryKey: ["id"],
    },
  ],
};

function paged(descriptor: Record<string, unknown>, parameters: unknown[] = []) {
  return compilePhiServerAddonQueries(SCHEMA, pagingSchema, {
    parameters: { listing: parameters },
    queries: [{ kind: "select", name: "listing", table: "offering", limit: 25, ...descriptor }],
  } as unknown as PhiServerAddonQueryCatalog).get("listing")!;
}

describe("paging a declared select", () => {
  it("finishes the Add-on's ordering with the primary key, so the order is total", () => {
    const query = paged({ orderBy: [{ column: "updated_at", direction: "desc" }] });
    expect(query.sql).toContain('ORDER BY "updated_at" DESC, "id" ASC');
    expect(query.paging!.ordering).toEqual([
      { column: "updated_at", direction: "desc" },
      { column: "id", direction: "asc" },
    ]);
  });

  it("orders by the primary key alone when the Add-on named no order at all", () => {
    expect(paged({}).sql).toContain('ORDER BY "id" ASC');
  });

  it("does not name the primary key twice when the Add-on already ordered by it", () => {
    const query = paged({ orderBy: [{ column: "id", direction: "desc" }] });
    expect(query.sql).toContain('ORDER BY "id" DESC LIMIT');
    expect(query.paging!.ordering).toHaveLength(1);
  });

  it("continues a page by comparing against the last row, one column at a time", () => {
    const query = paged({ orderBy: [{ column: "updated_at", direction: "desc" }] });
    expect(query.paging!.sql).toContain(
      '("updated_at" < $2) OR ("updated_at" = $3 AND "id" > $4)',
    );
    expect(query.paging!.bindings).toEqual([
      { from: "site" },
      { from: "cursor", index: 0 },
      { from: "cursor", index: 0 },
      { from: "cursor", index: 1 },
      { from: "limit" },
    ]);
  });

  it("leaves the first page as the statement it would have been without paging", () => {
    const query = paged({ orderBy: [{ column: "updated_at", direction: "desc" }] });
    expect(query.sql).toContain('WHERE "site_id" = $1 ORDER BY');
    expect(query.bindings.some((binding) => binding.from === "cursor")).toBe(false);
  });

  it("switches a whenPresent filter off with a null rather than declaring a second query", () => {
    const query = paged(
      {
        where: {
          kind: "whenPresent",
          parameter: "kind",
          condition: {
            kind: "compare",
            column: "kind",
            operator: "=",
            value: { kind: "parameter", name: "kind" },
          },
        },
      },
      [{ name: "kind", type: "text", nullable: true }],
    );
    expect(query.sql).toContain('($2::TEXT IS NULL OR "kind" = $3)');
    expect(query.bindings.slice(1, 3)).toEqual([
      { from: "parameter", name: "kind" },
      { from: "parameter", name: "kind" },
    ]);
  });
});

describe("validating a declared query", () => {
  it("accepts the catalog above", () => {
    expect(validate(catalog).issues).toEqual([]);
  });

  it("lets a query filter on the scope columns it may not write", () => {
    const { issues } = validate({
      parameters: { mine: [] },
      queries: [{
        kind: "select", name: "mine", table: "listing", limit: 10,
        where: { kind: "compare", column: "owner_user_id", operator: "=", value: { kind: "actor" } },
      }],
    });
    expect(issues).toEqual([]);
  });

  it("refuses a column the Add-on never declared", () => {
    const { issues } = validate({
      parameters: { probe: [] },
      queries: [{
        kind: "select", name: "probe", table: "listing", limit: 1,
        where: { kind: "isNull", column: "secret" },
      }],
    });
    expect(issues.join("\n")).toMatch(/does not name a column of listing/);
  });

  it("refuses a parameter that was never declared", () => {
    const { issues } = validate({
      parameters: { probe: [] },
      queries: [{
        kind: "select", name: "probe", table: "listing", limit: 1,
        where: { kind: "compare", column: "title", operator: "=", value: { kind: "parameter", name: "nope" } },
      }],
    });
    expect(issues.join("\n")).toMatch(/names an undeclared parameter/);
  });

  it("refuses an Add-on writing one of Core's own columns", () => {
    const { issues } = validate({
      parameters: { add: [{ name: "owner", type: "integer" }] },
      queries: [{
        kind: "insert", name: "add", table: "listing", groupParameter: "owner",
        values: [{ column: "owner_user_id", value: { kind: "parameter", name: "owner" } }],
      }],
    });
    expect(issues.join("\n")).toMatch(/"owner_user_id", which Core writes itself/);
  });

  it("requires a group parameter on a group-scoped insert", () => {
    const { issues } = validate({
      parameters: { add: [{ name: "title", type: "text" }] },
      queries: [{
        kind: "insert", name: "add", table: "listing",
        values: [{ column: "title", value: { kind: "parameter", name: "title" } }],
      }],
    });
    expect(issues.join("\n")).toMatch(/groupParameter must name a declared parameter/);
  });

  it("refuses an unbounded read", () => {
    const { issues } = validate({
      parameters: { all: [] },
      queries: [{ kind: "select", name: "all", table: "listing" }],
    });
    expect(issues.join("\n")).toMatch(/limit must be an integer between 1 and 500/);
  });

  it("refuses a query against a table this Add-on does not own", () => {
    const { issues } = validate({
      parameters: { peek: [] },
      queries: [{ kind: "select", name: "peek", table: "user_accounts", limit: 1 }],
    });
    expect(issues.join("\n")).toMatch(/does not name a table this Add-on declares/);
  });

  it("refuses a catalog when the Add-on owns no tables at all", () => {
    const issues: string[] = [];
    validatePhiServerAddonQueryCatalog(catalog, null, "queries", issues);
    expect(issues.join("\n")).toMatch(/owns no tables to run them against/);
  });
});

describe("what paging refuses at validation", () => {
  function issuesFor(descriptor: Record<string, unknown>, parameters: unknown[] = []) {
    const issues: string[] = [];
    validatePhiServerAddonQueryCatalog(
      {
        parameters: { listing: parameters },
        queries: [{ kind: "select", name: "listing", table: "offering", limit: 25, ...descriptor }],
      },
      pagingSchema,
      "queries",
      issues,
    );
    return issues.join("\n");
  }

  it("refuses an ordering column that may be null", () => {
    expect(issuesFor({ orderBy: [{ column: "withdrawn_at", direction: "desc" }] }))
      .toMatch(/is nullable/);
  });

  it("accepts an ordering column that may not", () => {
    expect(issuesFor({ orderBy: [{ column: "updated_at", direction: "desc" }] })).toBe("");
  });

  it("refuses whenPresent on a parameter that cannot be absent", () => {
    const where = {
      kind: "whenPresent",
      parameter: "kind",
      condition: {
        kind: "compare",
        column: "kind",
        operator: "=",
        value: { kind: "parameter", name: "kind" },
      },
    };
    expect(issuesFor({ where }, [{ name: "kind", type: "text" }])).toMatch(/must be nullable/);
    expect(issuesFor({ where }, [{ name: "kind", type: "text", nullable: true }])).toBe("");
  });

  it("no longer offers an offset to page with", () => {
    expect(issuesFor({ offsetParameter: "skip" }, [{ name: "skip", type: "integer" }])).toBe("");
  });
});
