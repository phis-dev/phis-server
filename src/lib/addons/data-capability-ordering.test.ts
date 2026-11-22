import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisAddonManifestV1 } from "./contract.ts";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { withPoolTransaction } = await import("@/lib/db-transaction");
  return {
    getPool: mocks.getPool,
    withTransaction: (body: Parameters<typeof withPoolTransaction>[1]) =>
      withPoolTransaction(mocks.getPool(), body),
  };
});

import { buildPhisAddonDataCapability } from "./data-capability";

/*
 * A select read in an order the call chooses (`orderings`, `PhisAddonQueryPageRequest.ordering`).
 *
 * What is proven here without a database: the statement that runs is the chosen order's, a page after the
 * first continues in that order, and a call that names an order the query does not declare -- or names one
 * on a query that declares none -- is refused before any statement runs. A cursor read in one order is
 * refused by a call naming another, so no page is read on from a place in a different list. That the rows
 * come back in that order over real pages is `server-addon-paging.pg.test.ts`.
 */

const manifest = {
  addonId: "@unit/ordering",
  schema: {
    descriptorVersion: 1,
    version: 1,
    tables: [{
      name: "offering",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" },
        { name: "title", type: "string", maxLength: 200 },
        { name: "kind", type: "string", maxLength: 64 },
      ],
      primaryKey: ["id"],
    }],
  },
  queries: {
    parameters: { listing: [], plain: [], per_kind: [] },
    queries: [
      {
        kind: "select", name: "listing", table: "offering", limit: 25,
        orderings: { by_title: [{ column: "title", direction: "asc" }], by_kind: [{ column: "kind", direction: "asc" }] },
        defaultOrdering: { key: "by_title", direction: "asc" },
      },
      { kind: "select", name: "plain", table: "offering", orderBy: [{ column: "title", direction: "asc" }], limit: 25 },
      { kind: "aggregate", name: "per_kind", table: "offering", aggregates: [{ function: "count", as: "n" }], groupBy: ["kind"], limit: 25 },
    ],
  },
} as unknown as PhisAddonManifestV1;

/** Two rows each time, carrying the ordering values as the select reads them, so a page of one has a next. */
function poolDouble() {
  const query = vi.fn(async (text: string) => ({
    rows: [
      { id: 1, title: "a", kind: "x", __phi_cursor_0: "a", __phi_cursor_1: "1" },
      { id: 2, title: "b", kind: "y", __phi_cursor_0: "b", __phi_cursor_1: "2" },
    ],
    rowCount: 2,
    command: text,
  }));
  mocks.getPool.mockReturnValue({ query, connect: vi.fn() });
  return query;
}

function capability() {
  return buildPhisAddonDataCapability({
    manifest,
    manifestDigest: "unit-ordering",
    siteId: 1,
    actorUserId: 7,
    mayActOnRow: async () => false,
    mayUseGroup: async () => false,
    hasRole: async () => true,
    unauthenticated: false,
  });
}

beforeEach(() => {
  mocks.getPool.mockReset();
});

describe("a select read in an order the call chooses", () => {
  it("runs the chosen order, both ways round, and reads a call that names none in the default", async () => {
    const query = poolDouble();
    const data = capability();
    await data.select("listing", {}, { limit: 1 });
    await data.select("listing", {}, { limit: 1, ordering: { key: "by_kind", direction: "asc" } });
    await data.select("listing", {}, { limit: 1, ordering: { key: "by_kind", direction: "desc" } });
    const issued = query.mock.calls.map(([text]) => text);
    expect(issued[0]).toContain('ORDER BY "title" ASC, "id" ASC LIMIT');
    expect(issued[1]).toContain('ORDER BY "kind" ASC, "id" ASC LIMIT');
    expect(issued[2]).toContain('ORDER BY "kind" DESC, "id" DESC LIMIT');
  });

  it("continues a page in the order it was read in, with that order's cursor", async () => {
    const query = poolDouble();
    const data = capability();
    const first = await data.select("listing", {}, { limit: 1, ordering: { key: "by_kind", direction: "desc" } });
    expect(first.rows).toEqual([{ id: 1, title: "a", kind: "x" }]);
    expect(first.cursor).not.toBeNull();
    await data.select("listing", {}, { limit: 1, cursor: first.cursor, ordering: { key: "by_kind", direction: "desc" } });
    const [text, values] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(text).toContain('("kind" < $2) OR ("kind" = $3 AND "id" < $4)');
    expect(values.slice(1, 4)).toEqual(["a", "a", "1"]);
  });

  it("refuses a cursor read in another order, or in the default when the call names one", async () => {
    const query = poolDouble();
    const data = capability();
    const byKind = await data.select("listing", {}, { limit: 1, ordering: { key: "by_kind", direction: "asc" } });
    const byDefault = await data.select("listing", {}, { limit: 1 });
    query.mockClear();
    await expect(data.select("listing", {}, { cursor: byKind.cursor, ordering: { key: "by_kind", direction: "desc" } }))
      .rejects.toThrow(/different ordering/);
    await expect(data.select("listing", {}, { cursor: byKind.cursor }))
      .rejects.toThrow(/different ordering/);
    await expect(data.select("listing", {}, { cursor: byDefault.cursor, ordering: { key: "by_kind", direction: "asc" } }))
      .rejects.toThrow(/different ordering/);
    expect(query).not.toHaveBeenCalled();
    // The default named for what it is, though, is the same order.
    await data.select("listing", {}, { cursor: byDefault.cursor, ordering: { key: "by_title", direction: "asc" } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses an order the query does not declare, before any statement runs", async () => {
    const query = poolDouble();
    const data = capability();
    await expect(data.select("listing", {}, { ordering: { key: "by_price", direction: "asc" } }))
      .rejects.toThrow('Query "listing" declares no ordering "by_price".');
    await expect(data.select("listing", {}, { ordering: { key: "constructor", direction: "asc" } }))
      .rejects.toThrow(/declares no ordering "constructor"/);
    await expect(data.select("listing", {}, { ordering: { key: "by_kind", direction: "sideways" as "asc" } }))
      .rejects.toThrow(/neither "asc" nor "desc"/);
    await expect(data.select("plain", {}, { ordering: { key: "by_title", direction: "asc" } }))
      .rejects.toThrow('Query "plain" declares no orderings, so a call cannot choose one.');
    await expect(data.aggregate("per_kind", {}, { ordering: { key: "kind", direction: "asc" } }))
      .rejects.toThrow('Query "per_kind" declares no orderings, so a call cannot choose one.');
    expect(query).not.toHaveBeenCalled();
  });
});
