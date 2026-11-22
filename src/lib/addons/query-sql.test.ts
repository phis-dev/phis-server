import { describe, expect, it } from "vitest";

import { compilePhisAddonQueries } from "./query-sql.ts";
import { buildPhisAddonSchemaStatements } from "./schema-ddl.ts";
import { validatePhisAddonSchemaDescriptor } from "./schema-descriptor.ts";
import {
  phisAddonAuthorityBypasses,
  phisAddonUnindexedSearches,
  validatePhisAddonQueryCatalog,
} from "./query-descriptor.ts";
import type {
  PhisAddonQueryCatalog,
  PhisAddonSchemaDescriptor,
} from "./contract.ts";

/**
 * What a declared query becomes, and what it refuses to become.
 *
 * The statements are asserted as text because that text is the contract with the operator: `phis-cli`
 * is meant to be able to print every statement an installed Add-on can run, and a change here is a
 * change to what an Add-on is able to do.
 */

const SCHEMA = "phis_addon_acme_shop";

const schema: PhisAddonSchemaDescriptor = {
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

const catalog: PhisAddonQueryCatalog = {
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
  return compilePhisAddonQueries(SCHEMA, schema, catalog);
}

function validate(value: unknown) {
  const issues: string[] = [];
  const result = validatePhisAddonQueryCatalog(value, schema, "queries", issues);
  return { result, issues };
}

describe("compiling a declared query", () => {
  it("puts the Site filter into a select the Add-on never wrote", () => {
    const query = compiled().get("mine")!;
    expect(query.sql).toBe(
      'SELECT "id", "title", "id"::text AS "__phi_cursor_0" ' +
      'FROM "phis_addon_acme_shop"."listing" ' +
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
    expect(query.sql)
      .toContain('("site_id", "group_id", "owner_user_id", "created_by_user_id", "title", "state")');
    expect(query.sql).toContain("VALUES ($1, $2, $3, $4, $5, $6)");
    expect(query.bindings).toEqual([
      { from: "site" },
      { from: "group" },
      // Twice, and the same value: the owner is authority and may move, the author is history and does
      // not. They are one person until the first handover.
      { from: "actor" },
      { from: "actor" },
      { from: "parameter", name: "title" },
      { from: "literal", value: "draft" },
    ]);
  });

  it("addresses one row and carries the Site with it", () => {
    expect(compiled().get("rename")!.sql).toBe(
      'UPDATE "phis_addon_acme_shop"."listing" SET "title" = $1 WHERE "id" = $2 AND "site_id" = $3 ' +
      'RETURNING "id", "title", "state", "retired_at", "site_id", "group_id", "owner_user_id", "created_by_user_id"',
    );
    // The delete names its columns back, because after it has run there is nothing left to ask them of.
    expect(compiled().get("drop")!.sql).toBe(
      'DELETE FROM "phis_addon_acme_shop"."listing" WHERE "id" = $1 AND "site_id" = $2 ' +
      'RETURNING "id", "title", "state", "retired_at", "site_id", "group_id", "owner_user_id", "created_by_user_id"',
    );
  });

  it("returns the scope columns alongside the declared ones when none are named", () => {
    const everything = compilePhisAddonQueries(SCHEMA, schema, {
      parameters: { all: [] },
      queries: [{ kind: "select", name: "all", table: "listing", limit: 5 }],
    });
    expect(everything.get("all")!.sql).toContain(
      'SELECT "site_id", "group_id", "owner_user_id", "created_by_user_id", ' +
      '"id", "title", "state", "retired_at",',
    );
  });

  it("caps a limit above the ceiling instead of trusting it", () => {
    const overreaching = compilePhisAddonQueries(SCHEMA, schema, {
      parameters: { all: [] },
      queries: [{ kind: "select", name: "all", table: "listing", limit: 10_000 }],
    });
    expect(overreaching.get("all")!.paging!.limit).toBe(500);
  });
});

const pagingSchema: PhisAddonSchemaDescriptor = {
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
  return compilePhisAddonQueries(SCHEMA, pagingSchema, {
    parameters: { listing: parameters },
    queries: [{ kind: "select", name: "listing", table: "offering", limit: 25, ...descriptor }],
  } as unknown as PhisAddonQueryCatalog).get("listing")!;
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

describe("a select read in an order the call chooses", () => {
  const orderings = {
    orderings: {
      by_kind: [{ column: "kind", direction: "asc" }],
      by_update: [{ column: "updated_at", direction: "asc" }, { column: "kind", direction: "desc" }],
    },
    defaultOrdering: { key: "by_update", direction: "desc" },
  };

  it("compiles every declared order both ways round, the primary key turned with it", () => {
    const query = paged(orderings);
    const kind = query.paging!.orderings!.get("by_kind")!;
    expect(kind.asc.ordering).toEqual([{ column: "kind", direction: "asc" }, { column: "id", direction: "asc" }]);
    expect(kind.desc.ordering).toEqual([{ column: "kind", direction: "desc" }, { column: "id", direction: "desc" }]);
    expect(kind.asc.first.sql).toContain('ORDER BY "kind" ASC, "id" ASC LIMIT');
    expect(kind.desc.first.sql).toContain('ORDER BY "kind" DESC, "id" DESC LIMIT');
    // A mixed order is reversed entry by entry, and continued the way it now runs.
    const update = query.paging!.orderings!.get("by_update")!;
    expect(update.desc.first.sql).toContain('ORDER BY "updated_at" DESC, "kind" ASC, "id" DESC LIMIT');
    expect(update.desc.next.sql).toContain(
      '("updated_at" < $2) OR ("updated_at" = $3 AND "kind" > $4) OR ("updated_at" = $5 AND "kind" = $6 AND "id" < $7)',
    );
    expect(kind.desc.next.bindings.filter((binding) => binding.from === "cursor")).toHaveLength(3);
  });

  it("reads a call that names none in its default order, which is one of the compiled ones", () => {
    const query = paged(orderings);
    const chosen = query.paging!.orderings!.get("by_update")!.desc;
    expect(query.sql).toBe(chosen.first.sql);
    expect(query.paging!.sql).toBe(chosen.next.sql);
    expect(query.paging!.ordering).toEqual(chosen.ordering);
  });

  it("changes nothing for a select that declares a single order", () => {
    const query = paged({ orderBy: [{ column: "updated_at", direction: "desc" }] });
    expect(query.paging!.orderings).toBeUndefined();
    expect(query.sql).toContain('ORDER BY "updated_at" DESC, "id" ASC');
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
    validatePhisAddonQueryCatalog(catalog, null, "queries", issues);
    expect(issues.join("\n")).toMatch(/owns no tables to run them against/);
  });
});

describe("searching text", () => {
  const searchSchema: PhisAddonSchemaDescriptor = {
    descriptorVersion: 1,
    version: 1,
    tables: [
      {
        name: "offering",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "title", type: "string", maxLength: 200 },
          { name: "rank", type: "integer" },
        ],
        primaryKey: ["id"],
        indexes: [{ name: "by_title", kind: "text", columns: ["title"] }],
      },
    ],
  };

  const searchCatalog = {
    parameters: { find: [{ name: "q", type: "text" }] },
    queries: [
      {
        kind: "select",
        name: "find",
        table: "offering",
        where: { kind: "contains", column: "title", value: { kind: "parameter", name: "q" } },
        limit: 25,
      },
    ],
  } as unknown as PhisAddonQueryCatalog;

  it("escapes the value, so a per cent sign is a character and not a wildcard", () => {
    const sql = compilePhisAddonQueries(SCHEMA, searchSchema, searchCatalog).get("find")!.sql;
    expect(sql).toContain(
      `"title" ILIKE ('%' || replace(replace(replace($2, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')`,
    );
  });

  const flagsCatalog = (match: "all" | "none", mask: unknown) => ({
    parameters: { find: [] },
    queries: [{
      kind: "select",
      name: "find",
      table: "offering",
      where: { kind: "flags", column: "rank", mask, match },
      limit: 25,
    }],
  }) as unknown as PhisAddonQueryCatalog;

  it("tests the bits of a flags column, every bit or none", () => {
    const literal = { kind: "literal", value: 1 };
    const all = compilePhisAddonQueries(SCHEMA, searchSchema, flagsCatalog("all", literal)).get("find")!.sql;
    const none = compilePhisAddonQueries(SCHEMA, searchSchema, flagsCatalog("none", literal)).get("find")!.sql;
    expect(all).toMatch(/\("rank" & \$\d+\) = \$\d+/);
    expect(none).toMatch(/\("rank" & \$\d+\) = 0/);
  });

  it("refuses a mask of no bits, and a column that is not an integer", () => {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(flagsCatalog("none", { kind: "literal", value: 0 }), searchSchema, "queries", issues);
    expect(issues.join("\n")).toMatch(/positive integer/);
    const onText: string[] = [];
    validatePhisAddonQueryCatalog({
      ...flagsCatalog("all", { kind: "literal", value: 2 }),
      queries: [{ ...flagsCatalog("all", { kind: "literal", value: 2 }).queries[0], where: { kind: "flags", column: "title", mask: { kind: "literal", value: 2 }, match: "all" } }],
    } as unknown as PhisAddonQueryCatalog, searchSchema, "queries", onText);
    expect(onText.join("\n")).toMatch(/is not an integer column/);
  });

  it("refuses to search a column that does not hold text", () => {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(
      {
        parameters: { find: [{ name: "q", type: "text" }] },
        queries: [{
          kind: "select",
          name: "find",
          table: "offering",
          where: { kind: "contains", column: "rank", value: { kind: "parameter", name: "q" } },
          limit: 25,
        }],
      },
      searchSchema,
      "queries",
      issues,
    );
    expect(issues.join("\n")).toMatch(/is not a text column/);
  });

  it("names a search that nothing indexes, and stays quiet about one that is", () => {
    expect(phisAddonUnindexedSearches(searchSchema, searchCatalog)).toEqual([]);
    const withoutIndex = {
      ...searchSchema,
      tables: searchSchema.tables.map((table) => ({ ...table, indexes: [] })),
    };
    expect(phisAddonUnindexedSearches(withoutIndex, searchCatalog)).toEqual([
      { query: "find", table: "offering", column: "title" },
    ]);
  });

  it("sees a search wrapped in whenPresent, which is how a listing writes one", () => {
    const optional = {
      parameters: { find: [{ name: "q", type: "text", nullable: true }] },
      queries: [{
        kind: "select",
        name: "find",
        table: "offering",
        where: {
          kind: "whenPresent",
          parameter: "q",
          condition: { kind: "contains", column: "title", value: { kind: "parameter", name: "q" } },
        },
        limit: 25,
      }],
    } as unknown as PhisAddonQueryCatalog;
    const withoutIndex = {
      ...searchSchema,
      tables: searchSchema.tables.map((table) => ({ ...table, indexes: [] })),
    };
    expect(phisAddonUnindexedSearches(withoutIndex, optional)).toHaveLength(1);
  });

  it("builds a trigram index for a text index, and an ordinary one otherwise", () => {
    const statements = buildPhisAddonSchemaStatements(SCHEMA, searchSchema);
    const text = statements.find((entry) => entry.summary.includes("text search"))!;
    expect(text.sql).toContain('USING gin ("title" gin_trgm_ops)');
  });

  it("refuses a text index that is unique, spans columns, or names a number", () => {
    const issues: string[] = [];
    validatePhisAddonSchemaDescriptor(
      {
        ...searchSchema,
        tables: [{
          ...searchSchema.tables[0]!,
          indexes: [
            { name: "a", kind: "text", columns: ["title"], unique: true },
            { name: "b", kind: "text", columns: ["title", "rank"] },
            { name: "c", kind: "text", columns: ["rank"] },
          ],
        }],
      },
      "schema",
      issues,
    );
    const text = issues.join("\n");
    expect(text).toMatch(/cannot be unique/);
    expect(text).toMatch(/exactly one column/);
    expect(text).toMatch(/does not hold text/);
  });
});

describe("what paging refuses at validation", () => {
  function issuesFor(
    descriptor: Record<string, unknown>,
    parameters: unknown[] = [],
    schema: PhisAddonSchemaDescriptor = pagingSchema,
  ) {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(
      {
        parameters: { listing: parameters },
        queries: [{ kind: "select", name: "listing", table: "offering", limit: 25, ...descriptor }],
      },
      schema,
      "queries",
      issues,
    );
    return issues.join("\n");
  }

  it("refuses an ordering column that may be null", () => {
    expect(issuesFor({ orderBy: [{ column: "withdrawn_at", direction: "desc" }] }))
      .toMatch(/is nullable/);
  });

  it("refuses Core's nullable columns as paging columns too: the owner and a slot's mirror", () => {
    // Neither is in the declared list, yet both are NULL for real rows: an owner whose account is gone,
    // a slot with no file in it.
    const scoped: PhisAddonSchemaDescriptor = {
      ...pagingSchema,
      tables: [{
        ...pagingSchema.tables[0]!,
        ownerScoped: true,
        assets: [{
          name: "cover",
          cardinality: "one",
          maxBytes: 4096,
          contentTypes: ["image/png"],
          mirrorColumn: "cover_path",
        }],
      }],
    };
    for (const column of ["owner_user_id", "cover_path"]) {
      expect(issuesFor({ orderBy: [{ column, direction: "asc" }] }, [], scoped)).toMatch(/is nullable/);
      expect(issuesFor({
        kind: "aggregate",
        aggregates: [{ name: "n", function: "count" }],
        groupBy: [column],
      }, [], scoped)).toMatch(/names nullable column/);
    }
    // Where the query's own where leaves the nulls out there is no null group, and the paging holds.
    const notNull = { kind: "isNull", column: "cover_path", negated: true };
    expect(issuesFor({
      kind: "aggregate", aggregates: [{ function: "count", as: "n" }], groupBy: ["cover_path"], limit: 50,
      where: notNull,
    }, [], scoped)).toBe("");
    expect(issuesFor({
      kind: "aggregate", aggregates: [{ function: "count", as: "n" }], groupBy: ["cover_path"], limit: 50,
      where: { kind: "all", conditions: [{ kind: "isNull", column: "owner_user_id", negated: true }, notNull] },
    }, [], scoped)).toBe("");
    expect(issuesFor({
      kind: "aggregate", aggregates: [{ function: "count", as: "n" }], groupBy: ["cover_path"], limit: 50,
      where: { kind: "any", conditions: [notNull, { kind: "isNull", column: "cover_path" }] },
    }, [], scoped)).toMatch(/names nullable column/);
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

  describe("the orders a call may choose between", () => {
    const valid = {
      orderings: { by_kind: [{ column: "kind", direction: "asc" }], by_update: [{ column: "updated_at", direction: "asc" }] },
      defaultOrdering: { key: "by_update", direction: "desc" },
    };

    it("accepts orders over columns that may not be null, with one of them the default", () => {
      expect(issuesFor(valid)).toBe("");
    });

    it("holds every one of them to the rules of orderBy", () => {
      expect(issuesFor({ ...valid, orderings: { ...valid.orderings, by_withdrawal: [{ column: "withdrawn_at", direction: "asc" }] } }))
        .toMatch(/orderings\.by_withdrawal\[0\]\.column "withdrawn_at" is nullable/);
      expect(issuesFor({ ...valid, orderings: { ...valid.orderings, by_secret: [{ column: "secret", direction: "asc" }] } }))
        .toMatch(/orderings\.by_secret\[0\]\.column does not name a column/);
      expect(issuesFor({ ...valid, orderings: { ...valid.orderings, by_kind: [{ column: "kind", direction: "up" }] } }))
        .toMatch(/orderings\.by_kind\[0\]\.direction must be "asc" or "desc"/);
      expect(issuesFor({ ...valid, orderings: { ...valid.orderings, by_nothing: [] } }))
        .toMatch(/orderings\.by_nothing must name at least one column/);
      expect(issuesFor({ ...valid, orderings: { ...valid.orderings, "By Kind": [{ column: "kind", direction: "asc" }] } }))
        .toMatch(/orderings key "By Kind" is invalid/);
      expect(issuesFor({ ...valid, orderings: {} })).toMatch(/orderings must be an object naming at least one ordering/);
    });

    it("refuses a default that names none of them, or none at all", () => {
      expect(issuesFor({ ...valid, defaultOrdering: { key: "by_title", direction: "asc" } })).toMatch(/defaultOrdering\.key does not name one of orderings/);
      expect(issuesFor({ ...valid, defaultOrdering: { key: "by_kind", direction: "sideways" } })).toMatch(/defaultOrdering\.direction must be/);
      expect(issuesFor({ orderings: valid.orderings })).toMatch(/defaultOrdering must name one of orderings/);
      expect(issuesFor({ defaultOrdering: valid.defaultOrdering })).toMatch(/this query declares none/);
    });

    it("refuses orderBy beside them: the default is the query's own order", () => {
      expect(issuesFor({ ...valid, orderBy: [{ column: "kind", direction: "asc" }] })).toMatch(/states both orderBy and orderings/);
    });

    it("refuses them on anything but a select", () => {
      expect(issuesFor({
        kind: "aggregate", aggregates: [{ function: "count", as: "n" }], groupBy: ["kind"], limit: 50, ...valid,
      })).toMatch(/belong to a select/);
    });
  });
});

describe("a query guarded by a role", () => {
  const ownedSchema: PhisAddonSchemaDescriptor = {
    descriptorVersion: 1,
    version: 1,
    tables: [
      {
        name: "category",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "label", type: "string", maxLength: 64 },
        ],
        primaryKey: ["id"],
      },
    ],
  };

  function issuesFor(query: Record<string, unknown>, roles: string[]) {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(
      {
        parameters: { q: [{ name: "id", type: "bigInteger" }, { name: "label", type: "text" }] },
        queries: [{ name: "q", table: "category", ...query }],
      },
      ownedSchema,
      "queries",
      issues,
      new Set(roles),
    );
    return issues.join("\n");
  }

  const rename = {
    kind: "update",
    set: [{ column: "label", value: { kind: "parameter", name: "label" } }],
    idParameter: "id",
  };

  it("refuses to change a table nobody owns without naming a role", () => {
    expect(issuesFor(rename, ["curator"])).toMatch(/must state requiresRole/);
  });

  it("accepts the same query once it names one", () => {
    expect(issuesFor({ ...rename, requiresRole: "curator" }, ["curator"])).toBe("");
  });

  it("refuses a role the Add-on does not declare", () => {
    expect(issuesFor({ ...rename, requiresRole: "invented" }, ["curator"]))
      .toMatch(/does not name a role this Add-on declares/);
  });

  it("leaves an owned table alone: the ladder is authority enough to be allowed to try", () => {
    const owned = {
      ...ownedSchema,
      tables: ownedSchema.tables.map((table) => ({ ...table, ownerScoped: true })),
    };
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(
      {
        parameters: { q: [{ name: "id", type: "bigInteger" }, { name: "label", type: "text" }] },
        queries: [{ name: "q", table: "category", ...rename }],
      },
      owned,
      "queries",
      issues,
      new Set(),
    );
    expect(issues).toEqual([]);
  });
});

/**
 * Writing a document, and the two ways that could quietly go wrong.
 *
 * A `json` column had no way to be written at all before this parameter type: every literal is a
 * scalar, and every other parameter type is one too. What makes it safe to add is that it can only be
 * written -- a document that could be compared would need paths, operators and an index vocabulary,
 * which is a second query language growing inside the one this file exists to keep small.
 */
describe("writing a json column", () => {
  const documentSchema: PhisAddonSchemaDescriptor = {
    descriptorVersion: 1,
    version: 1,
    tables: [
      {
        name: "offering",
        siteScoped: true,
        ownerScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "name", type: "string", maxLength: 200 },
          { name: "attributes", type: "json", nullable: true },
        ],
        primaryKey: ["id"],
      },
    ],
  };

  function check(value: unknown) {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(value, documentSchema, "queries", issues, new Set());
    return issues.join("\n");
  }

  const describeCatalog: PhisAddonQueryCatalog = {
    parameters: {
      describe: [
        { name: "id", type: "bigInteger" },
        { name: "attributes", type: "json", nullable: true },
      ],
    },
    queries: [{
      kind: "update",
      name: "describe",
      table: "offering",
      set: [{ column: "attributes", value: { kind: "parameter", name: "attributes" } }],
      idParameter: "id",
    }],
  };

  it("accepts a document written into the column declared for one", () => {
    expect(check(describeCatalog)).toBe("");
  });

  it("casts the placeholder, because the value arrives as JSON text and the column is JSONB", () => {
    const query = compilePhisAddonQueries(SCHEMA, documentSchema, describeCatalog).get("describe")!;
    expect(query.sql).toContain('"attributes" = $1::JSONB');
    // And says so on the binding, because that is where the value gets serialised.
    expect(query.bindings[0]).toEqual({ from: "parameter", name: "attributes", json: true });
  });

  it("refuses to filter on a document", () => {
    expect(check({
      parameters: { probe: [{ name: "attributes", type: "json", nullable: true }] },
      queries: [{
        kind: "select", name: "probe", table: "offering", limit: 10,
        where: {
          kind: "compare", column: "attributes", operator: "=",
          value: { kind: "parameter", name: "attributes" },
        },
      }],
    })).toMatch(/filters on the json parameter "attributes"/);
  });

  it("refuses to search a document, whichever way it is reached", () => {
    expect(check({
      parameters: { probe: [{ name: "attributes", type: "json", nullable: true }] },
      queries: [{
        kind: "select", name: "probe", table: "offering", limit: 10,
        where: {
          kind: "whenPresent",
          parameter: "attributes",
          condition: {
            kind: "contains", column: "name",
            value: { kind: "parameter", name: "attributes" },
          },
        },
      }],
    })).toMatch(/filters on the json parameter "attributes"/);
  });

  it("refuses a document as a list, because a list is for matching", () => {
    expect(check({
      parameters: { probe: [{ name: "attributes", type: "json", list: true }] },
      queries: [{
        kind: "select", name: "probe", table: "offering", limit: 10,
        where: { kind: "in", column: "name", parameter: "attributes" },
      }],
    })).toMatch(/json cannot also be a list/);
  });

  it("refuses a scalar written into a document column", () => {
    // Stored as a bare JSON string, read back as a string, and every reader expecting an object breaks.
    expect(check({
      parameters: { probe: [{ name: "id", type: "bigInteger" }] },
      queries: [{
        kind: "update", name: "probe", table: "offering", idParameter: "id",
        set: [{ column: "attributes", value: { kind: "literal", value: "{}" } }],
      }],
    })).toMatch(/which is json, from something other than a json parameter/);
  });

  it("refuses a document written into a column that is not one", () => {
    // The other direction: the serialised text would be stored and read back as a string.
    expect(check({
      parameters: {
        probe: [{ name: "id", type: "bigInteger" }, { name: "doc", type: "json" }],
      },
      queries: [{
        kind: "update", name: "probe", table: "offering", idParameter: "id",
        set: [{ column: "name", value: { kind: "parameter", name: "doc" } }],
      }],
    })).toMatch(/writes the json parameter into "name", which is string/);
  });
});

