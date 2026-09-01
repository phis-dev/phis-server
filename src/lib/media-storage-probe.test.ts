import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhisLocalMediaStorageAdapter } from "./media-storage.ts";

/**
 * What the built-in storage answers when asked what it can do.
 *
 * Its interesting answer is the negative one. `verifiesSha256: false` looks like a shortcoming and is
 * not: the question is whether a *remote* endpoint checks what a client asserted, and here there is
 * neither a remote endpoint nor an assertion -- every byte is written by Core, which hashes as it
 * writes. A probe that answered `true` would be claiming to have verified something nobody claimed.
 *
 * The rest is the ordinary use: a Profile pointing at a directory that cannot be written to should say
 * so when it is configured, not when somebody uploads.
 */

let root: string;

describe("probing the built-in storage", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "phis-probe-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a writable root, and does not claim a verification nobody asked for", async () => {
    const adapter = new PhisLocalMediaStorageAdapter({ rootDir: root, storageKeyPrefix: "sites" });
    const probe = await adapter.probeCapabilities();
    expect(probe).toEqual({ writable: true, verifiesSha256: false, findings: [] });
  });

  it("leaves nothing behind", async () => {
    const adapter = new PhisLocalMediaStorageAdapter({ rootDir: root, storageKeyPrefix: "sites" });
    await adapter.probeCapabilities();
    // The probe writes under a directory of its own; an empty one may remain, an object may not.
    expect(await adapter.listPrefix(".phis-probe")).toEqual([]);
  });

  it("says a root it cannot write to is not writable, rather than throwing", async () => {
    // A file where a directory has to be: the write fails for a reason an operator can act on, and the
    // probe reports it instead of ending the run.
    const blocked = new PhisLocalMediaStorageAdapter({
      rootDir: path.join(root, "occupied"),
      storageKeyPrefix: "sites",
    });
    await blocked.putObject({
      storageKey: ".phis-probe",
      body: Buffer.from("in the way"),
      contentType: "application/octet-stream",
    });

    const probe = await blocked.probeCapabilities();
    expect(probe.writable).toBe(false);
    expect(probe.findings).toHaveLength(1);
    expect(probe.findings[0]).toMatch(/did not accept a write/u);
  });

  it("keeps its probe out of the way of real keys", async () => {
    const adapter = new PhisLocalMediaStorageAdapter({ rootDir: root, storageKeyPrefix: "sites" });
    await adapter.probeCapabilities();
    const entries = await readdir(root);
    expect(entries.some((entry) => entry === "sites")).toBe(false);
  });
});
