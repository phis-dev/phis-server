import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findPhiMediaOrphanedLocalStaging } from "./media-check.mts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stage(root: string, key: string, ageDays: number) {
  const file = path.join(root, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "x");
  const when = (Date.now() - ageDays * 86_400_000) / 1000;
  utimesSync(file, when, when);
  return file;
}

function fakePool(rootDir: string, sessionKeys: string[]) {
  return {
    query: async (sql: string) => sql.includes("media_storage_profiles")
      ? { rows: [{ config: { rootDir } }] }
      : { rows: sessionKeys.map((key) => ({ key })) },
  } as never;
}

describe("orphaned Local staging", () => {
  it("finds old staged files no session names, leaves young and named ones, and removes only on prune", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "phis-media-check-"));
    roots.push(root);
    const orphan = stage(root, "sites/uploads-temp/acme/a/orphan.bin", 10);
    stage(root, "sites/uploads-temp/acme/b/young.bin", 0);
    stage(root, "sites/uploads-temp/acme/c/named.bin", 10);
    stage(root, "sites/acme/kept.bin", 30);

    const pool = fakePool(root, ["sites/uploads-temp/acme/c/named.bin"]);
    const [report] = await findPhiMediaOrphanedLocalStaging(pool, { minAgeDays: 2 });
    expect(report?.orphans.map((entry) => entry.key)).toEqual(["sites/uploads-temp/acme/a/orphan.bin"]);
    expect(report?.young).toBe(1);
    expect(existsSync(orphan)).toBe(true);

    const [pruned] = await findPhiMediaOrphanedLocalStaging(pool, { minAgeDays: 2, prune: true });
    expect(pruned?.removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.join(root, "sites/acme/kept.bin"))).toBe(true);
  });
});
