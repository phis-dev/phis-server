import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildSiteModuleProjection, writeSiteModuleProjection } from "./modules.mts";

/**
 * What `phis module` writes into a Site.
 *
 * The generated files are the whole of the installation, so their shape is worth pinning: a list of
 * imports, the placements, and one call. Nothing here loads a Module -- which Areas a Module serves
 * comes from its package's `package.json#phis`, handed in as `declarations`.
 */
const status = new Map([["@acme/status", [
  { moduleId: "@acme/status/modules/status", category: "operations", eligibleAreas: ["app", "builder"] },
]]]) as Parameters<typeof buildSiteModuleProjection>[2];

describe("the generated Site Module projection", () => {
  it("refuses two packages whose names fold into one import alias", () => {
    expect(() => buildSiteModuleProjection([
      { packageName: "@acme/foo-bar", origin: "resolved" },
      { packageName: "@acme/foo_bar", origin: "resolved" },
    ], [], new Map())).toThrow(/share the import alias m_acme_foo_bar/u);
  });

  it("composes to nothing when no Module is installed", () => {
    const { server, clients, authoringClient } = buildSiteModuleProjection([], [], new Map());
    expect(server).toContain("placements: [\n  ],\n  contributions: [\n  ],");
    for (const client of Object.values(clients)) {
      expect(client).toContain("placements: [\n  ],");
      expect(client).toContain("clients: []");
      // A Site without Modules still gets a Client file per Area, or its hosts are handed nothing.
      expect(client.startsWith('"use client";')).toBe(true);
    }
    expect(Object.keys(clients).sort())
      .toEqual(["accounting", "admin", "app", "builder", "editor", "public"]);
    expect(authoringClient).toContain("authoring: []");
    expect(authoringClient.startsWith('"use client";')).toBe(true);
  });

  /*
   * The separation the Public bundle depends on. An Area host imports its live file, so an Authoring
   * import in it is an Authoring implementation in that Area's browser bundle -- which is how the
   * Builder's table controls once shipped with the Public landing page.
   */
  it("keeps Authoring out of every live Area file", () => {
    const { clients, authoringClient } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ], [], status);
    for (const client of Object.values(clients)) {
      // The import edge is what matters; the file may name its counterpart in prose.
      expect(client).not.toMatch(/^import .*authoring-client/mu);
      expect(client).not.toContain("phiModuleAuthoringContributions");
    }
    expect(authoringClient).toContain(
      'import { phiModuleAuthoringContributions as m_acme_status_authoring } from "@acme/status/authoring-client";',
    );
    expect(authoringClient).toContain("collectPhiSiteModuleAuthoringContributions");
  });

  /*
   * The cut this projection exists for. A package's Client door belongs only in the files of the Areas
   * its Modules serve, and no live file reaches a package's root -- its definition, with every preset
   * and descriptor, rode along on every Area's pages while one file served them all.
   */
  it("imports a package's Client door only into the Areas it serves, and never its root", () => {
    const { server, clients } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ], [], status);
    expect(server).toContain(
      'import { phiModuleServerContributions as m_acme_status } from "@acme/status/server";',
    );
    expect(server).toContain(
      '{ moduleId: "@acme/status/modules/status", eligibleAreas: ["app", "builder"] },',
    );
    const door =
      'import { phiModuleClientContributions as m_acme_status_client } from "@acme/status/client";';
    expect(clients.app).toContain(door);
    expect(clients.builder).toContain(door);
    expect(clients.app)
      .toContain('{ moduleId: "@acme/status/modules/status", eligibleAreas: ["app"] },');
    for (const area of ["public", "admin", "editor", "accounting"] as const) {
      expect(clients[area]).not.toContain("@acme/status");
    }
    for (const client of Object.values(clients)) {
      expect(client).not.toMatch(/from "@acme\/status";/u);
      expect(client).not.toContain("phiModuleDefinitions");
    }
  });

  /*
   * A package not installed yet, or one declaring nothing, cannot be placed. It keeps its Server import,
   * so the Site's build names it instead of building without it.
   */
  it("keeps an undeclared package in the Server half and out of every Client file", () => {
    const { server, clients, authoringClient } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ], [], new Map());
    expect(server).toContain("...m_acme_status,");
    expect(server).toContain("placements: [\n  ],");
    for (const client of Object.values(clients)) {
      expect(client).not.toContain("@acme/status");
    }
    expect(authoringClient).not.toContain("@acme/status");
  });

  it("orders Modules by package name rather than by when they were added", () => {
    const { server } = buildSiteModuleProjection([
      { packageName: "@zeta/late", origin: "local" },
      { packageName: "@alpha/early", origin: "local" },
    ], [], new Map());
    expect(server.indexOf("m_alpha_early")).toBeLessThan(server.indexOf("m_zeta_late"));
  });

  it("names imports after their package, so removing one does not renumber the rest", () => {
    const two = buildSiteModuleProjection([
      { packageName: "@acme/a", origin: "local" },
      { packageName: "@acme/b", origin: "local" },
    ], [], new Map());
    const one = buildSiteModuleProjection([{ packageName: "@acme/b", origin: "local" }], [], new Map());
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
      new Map(),
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
      new Map(),
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
      new Map(),
    );
    expect(fonts.indexOf("m_alpha_early")).toBeLessThan(fonts.indexOf("m_zeta_late"));
  });
});

