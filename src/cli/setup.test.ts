import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listPhiConfiguredDirectories } from "../lib/configured-directories.ts";
import {
  ensurePhiStageDirectories,
  readPhiDirectorySteps,
  readPhiSetupWarnings,
  writePhiEmailFrom,
} from "./setup.mts";
import { listPhiStageSharedDirectories } from "./stage.mts";

/** A stage in a temporary directory whose three configured directories lie beside it. */
function scratchStage() {
  const base = mkdtempSync(path.join(tmpdir(), "phis-setup-"));
  const root = path.join(base, "stage");
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "config", "phis-config.json"), JSON.stringify({
    media: { local: { rootDir: path.join(base, "media") } },
    sites: { sourcePathRoot: path.join(base, "sites"), instancePathRoot: path.join(base, "instances") },
  }));
  writeFileSync(path.join(root, "config", "phis-runtime.json"), "{}\n");
  return { base, root };
}

describe("the stage's directories", () => {
  it("are steps of the setup status, done once install has made them", () => {
    const { base, root } = scratchStage();
    expect(readPhiDirectorySteps(root).map((step) => [step.key, step.done])).toEqual([
      ["media", false],
      ["sources", false],
      ["instances", false],
    ]);
    const results = ensurePhiStageDirectories(root);
    expect(results.map((result) => result.path)).toEqual(["media", "sites", "instances"].map((name) => path.join(base, name)));
    expect(readPhiDirectorySteps(root).every((step) => step.done)).toBe(true);
  });

  it("are listed by stage remove as left in place, with whether they are empty", () => {
    const { base, root } = scratchStage();
    ensurePhiStageDirectories(root);
    writeFileSync(path.join(base, "sites", "keep"), "");
    const directories = listPhiConfiguredDirectories({
      media: { local: { rootDir: path.join(base, "media") } },
      sites: { sourcePathRoot: path.join(base, "sites"), instancePathRoot: path.join(root, "instances") },
    });
    // The instance root inside the stage directory goes with it and is not listed.
    expect(listPhiStageSharedDirectories(directories, root)).toEqual([
      { path: path.join(base, "media"), setting: "media.local.rootDir", empty: true },
      { path: path.join(base, "sites"), setting: "sites.sourcePathRoot", empty: false },
    ]);
  });
});

describe("the sender", () => {
  it("is warned about while email.from is unset", () => {
    expect(readPhiSetupWarnings({})).toEqual([expect.stringMatching(/email\.from is unset/u)]);
    expect(readPhiSetupWarnings({ email: { from: "  " } })).toHaveLength(1);
    expect(readPhiSetupWarnings({ email: { from: "noreply@example.com" } })).toEqual([]);
  });

  it("is written into the runtime file, keeping the rest of email", () => {
    const { root } = scratchStage();
    const runtime = path.join(root, "config", "phis-runtime.json");
    writeFileSync(runtime, JSON.stringify({ email: { fromName: "Acme" } }));
    expect(writePhiEmailFrom(root, " noreply@example.com ")).toMatchObject({ from: "noreply@example.com", changed: true });
    expect(JSON.parse(readFileSync(runtime, "utf8")).email).toEqual({ fromName: "Acme", from: "noreply@example.com" });
    expect(writePhiEmailFrom(root, "noreply@example.com").changed).toBe(false);
    expect(() => writePhiEmailFrom(root, "noreply")).toThrow(/no email address/u);
  });
});
