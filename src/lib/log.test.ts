import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { logRuntimeEvent, notePhiLogSite } = await import("@/lib/log");

function captureRecords(work: () => Promise<void> | void) {
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: string) => { lines.push(line); });
  return Promise.resolve(work()).then(() => lines.map((line) => JSON.parse(line) as { siteKey: string | null }));
}

/*
 * A Site's admin log shows only that Site's records, and callers almost never name the Site. The request
 * that resolved it does, once, and what it logs afterwards carries it.
 */
describe("the Site a request was resolved for", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is stamped on what that request logs, and not on another request", async () => {
    const records = await captureRecords(async () => {
      await Promise.all([
        (async () => {
          await Promise.resolve();
          notePhiLogSite("alpha");
          await Promise.resolve();
          logRuntimeEvent("info", "first");
        })(),
        (async () => {
          await Promise.resolve();
          await Promise.resolve();
          logRuntimeEvent("info", "second");
        })(),
      ]);
    });
    expect(records.map((record) => record.siteKey)).toEqual(["alpha", null]);
  });

  it("gives way to a Site the caller names", async () => {
    const records = await captureRecords(async () => {
      await (async () => {
        notePhiLogSite("alpha");
        logRuntimeEvent("info", "named", { siteKey: "beta" });
      })();
    });
    expect(records[0]?.siteKey).toBe("beta");
  });
});
