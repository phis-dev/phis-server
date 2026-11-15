import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readPhiInstanceStamp, resolvePhiInstanceStampPath, writePhiInstanceStamp } from "./instance-version-cli.ts";

describe("writePhiInstanceStamp", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeRoot() {
    const root = mkdtempSync(path.join(tmpdir(), "phis-stamp-"));
    roots.push(root);
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config", "phis-runtime.json"), "{}\n");
    return root;
  }

  it("records the version and says nothing", () => {
    const root = makeRoot();
    const warnings: string[] = [];
    writePhiInstanceStamp(root, "0.3.3", (message) => warnings.push(message));
    expect(readPhiInstanceStamp(root)?.phisVersion).toBe("0.3.3");
    expect(warnings).toEqual([]);
  });

  it("says once, with the path, when the stamp cannot be written", () => {
    // A directory where the file belongs fails the write for root as well as for anyone else.
    const root = makeRoot();
    mkdirSync(resolvePhiInstanceStampPath(root));
    const warnings: string[] = [];
    writePhiInstanceStamp(root, "0.3.3", (message) => warnings.push(message));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(resolvePhiInstanceStampPath(root));
  });
});