/**
 * What reaches the Site's files, over an installed tree.
 *
 * The files are one act: a Site that has the Server half of a Module and not its fonts builds and
 * renders, which is exactly why the missing file was not noticed. The manifest in the Site's
 * `node_modules` decides the fonts file and which Area files hold the package, and nothing here loads a
 * package to read it.
 */
describe("writing the projection into a Site", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function siteRootWith(
    packages: Record<string, Record<string, unknown>>,
    declarations: Record<string, unknown> = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "phis-modules-"));
    roots.push(root);
    await writeFile(path.join(root, "package.json"), '{ "name": "site" }\n');
    for (const [packageName, exportMap] of Object.entries(packages)) {
      const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        `${JSON.stringify({
          name: packageName,
          exports: exportMap,
          phis: declarations[packageName],
        }, null, 2)}\n`,
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

  it("writes every file, reading fonts and Areas from the installed package", async () => {
    const root = await siteRootWith({
      "@acme/plain": fourEntrypoints,
      "@acme/status": {
        ...fourEntrypoints,
        "./fonts": { types: "./dist/fonts.d.ts", import: "./dist/fonts.js" },
      },
    }, {
      "@acme/plain": {
        modules: [{
          moduleId: "@acme/plain/modules/plain",
          category: "content",
          eligibleAreas: ["public"],
        }],
      },
      "@acme/status": {
        modules: [{
          moduleId: "@acme/status/modules/status",
          category: "operations",
          eligibleAreas: ["app"],
        }],
      },
    });
    const result = writeSiteModuleProjection(root, [
      { packageName: "@acme/plain", origin: "local" },
      { packageName: "@acme/status", origin: "local" },
    ]);

    expect(result.files).toEqual([
      "src/generated/site-modules.ts",
      "src/generated/site-modules-client-public.ts",
      "src/generated/site-modules-client-app.ts",
      "src/generated/site-modules-client-admin.ts",
      "src/generated/site-modules-client-builder.ts",
      "src/generated/site-modules-client-editor.ts",
      "src/generated/site-modules-client-accounting.ts",
      "src/generated/site-modules-authoring-client.ts",
      "src/generated/site-modules-fonts.ts",
      "src/generated/site-module-packages.json",
    ]);
    expect(result.unplacedPackages).toEqual([]);
    const publicClient =
      await readFile(path.join(root, "src/generated/site-modules-client-public.ts"), "utf8");
    expect(publicClient).toContain('from "@acme/plain/client";');
    expect(publicClient).not.toContain("@acme/status");
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
  it("treats a package that is not installed yet as one without typefaces or Areas", async () => {
    const root = await siteRootWith({});
    const result = writeSiteModuleProjection(root, [
      { packageName: "@acme/status", origin: "resolved", spec: "1.0.0" },
    ]);
    expect(result.fontPackages).toEqual([]);
    expect(result.unplacedPackages).toEqual(["@acme/status"]);
    const fonts = await readFile(path.join(root, "src/generated/site-modules-fonts.ts"), "utf8");
    expect(fonts).toContain("export const PHI_SITE_MODULE_FONTS = [\n];");
  });
});

/*
 * The package list is what lets Next compile a Module installed from a tarball: the scaffold's
 * `next.config.ts` spreads it into `transpilePackages`, and a package missing from it loses its `./fonts`
 * boundary without a word.
 */
describe("the generated package list", () => {
  it("names every installed package, sorted, whether it ships typefaces or not", () => {
    const { packages } = buildSiteModuleProjection(
      [
        { packageName: "@zeta/late", origin: "resolved" },
        { packageName: "@alpha/early", origin: "local" },
      ],
      ["@zeta/late"],
      new Map(),
    );
    expect(JSON.parse(packages)).toEqual(["@alpha/early", "@zeta/late"]);
  });

  it("is an empty list for a Site without Modules", () => {
    expect(JSON.parse(buildSiteModuleProjection([], [], new Map()).packages)).toEqual([]);
  });
});
