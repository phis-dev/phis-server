import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  flattenPhiSiteVersions,
  readPhiSiteVersionsAtBuild,
  readPhiTestedWith,
  resolvePhiSiteScaffoldVersions,
  resolvePhiSiteVersions,
  selectPhiUiVersionInLine,
  type PhiPackageRegistry,
} from "./site-versions.mts";

/** Made-up versions throughout, so nothing here reads like a pin. */
const TESTED = { next: "9.4.1", react: "9.5.0", "react-dom": "9.5.0", typescript: "9.6.0" };
const FALLBACK = { uiVersion: "7.8.1", packages: { next: "9.0.0", react: "9.0.0", "react-dom": "9.0.0", typescript: "9.0.0" } };

function registry(published: Record<string, unknown>): PhiPackageRegistry & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async listVersions() {
      return Object.keys(published);
    },
    async readField(_name, version, field) {
      asked.push(`${version} ${field}`);
      return (published[version] as Record<string, unknown> | undefined)?.[field];
    },
  };
}

const down: PhiPackageRegistry = {
  async listVersions() {
    throw new Error("npm view @phis/ui versions failed with exit code 1: request to the registry failed");
  },
  async readField() {
    throw new Error("unreachable");
  },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Site versions", () => {
  it("takes the newest @phis/ui of the Server's Major.Minor line", () => {
    const published = ["7.7.9", "7.8.0", "7.8.2", "7.8.10", "7.8.11-beta.1", "7.9.0", "8.8.0"];
    expect(selectPhiUiVersionInLine(published, "7.8.0")).toBe("7.8.10");
    expect(selectPhiUiVersionInLine(published, "7.8.99")).toBe("7.8.10");
    expect(selectPhiUiVersionInLine(published, "7.6.0")).toBeNull();
    // A prerelease Server may take a prerelease of its line, and still prefers the release.
    expect(selectPhiUiVersionInLine(["1.0.0-beta.2", "1.0.0-beta.10"], "1.0.0-beta.3")).toBe("1.0.0-beta.10");
    expect(selectPhiUiVersionInLine(["1.0.0-beta.10", "1.0.0"], "1.0.0-beta.3")).toBe("1.0.0");
    expect(selectPhiUiVersionInLine(["1.0.0-beta.10"], "1.0.0")).toBeNull();
  });

  it("pins the tested versions the chosen @phis/ui states, which win over the recorded set", async () => {
    const npm = registry({ "7.8.0": {}, "7.8.3": { "phis.testedWith": TESTED } });
    const resolved = await resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: npm, fallback: FALLBACK });
    expect(resolved).toEqual({ uiVersion: "7.8.3", packages: TESTED, source: "registry" });
    expect(npm.asked).toEqual(["7.8.3 phis.testedWith"]);
    expect(flattenPhiSiteVersions(resolved)).toEqual({ "@phis/ui": "7.8.3", ...TESTED });
  });

  it("takes the recorded packages beside the chosen @phis/ui when it states none", async () => {
    const resolved = await resolvePhiSiteVersions({
      serverVersion: "7.8.0",
      registry: registry({ "7.8.1": {}, "7.8.2": {} }),
      fallback: FALLBACK,
    });
    expect(resolved).toMatchObject({ uiVersion: "7.8.2", packages: FALLBACK.packages, source: "fallback" });
    expect(resolved.reason).toMatch(/7\.8\.2 states no phis\.testedWith/);
  });

  it("takes the recorded set whole when the registry is down or has nothing in the line", async () => {
    const offline = await resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: down, fallback: FALLBACK });
    expect(offline).toMatchObject({ ...FALLBACK, source: "fallback" });
    expect(offline.reason).toMatch(/could not be asked/);

    const empty = await resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: registry({ "7.7.0": {} }), fallback: FALLBACK });
    expect(empty).toMatchObject({ ...FALLBACK, source: "fallback" });
    expect(empty.reason).toMatch(/no @phis\/ui in the line/);

    await expect(resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: down, fallback: null }))
      .rejects.toThrow(/no Site versions recorded at build time/);
  });

  it("refuses a field that is not a map of exact versions, and never takes @phis/ui from it", async () => {
    expect(readPhiTestedWith({ next: "^9.4.1" })).toBeNull();
    expect(readPhiTestedWith({})).toBeNull();
    expect(readPhiTestedWith(["9.4.1"])).toBeNull();
    expect(readPhiTestedWith({ "@phis/ui": "1.0.0", next: "9.4.1" })).toEqual({ next: "9.4.1" });
    const resolved = await resolvePhiSiteVersions({
      serverVersion: "7.8.0",
      registry: registry({ "7.8.1": { "phis.testedWith": { next: "latest" } } }),
      fallback: FALLBACK,
    });
    expect(resolved.source).toBe("fallback");
  });

  it("asks a reconcile for the tested versions of the @phis/ui the Site pins exactly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-site-versions-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@phis/ui": "7.8.1" } }), "utf8");
    const npm = registry({ "7.8.1": { "phis.testedWith": TESTED }, "7.8.5": { "phis.testedWith": FALLBACK.packages } });

    const pinned = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: npm, fallback: FALLBACK });
    expect(pinned).toMatchObject({ uiVersion: "7.8.1", packages: TESTED, source: "registry" });

    // Offline, a reconcile keeps naming the Site's own @phis/ui rather than the recorded one.
    const offline = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: down, fallback: FALLBACK });
    expect(offline).toMatchObject({ uiVersion: "7.8.1", source: "fallback" });

    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@phis/ui": "^7.8.1" } }), "utf8");
    const ranged = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: npm, fallback: FALLBACK });
    expect(ranged.uiVersion).toBe("7.8.5");

    const init = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: path.join(root, "new"), mode: "init", registry: npm, fallback: FALLBACK });
    expect(init.uiVersion).toBe("7.8.5");
  });

  it("records the registry's set at build time, else a phis-ui checkout in the line", async () => {
    const uiRoot = await mkdtemp(path.join(tmpdir(), "phis-ui-checkout-"));
    roots.push(uiRoot);
    const manifest = (version: string, testedWith?: unknown) =>
      writeFile(path.join(uiRoot, "package.json"), JSON.stringify({ name: "@phis/ui", version, phis: { testedWith } }), "utf8");

    await manifest("7.8.4", FALLBACK.packages);
    const online = await readPhiSiteVersionsAtBuild({
      serverVersion: "7.8.0",
      registry: registry({ "7.8.3": { "phis.testedWith": TESTED } }),
      uiRoot,
    });
    expect(online).toMatchObject({ uiVersion: "7.8.3", packages: TESTED });

    const checkout = await readPhiSiteVersionsAtBuild({ serverVersion: "7.8.0", registry: registry({ "7.8.3": {} }), uiRoot });
    expect(checkout).toMatchObject({ uiVersion: "7.8.4", packages: FALLBACK.packages, source: path.join(uiRoot, "package.json") });

    await manifest("7.9.0", FALLBACK.packages);
    await expect(readPhiSiteVersionsAtBuild({ serverVersion: "7.8.0", registry: down, uiRoot }))
      .rejects.toThrow(/could not be asked.*outside the line/);
    await manifest("7.8.4");
    await expect(readPhiSiteVersionsAtBuild({ serverVersion: "7.8.0", registry: down, uiRoot }))
      .rejects.toThrow(/states no phis\.testedWith/);
  });
});
