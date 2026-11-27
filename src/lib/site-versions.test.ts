import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  flattenPhiSiteVersions,
  readPhiTestedWith,
  resolvePhiSiteScaffoldVersions,
  resolvePhiNpmViewEnvironment,
  resolvePhiSiteVersions,
  selectPhiUiVersionInLine,
  type PhiPackageRegistry,
} from "./site-versions.mts";

/** Made-up versions throughout, so nothing here reads like a pin. */
const TESTED = { next: "9.4.1", react: "9.5.0", "react-dom": "9.5.0", typescript: "9.6.0" };
const OTHER = { uiVersion: "7.8.1", packages: { next: "9.0.0", react: "9.0.0", "react-dom": "9.0.0", typescript: "9.0.0" } };

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

  it("pins the tested versions the chosen @phis/ui states", async () => {
    const npm = registry({ "7.8.0": {}, "7.8.3": { "phis.testedWith": TESTED } });
    const resolved = await resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: npm });
    expect(resolved).toEqual({ uiVersion: "7.8.3", packages: TESTED, source: "registry" });
    expect(npm.asked).toEqual(["7.8.3 phis.testedWith"]);
    expect(flattenPhiSiteVersions(resolved)).toEqual({ "@phis/ui": "7.8.3", ...TESTED });
  });

  it("refuses missing testedWith with an operator action", async () => {
    await expect(resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: registry({ "7.8.2": {} }) }))
      .rejects.toThrow(/7\.8\.2 states no valid phis\.testedWith.*Publish a UI release/);
  });

  it("refuses an unreachable registry and a line without a UI release", async () => {
    await expect(resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: down }))
      .rejects.toThrow(/registry could not be asked.*Check registry access.*retry/);
    await expect(resolvePhiSiteVersions({ serverVersion: "7.8.0", registry: registry({ "7.7.0": {} }) }))
      .rejects.toThrow(/no @phis\/ui in the line of phis 7\.8\.0.*Publish a matching UI release/);
  });

  it("refuses a field that is not a map of exact versions, and never takes @phis/ui from it", async () => {
    expect(readPhiTestedWith({ next: "^9.4.1" })).toBeNull();
    expect(readPhiTestedWith({})).toBeNull();
    expect(readPhiTestedWith(["9.4.1"])).toBeNull();
    expect(readPhiTestedWith({ "@phis/ui": "1.0.0", next: "9.4.1" })).toEqual({ next: "9.4.1" });
    await expect(resolvePhiSiteVersions({
      serverVersion: "7.8.0",
      registry: registry({ "7.8.1": { "phis.testedWith": { next: "latest" } } }),
    })).rejects.toThrow(/states no valid phis\.testedWith/);
  });

  it("asks a reconcile for the tested versions of the @phis/ui the Site pins exactly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-site-versions-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@phis/ui": "7.8.1" } }), "utf8");
    const npm = registry({ "7.8.1": { "phis.testedWith": TESTED }, "7.8.5": { "phis.testedWith": OTHER.packages } });

    const pinned = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: npm });
    expect(pinned).toMatchObject({ uiVersion: "7.8.1", packages: TESTED, source: "registry" });

    await expect(resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: down }))
      .rejects.toThrow(/registry could not be asked.*Check registry access/);

    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@phis/ui": "^7.8.1" } }), "utf8");
    const ranged = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode: "reconcile", registry: npm });
    expect(ranged.uiVersion).toBe("7.8.5");

    const init = await resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: path.join(root, "new"), mode: "init", registry: npm });
    expect(init.uiVersion).toBe("7.8.5");
  });

  it.each(["init", "reconcile"] as const)("refuses incomplete registry data during %s", async (mode) => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-site-versions-"));
    roots.push(root);
    await expect(resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode, registry: down }))
      .rejects.toThrow(/registry could not be asked/);
    await expect(resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode, registry: registry({}) }))
      .rejects.toThrow(/Publish a matching UI release/);
    await expect(resolvePhiSiteScaffoldVersions({ serverVersion: "7.8.0", siteRoot: root, mode, registry: registry({ "7.8.0": {} }) }))
      .rejects.toThrow(/states no valid phis\.testedWith/);
  });

  it("gives npm view the phis cache when no cache is set and the directory is writable, else npm's default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "phis-npm-cache-"));
    roots.push(root);
    const cache = path.join(root, "phis-npm");
    const quiet = { NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" };

    // Not there: npm keeps its default.
    expect(await resolvePhiNpmViewEnvironment({ PATH: "/usr/bin" }, cache)).toEqual({ PATH: "/usr/bin", ...quiet });

    await mkdir(cache);
    expect(await resolvePhiNpmViewEnvironment({ PATH: "/usr/bin" }, cache))
      .toEqual({ PATH: "/usr/bin", ...quiet, npm_config_cache: cache });

    // A cache the caller set wins, however it is spelled; an empty one counts as unset, as npm reads it.
    expect(await resolvePhiNpmViewEnvironment({ npm_config_cache: "/elsewhere" }, cache))
      .toEqual({ npm_config_cache: "/elsewhere", ...quiet });
    expect(await resolvePhiNpmViewEnvironment({ NPM_CONFIG_CACHE: "/elsewhere" }, cache))
      .toEqual({ NPM_CONFIG_CACHE: "/elsewhere", ...quiet });
    expect((await resolvePhiNpmViewEnvironment({ npm_config_cache: "" }, cache)).npm_config_cache).toBe(cache);

    // A file of that name is no cache.
    const file = path.join(root, "file");
    await writeFile(file, "");
    expect((await resolvePhiNpmViewEnvironment({}, file)).npm_config_cache).toBeUndefined();

    // Nor is a directory this process cannot write to (root writes anywhere, so it cannot show this).
    if (process.getuid?.() !== 0) {
      await chmod(cache, 0o555);
      try {
        expect((await resolvePhiNpmViewEnvironment({}, cache)).npm_config_cache).toBeUndefined();
      } finally {
        await chmod(cache, 0o755);
      }
    }
  });
});