/**
 * Adding to a column, and an update that happens only while a condition holds.
 *
 * The two together are what reading, deciding and writing in a handler cannot be: one step. A stock
 * count read in the handler and written back loses every change that came between, and an order marked
 * paid after a separate check is marked paid twice by a second delivery of the same event.
 */
describe("an update that adds, and one that is guarded", () => {
  const stockSchema: PhisAddonSchemaDescriptor = {
    descriptorVersion: 1,
    version: 1,
    tables: [
      {
        name: "listing",
        siteScoped: true,
        ownerScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "title", type: "string", maxLength: 200 },
          { name: "stock", type: "integer", nullable: true },
          { name: "sold", type: "bigInteger" },
          { name: "rank", type: "smallInteger" },
          { name: "flags", type: "integer" },
          { name: "attributes", type: "json", nullable: true },
          { name: "opened_at", type: "instant", nullable: true },
        ],
        primaryKey: ["id"],
      },
    ],
  };

  const reserveCatalog: PhisAddonQueryCatalog = {
    parameters: {
      reserve: [
        { name: "id", type: "bigInteger" },
        { name: "quantity", type: "integer" },
        { name: "taken", type: "integer" },
      ],
      open: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "update",
        name: "reserve",
        table: "listing",
        set: [
          { column: "stock", add: { kind: "parameter", name: "taken" } },
          { column: "sold", add: { kind: "parameter", name: "quantity" } },
        ],
        idParameter: "id",
        where: {
          kind: "compare", column: "stock", operator: ">=",
          value: { kind: "parameter", name: "quantity" },
        },
      },
      {
        kind: "update",
        name: "open",
        table: "listing",
        set: [
          { column: "flags", add: { kind: "literal", value: 4 } },
          { column: "opened_at", value: { kind: "now" } },
        ],
        idParameter: "id",
        where: { kind: "flags", column: "flags", mask: { kind: "literal", value: 4 }, match: "none" },
      },
    ],
  };

  function check(value: unknown) {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(value, stockSchema, "queries", issues, new Set());
    return issues.join("\n");
  }

  function update(set: unknown[], parameters: unknown[] = [], extra: Record<string, unknown> = {}) {
    return {
      parameters: { probe: [{ name: "id", type: "bigInteger" }, ...parameters] },
      queries: [{ kind: "update", name: "probe", table: "listing", idParameter: "id", set, ...extra }],
    };
  }

  it("accepts adding to integer columns, with a guard beside it", () => {
    expect(check(reserveCatalog)).toBe("");
  });

  it("adds to the column the row holds, and binds the amount", () => {
    const query = compilePhisAddonQueries(SCHEMA, stockSchema, reserveCatalog).get("reserve")!;
    expect(query.sql).toBe(
      'UPDATE "phis_addon_acme_shop"."listing" SET "stock" = "stock" + $1, "sold" = "sold" + $2 ' +
      'WHERE "id" = $3 AND "site_id" = $4 AND ("stock" >= $5) ' +
      'RETURNING "id", "title", "stock", "sold", "rank", "flags", "attributes", "opened_at", ' +
      '"site_id", "owner_user_id", "created_by_user_id"',
    );
    expect(query.bindings).toEqual([
      { from: "parameter", name: "taken" },
      { from: "parameter", name: "quantity" },
      { from: "id" },
      { from: "site" },
      { from: "parameter", name: "quantity" },
    ]);
  });

  it("guards a flag bit so that it is set once, and keeps a literal amount bound", () => {
    const query = compilePhisAddonQueries(SCHEMA, stockSchema, reserveCatalog).get("open")!;
    expect(query.sql).toContain(
      'SET "flags" = "flags" + $1, "opened_at" = NOW() ' +
      'WHERE "id" = $2 AND "site_id" = $3 AND (("flags" & $4) = 0) RETURNING',
    );
    expect(query.bindings[0]).toEqual({ from: "literal", value: 4 });
  });

  it("parenthesises the guard, so an any cannot reach past the key and the Site", () => {
    const query = compilePhisAddonQueries(SCHEMA, stockSchema, update(
      [{ column: "title", value: { kind: "literal", value: "x" } }],
      [],
      {
        where: {
          kind: "any",
          conditions: [
            { kind: "isNull", column: "stock" },
            { kind: "compare", column: "stock", operator: ">", value: { kind: "literal", value: 0 } },
          ],
        },
      },
    ) as unknown as PhisAddonQueryCatalog).get("probe")!;
    expect(query.sql).toContain(
      'WHERE "id" = $2 AND "site_id" = $3 AND (("stock" IS NULL OR "stock" > $4))',
    );
  });

  it("compiles an optional guard with its parameter typed", () => {
    const query = compilePhisAddonQueries(SCHEMA, stockSchema, update(
      [{ column: "title", value: { kind: "literal", value: "x" } }],
      [{ name: "expected", type: "integer", nullable: true }],
      {
        where: {
          kind: "whenPresent",
          parameter: "expected",
          condition: { kind: "compare", column: "rank", operator: "=", value: { kind: "parameter", name: "expected" } },
        },
      },
    ) as unknown as PhisAddonQueryCatalog).get("probe")!;
    expect(query.sql).toContain('AND (($4::INTEGER IS NULL OR "rank" = $5))');
  });

  it("leaves an update without a guard exactly as it was", () => {
    const query = compilePhisAddonQueries(SCHEMA, stockSchema, update(
      [{ column: "rank", add: { kind: "literal", value: -1 } }],
    ) as unknown as PhisAddonQueryCatalog).get("probe")!;
    expect(query.sql).toContain('SET "rank" = "rank" + $1 WHERE "id" = $2 AND "site_id" = $3 RETURNING');
  });

  it("refuses to add to a column that does not hold an integer", () => {
    for (const column of ["title", "attributes", "opened_at"]) {
      expect(check(update(
        [{ column, add: { kind: "literal", value: 1 } }],
      ))).toMatch(new RegExp(`"${column}" is not an integer column`));
    }
  });

  it("refuses to add to the key or to a column Core writes", () => {
    expect(check(update([{ column: "id", add: { kind: "literal", value: 1 } }])))
      .toMatch(/"id" is not an integer column/);
    expect(check(update([{ column: "owner_user_id", add: { kind: "literal", value: 1 } }])))
      .toMatch(/which Core writes itself/);
  });

  it("refuses an amount that is not an integer, or that could be null", () => {
    expect(check(update(
      [{ column: "stock", add: { kind: "parameter", name: "amount" } }],
      [{ name: "amount", type: "text" }],
    ))).toMatch(/must be an integer or bigInteger parameter/);
    expect(check(update(
      [{ column: "stock", add: { kind: "parameter", name: "amount" } }],
      [{ name: "amount", type: "integer", nullable: true }],
    ))).toMatch(/nullable parameter "amount"/);
    expect(check(update(
      [{ column: "stock", add: { kind: "parameter", name: "amount" } }],
      [{ name: "amount", type: "integer", list: true }],
    ))).toMatch(/list parameter "amount"/);
    expect(check(update([{ column: "stock", add: { kind: "literal", value: 1.5 } }])))
      .toMatch(/must be an integer literal/);
    expect(check(update([{ column: "stock", add: { kind: "literal", value: "1" } }])))
      .toMatch(/must be an integer literal/);
    expect(check(update([{ column: "stock", add: { kind: "actor" } }])))
      .toMatch(/are not amounts/);
    expect(check(update([{ column: "stock", add: { kind: "parameter", name: "missing" } }])))
      .toMatch(/add names an undeclared parameter/);
  });

  it("refuses an assignment that both writes and adds, or adds to a column twice", () => {
    expect(check(update([{
      column: "stock",
      value: { kind: "literal", value: 1 },
      add: { kind: "literal", value: 1 },
    }]))).toMatch(/states both value and add/);
    expect(check(update([
      { column: "stock", value: { kind: "literal", value: 1 } },
      { column: "stock", add: { kind: "literal", value: 1 } },
    ]))).toMatch(/sets stock more than once/);
  });

  it("refuses add in an insert, which has nothing to add to", () => {
    expect(check({
      parameters: { probe: [] },
      queries: [{
        kind: "insert", name: "probe", table: "listing",
        values: [{ column: "stock", add: { kind: "literal", value: 1 } }],
      }],
    })).toMatch(/add is only meaningful in an update/);
  });

  it("refuses a where on a delete, which would delete the row whether or not it held", () => {
    expect(check({
      parameters: { probe: [{ name: "id", type: "bigInteger" }] },
      queries: [{
        kind: "delete", name: "probe", table: "listing", idParameter: "id",
        where: { kind: "compare", column: "stock", operator: "=", value: { kind: "literal", value: 0 } },
      }],
    })).toMatch(/where is not part of a delete/);
  });

  it("checks the guard the way a select's where is checked", () => {
    expect(check(update(
      [{ column: "rank", add: { kind: "literal", value: 1 } }],
      [],
      { where: { kind: "compare", column: "nowhere", operator: "=", value: { kind: "literal", value: 1 } } },
    ))).toMatch(/where.column does not name a column of listing/);
    expect(check(update(
      [{ column: "rank", add: { kind: "literal", value: 1 } }],
      [{ name: "doc", type: "json" }],
      { where: { kind: "compare", column: "rank", operator: "=", value: { kind: "parameter", name: "doc" } } },
    ))).toMatch(/filters on the json parameter "doc"/);
    expect(check(update(
      [{ column: "rank", add: { kind: "literal", value: 1 } }],
      [],
      { where: { kind: "flags", column: "title", mask: { kind: "literal", value: 1 }, match: "none" } },
    ))).toMatch(/"title" is not an integer column. flags/);
    expect(check(update(
      [{ column: "rank", add: { kind: "literal", value: 1 } }],
      [{ name: "expected", type: "integer" }],
      {
        where: {
          kind: "whenPresent", parameter: "expected",
          condition: { kind: "compare", column: "rank", operator: "=", value: { kind: "parameter", name: "expected" } },
        },
      },
    ))).toMatch(/"expected" must be nullable/);
  });
});

