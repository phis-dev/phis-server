import { describe, expect, it } from "vitest";

import {
  decodePhiServerAddonCursor,
  encodePhiServerAddonCursor,
  PhiServerAddonCursorError,
} from "./query-cursor.ts";
import type { PhiServerAddonQueryOrdering } from "./contract.ts";

/**
 * What a cursor has to survive, and what it has to refuse.
 *
 * The refusals matter more than the round trip here. A cursor used against the wrong ordering produces
 * no database error at all -- the comparison is valid SQL, and the answer is merely wrong, skipping
 * some rows and repeating others. Nothing downstream would notice, which is why it is caught here.
 */

const ORDERING: PhiServerAddonQueryOrdering[] = [
  { column: "updated_at", direction: "desc" },
  { column: "id", direction: "asc" },
];

describe("a paging cursor", () => {
  it("carries the ordering values back in the order they are compared", () => {
    const cursor = encodePhiServerAddonCursor("listing", ORDERING, {
      updated_at: new Date("2026-08-30T10:00:00.000Z"),
      id: "42",
      title: "not part of the order",
    });
    expect(decodePhiServerAddonCursor("listing", ORDERING, cursor)).toEqual([
      "2026-08-30T10:00:00.000Z",
      "42",
    ]);
  });

  it("keeps a large key as text, because a bigint does not survive a JavaScript number", () => {
    const big = "9007199254740993";
    const cursor = encodePhiServerAddonCursor("listing", [{ column: "id", direction: "asc" }], {
      id: big,
    });
    expect(decodePhiServerAddonCursor("listing", [{ column: "id", direction: "asc" }], cursor))
      .toEqual([big]);
  });

  it("refuses a cursor made for another query", () => {
    const cursor = encodePhiServerAddonCursor("listing", ORDERING, { updated_at: "x", id: "1" });
    expect(() => decodePhiServerAddonCursor("other", ORDERING, cursor))
      .toThrow(PhiServerAddonCursorError);
  });

  it("refuses a cursor made for another ordering of the same query", () => {
    const cursor = encodePhiServerAddonCursor("listing", ORDERING, { updated_at: "x", id: "1" });
    const reversed: PhiServerAddonQueryOrdering[] = [
      { column: "updated_at", direction: "asc" },
      { column: "id", direction: "asc" },
    ];
    expect(() => decodePhiServerAddonCursor("listing", reversed, cursor))
      .toThrow(/different ordering/);
  });

  it("refuses something that is not a cursor at all", () => {
    expect(() => decodePhiServerAddonCursor("listing", ORDERING, "not-a-cursor"))
      .toThrow(PhiServerAddonCursorError);
  });

  it("refuses to make one from a row whose ordering value is null", () => {
    expect(() => encodePhiServerAddonCursor("listing", ORDERING, { updated_at: null, id: "1" }))
      .toThrow(/must be NOT NULL/);
  });
});
