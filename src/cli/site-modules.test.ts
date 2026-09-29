import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildSiteModuleProjection, writeSiteModuleProjection } from "./modules.mts";

/**
 * What `phis module` writes into a Site.
 *
 * The generated file is the whole of the installation, so its shape is worth pinning: a list of imports
 * and one call. Nothing here loads a Module -- the placement into Areas happens where the projection is
 * imported, from each Module's own `eligibleAreas`.
 */
describe("the generated Site Module projection", () => {
  it("refuses two packages whose names fold into one import alias", () => {
    expect(() => buildSiteModuleProjection([
      { packageName: "@acme/foo-bar", origin: "resolved" },
      { packageName: "@acme/foo_bar", origin: "resolved" },
    ], [])).toThrow(/share the import alias m_acme_foo_bar/u);
  });

  it("composes to nothing when no Module is installed", () => {
    const { server, client, authoringClient } = buildSiteModuleProjection([], []);
    expect(server).toContain("collectPhiSiteModuleServerAreaContributions([\n]);");
    expect(client).toContain("definitions: []");
    expect(client).toContain("clients: []");
    expect(authoringClient).toContain("authoring: []");
    // A Site without Modules must still get a Client file, or its Area hosts have nothing to be handed.
    expect(client.startsWith('"use client";')).toBe(true);
    expect(authoringClient.startsWith('"use client";')).toBe(true);
  });

  /*
   * The separation the Public bundle depends on. Every Area host imports the live file, so an Authoring
   * import in it is an Authoring implementation in every Area's browser bundle -- which is how the
   * Builder's table controls once shipped with the Public landing page.
   */
  it("keeps Authoring out of the file every Area host imports", () => {
    const { client, authoringClient } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ], []);
    // The import edge is what matters; the file may name its counterpart in prose.
    expect(client).not.toMatch(/^import .*authoring-client/mu);
    expect(client).not.toContain("phiModuleAuthoringContributions");
    expect(authoringClient).toContain(
      'import { phiModuleAuthoringContributions as m_acme_status_authoring } from "@acme/status/authoring-client";',
    );
    expect(authoringClient).toContain("collectPhiSiteModuleAuthoringContributions");
  });

  it("imports each boundary under the fixed export names", () => {
    const { server, client } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ], []);
    expect(server).toContain(
      'import { phiModuleServerContributions as m_acme_status } from "@acme/status/server";',
    );
    expect(client).toContain(
      'import { phiModuleDefinitions as m_acme_status_definitions } from "@acme/status";',
    );
    expect(client).toContain(
      'import { phiModuleClientContributions as m_acme_status_client } from "@acme/status/client";',
    );
  });

  it("orders Modules by package name rather than by when they were added", () => {
    const { server } = buildSiteModuleProjection([
      { packageName: "@zeta/late", origin: "local" },
      { packageName: "@alpha/early", origin: "local" },
    ], []);
    expect(server.indexOf("m_alpha_early")).toBeLessThan(server.indexOf("m_zeta_late"));
  });

  it("names imports after their package, so removing one does not renumber the rest", () => {
    const two = buildSiteModuleProjection([
      { packageName: "@acme/a", origin: "local" },
      { packageName: "@acme/b", origin: "local" },
    ], []);
    const one = buildSiteModuleProjection([{ packageName: "@acme/b", origin: "local" }], []);
    // The surviving Module keeps the exact lines it had; a numbered alias would have shifted them.
    for (const line of one.server.split("\n").filter((entry) => entry.includes("m_acme_b"))) {
      expect(two.server).toContain(line);
    }
  });
});

/**
 * The typefaces half, which is the one part of the projection the desired state does not answer.
 *
 * `./fonts` is optional, so the generator has to learn from the installed package whether it exports the
 * boundary at all -- an import of a subpath a package does not have fails the Site's build, and a missing
 * import fails nothing and leaves the Module's lettering out of the Site.
 */
