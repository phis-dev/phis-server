import { describe, expect, it } from "vitest";

import { phiPrepared } from "./db-prepared";

/**
 * node-pg refuses a statement name that one connection already prepared with another text, so the name
 * has to follow the text exactly: the same text always the same name, any other text another one.
 */
describe("a prepared statement's name", () => {
  it("follows the text, not the call site or the values", () => {
    const first = phiPrepared("SELECT 1 WHERE $1 = $1", [1]);
    const again = phiPrepared("SELECT 1 WHERE $1 = $1", [2]);
    expect(again.name).toBe(first.name);
    expect(again.values).toEqual([2]);
    expect(phiPrepared("SELECT 1 WHERE $1 = $1 FOR UPDATE", [1]).name).not.toBe(first.name);
  });

  it("fits PostgreSQL's identifier limit", () => {
    expect(phiPrepared("SELECT 2", []).name!.length).toBeLessThanOrEqual(63);
  });
});