/**
 * A query running with the Add-on's own authority rather than the caller's.
 *
 * What validation owes it is narrow: the value is one of two, no role stands beside it -- a role guards
 * the caller's authority, which this query does not run on -- and the requirement to name a role on a
 * table nobody owns is met by the declaration itself. What it must not loosen is everything the
 * statement carries: Core's scope columns stay Core's in an insert, and the key still addresses one row.
 */
describe("a query running with the Add-on's own authority", () => {
  const authoritySchema: PhisAddonSchemaDescriptor = {
    descriptorVersion: 1,
    version: 1,
    tables: [
      {
        // Nobody owns a seat count: it is the Add-on's.
        name: "offer",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "capacity", type: "integer" },
          { name: "label", type: "string", maxLength: 64 },
        ],
        primaryKey: ["id"],
      },
      {
        name: "booking",
        siteScoped: true,
        groupScoped: true,
        ownerScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "seats", type: "integer" },
        ],
        primaryKey: ["id"],
      },
    ],
  };

  const parameters = {
    q: [
      { name: "id", type: "bigInteger" as const },
      { name: "quantity", type: "integer" as const },
      { name: "taken", type: "integer" as const },
      { name: "group_id", type: "integer" as const },
      { name: "owner", type: "integer" as const },
    ],
  };

  function issuesFor(query: Record<string, unknown>, roles: string[] = ["clerk"]) {
    const issues: string[] = [];
    validatePhisAddonQueryCatalog(
      { parameters, queries: [{ name: "q", ...query }] },
      authoritySchema,
      "queries",
      issues,
      new Set(roles),
    );
    return issues.join("\n");
  }

  const claim = {
    kind: "update",
    table: "offer",
    set: [{ column: "capacity", add: { kind: "parameter", name: "taken" } }],
    idParameter: "id",
    where: {
      kind: "compare", column: "capacity", operator: ">=", value: { kind: "parameter", name: "quantity" },
    },
  };

  it("lets a guarded update change a table nobody owns without naming a role", () => {
    expect(issuesFor({ ...claim, authority: "addon" })).toBe("");
  });

  it("still asks for a role where the caller's authority is the one stated, or none is", () => {
    expect(issuesFor({ ...claim, authority: "caller" })).toMatch(/must state requiresRole/);
    expect(issuesFor(claim)).toMatch(/must state requiresRole/);
    expect(issuesFor({ ...claim, authority: "caller", requiresRole: "clerk" })).toBe("");
  });

  it("requires neither a guard nor an add: a counter has nothing to guard", () => {
    expect(issuesFor({
      kind: "update", table: "offer", idParameter: "id", authority: "addon",
      set: [{ column: "label", value: { kind: "literal", value: "full" } }],
    })).toBe("");
    expect(issuesFor({ kind: "delete", table: "offer", idParameter: "id", authority: "addon" })).toBe("");
  });

  it("is offered on every kind of query", () => {
    expect(issuesFor({ kind: "select", table: "offer", limit: 10, authority: "addon" })).toBe("");
    expect(issuesFor({
      kind: "aggregate", table: "offer", authority: "addon",
      aggregates: [{ function: "sum", column: "capacity", as: "left" }],
    })).toBe("");
    expect(issuesFor({
      kind: "insert", table: "booking", authority: "addon", groupParameter: "group_id",
      values: [{ column: "seats", value: { kind: "parameter", name: "quantity" } }],
    })).toBe("");
  });

  it("refuses a role beside it, in either direction", () => {
    expect(issuesFor({ ...claim, authority: "addon", requiresRole: "clerk" }))
      .toMatch(/states both authority "addon" and requiresRole/);
    expect(issuesFor({
      kind: "delete", table: "booking", idParameter: "id", authority: "addon", alsoAllowedByRole: "clerk",
    })).toMatch(/states both authority "addon" and alsoAllowedByRole/);
  });

  it("refuses an authority it does not know", () => {
    expect(issuesFor({ ...claim, authority: "system" })).toMatch(/authority must be "caller" or "addon"/);
    expect(issuesFor({ ...claim, authority: true })).toMatch(/authority must be "caller" or "addon"/);
  });

  it("leaves the scope columns Core's: an insert under it may not name the owner or the group", () => {
    const insert = (column: string) => issuesFor({
      kind: "insert", table: "booking", authority: "addon", groupParameter: "group_id",
      values: [
        { column: "seats", value: { kind: "parameter", name: "quantity" } },
        { column, value: { kind: "parameter", name: "owner" } },
      ],
    });
    expect(insert("owner_user_id")).toMatch(/is "owner_user_id", which Core writes itself/);
    expect(insert("group_id")).toMatch(/is "group_id", which Core writes itself/);
    expect(insert("site_id")).toMatch(/is "site_id", which Core writes itself/);
    // And a group-scoped insert still names the group through its parameter, where Core writes it.
    expect(issuesFor({
      kind: "insert", table: "booking", authority: "addon",
      values: [{ column: "seats", value: { kind: "parameter", name: "quantity" } }],
    })).toMatch(/groupParameter must name a declared parameter/);
  });

  it("compiles to the statement a caller's query would have been, Site filter and key included", () => {
    const catalog = (authority?: "addon") => ({
      parameters,
      queries: [{ name: "q", ...claim, ...(authority ? { authority } : { requiresRole: "clerk" }) }],
    }) as unknown as PhisAddonQueryCatalog;
    const asAddon = compilePhisAddonQueries(SCHEMA, authoritySchema, catalog("addon")).get("q")!;
    const asCaller = compilePhisAddonQueries(SCHEMA, authoritySchema, catalog()).get("q")!;
    expect(asAddon.sql).toBe(asCaller.sql);
    expect(asAddon.sql).toContain('WHERE "id" = $2 AND "site_id" = $3 AND ("capacity" >= $4)');
  });

  it("names every such query for the operator, with its kind and its table", () => {
    const catalog = {
      parameters,
      queries: [
        { name: "claim", ...claim, authority: "addon" },
        { name: "rename", ...claim, requiresRole: "clerk" },
        { name: "explicit", ...claim, authority: "caller", requiresRole: "clerk" },
        { name: "retire", kind: "delete", table: "offer", idParameter: "id", authority: "addon" },
      ],
    } as unknown as PhisAddonQueryCatalog;
    expect(phisAddonAuthorityBypasses(catalog)).toEqual([
      { query: "claim", kind: "update", table: "offer" },
      { query: "retire", kind: "delete", table: "offer" },
    ]);
  });
});
