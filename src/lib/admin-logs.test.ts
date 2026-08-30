import { describe, expect, it } from "vitest";

import { parsePhiAdminLogQuery } from "./admin-logs";

describe("parsePhiAdminLogQuery", () => {
  it("keeps an omitted level filter unrestricted", () => {
    expect(parsePhiAdminLogQuery(new URLSearchParams()).levels).toEqual([]);
  });

  it("accepts several declared log levels", () => {
    expect(parsePhiAdminLogQuery(new URLSearchParams({ level: "warn,error" })).levels)
      .toEqual(["warn", "error"]);
  });

  it("drops undeclared log levels", () => {
    expect(parsePhiAdminLogQuery(new URLSearchParams({ level: "warning,error,trace" })).levels)
      .toEqual(["error"]);
  });
});
