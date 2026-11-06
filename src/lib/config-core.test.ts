import { chmodSync, chownSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, writePhiRuntimeConfigSync } from "./config-core";

describe("writePhiRuntimeConfigSync", () => {
  let root: string;
  let paths: { root: string; static: string; runtime: string };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "phis-config-core-"));
    paths = { root, static: path.join(root, "phis-config.json"), runtime: path.join(root, "phis-runtime.json") };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const modeOf = (file: string) => statSync(file).mode & 0o777;

  it("creates the runtime file readable by its owner alone", () => {
    writePhiRuntimeConfigSync(paths, DEFAULT_CONFIG);
    expect(modeOf(paths.runtime)).toBe(0o600);
  });

  it("leaves a world-readable runtime file owner-only after the next write", () => {
    writeFileSync(paths.runtime, "{}\n");
    chmodSync(paths.runtime, 0o644);
    writePhiRuntimeConfigSync(paths, DEFAULT_CONFIG);
    expect(modeOf(paths.runtime)).toBe(0o600);
  });

  it("does not inherit the mode of a temp file an interrupted write left behind", () => {
    writeFileSync(`${paths.runtime}.tmp`, "{}\n");
    chmodSync(`${paths.runtime}.tmp`, 0o644);
    writePhiRuntimeConfigSync(paths, DEFAULT_CONFIG);
    expect(modeOf(paths.runtime)).toBe(0o600);
  });

  // Ownership can only be handed over by root, so these run only where the suite runs as root.
  const asRoot = process.getuid?.() === 0;
  const otherAccount = { uid: 65534, gid: 65534 };

  it.runIf(asRoot)("keeps the owner of the file it replaces when written as root", () => {
    writeFileSync(paths.runtime, "{}\n");
    chownSync(paths.runtime, otherAccount.uid, otherAccount.gid);
    writePhiRuntimeConfigSync(paths, DEFAULT_CONFIG);
    const stat = statSync(paths.runtime);
    expect({ uid: stat.uid, gid: stat.gid }).toEqual(otherAccount);
  });

  it.runIf(asRoot)("gives a new file the owner of config/ when written as root", () => {
    chownSync(root, otherAccount.uid, otherAccount.gid);
    writePhiRuntimeConfigSync(paths, DEFAULT_CONFIG);
    const stat = statSync(paths.runtime);
    expect({ uid: stat.uid, gid: stat.gid }).toEqual(otherAccount);
  });
});