describe("the generated font projection", () => {
  it("imports only the packages that were named as exporting ./fonts", () => {
    const { fonts } = buildSiteModuleProjection(
      [
        { packageName: "@acme/plain", origin: "local" },
        { packageName: "@acme/status", origin: "local" },
      ],
      ["@acme/status"],
    );
    expect(fonts).toContain(
      'import { phiModuleFontContributions as m_acme_status } from "@acme/status/fonts";',
    );
    expect(fonts).not.toContain("@acme/plain");
    expect(fonts).toContain("export const PHI_SITE_MODULE_FONTS = [\n  ...m_acme_status,\n];");
  });

  it("is an empty list when no installed Module ships typefaces", () => {
    const { fonts } = buildSiteModuleProjection(
      [{ packageName: "@acme/plain", origin: "local" }],
      [],
    );
    expect(fonts).not.toContain("import ");
    expect(fonts).toContain("export const PHI_SITE_MODULE_FONTS = [\n];");
  });

  it("orders the font imports by package name, like the rest of the projection", () => {
    const { fonts } = buildSiteModuleProjection(
      [
        { packageName: "@zeta/late", origin: "local" },
        { packageName: "@alpha/early", origin: "local" },
      ],
      ["@zeta/late", "@alpha/early"],
    );
    expect(fonts.indexOf("m_alpha_early")).toBeLessThan(fonts.indexOf("m_zeta_late"));
  });
});

/**
 * What reaches the Site's files, over an installed tree.
 *
 * The four files are one act: a Site that has the Server half of a Module and not its fonts builds and
 * renders, which is exactly why the missing file was not noticed. The export map in the Site's
 * `node_modules` is all that decides the fourth, and nothing here loads a package to read it.
 */
describe("writing the projection into a Site", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function siteRootWith(packages: Record<string, Record<string, unknown>>) {
    const root = await mkdtemp(path.join(tmpdir(), "phis-modules-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), '{ "name": "site" }\n');
    for (const [packageName, exportMap] of Object.entries(packages)) {
      const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({ name: packageName, exports: exportMap }, null, 2)}\n`,
      );
    }
    return root;
  }

  const fourEntrypoints = {
    ".": "./dist/index.js",
    "./server": "./dist/server.js",
    "./client": "./dist/client.js",
    "./authoring-client": "./dist/authoring-client.js",
  };

  it("writes all four files and reads the fonts boundary from the installed package", async () => {
    const root = await siteRootWith({
      "@acme/plain": fourEntrypoints,
      "@acme/status": {
        ...fourEntrypoints,
        "./fonts": { types: "./dist/fonts.d.ts", import: "./dist/fonts.js" },
      },
    });
    const result = writeSiteModuleProjection(root, [
      { packageName: "@acme/plain", origin: "local" },
      { packageName: "@acme/status", origin: "local" },
    ]);

    expect(result.files).toEqual([
      "src/generated/site-modules.ts",
      "src/generated/site-modules-client.ts",
      "src/generated/site-modules-authoring-client.ts",
      "src/generated/site-modules-fonts.ts",
    ]);
    expect(result.fontPackages).toEqual(["@acme/status"]);
    const fonts = await readFile(path.join(root, "src/generated/site-modules-fonts.ts"), "utf8");
    expect(fonts).toContain('from "@acme/status/fonts";');
    expect(fonts).not.toContain("@acme/plain");
    // The Server half lists both: a package without typefaces is a Module like any other.
    const server = await readFile(path.join(root, "src/generated/site-modules.ts"), "utf8");
    expect(server).toContain("...m_acme_plain,");
    expect(server).toContain("...m_acme_status,");
  });

  /*
   * `add` records a package before the package manager has fetched it, and says to run `sync` after the
   * install for this reason. Guessing from the name instead would import a subpath that may not exist.
   */
  it("treats a package that is not installed yet as one without typefaces", async () => {
    const root = await siteRootWith({});
    const result = writeSiteModuleProjection(root, [
      { packageName: "@acme/status", origin: "resolved", spec: "1.0.0" },
    ]);
    expect(result.fontPackages).toEqual([]);
    const fonts = await readFile(path.join(root, "src/generated/site-modules-fonts.ts"), "utf8");
    expect(fonts).toContain("export const PHI_SITE_MODULE_FONTS = [\n];");
  });
});
