import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { inspectSiteModulePackage } from "./module-package.mts";

/**
 * The three ways a built Module package goes wrong, each of which fails somewhere else.
 *
 * A lost `"use client"` fails when somebody opens the page. A second React fails as a broken hook. CSS
 * without stated side effects does not fail at all -- it renders unstyled, which is the worst of the
 * three because nothing reports it. All three are visible from outside the package, so they are checked
 * before the Site is built rather than diagnosed afterwards.
 */

const PACKAGE = "@acme/widgets";

function writePackage(input: {
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}) {
  const siteRoot = mkdtempSync(path.join(tmpdir(), "phis-module-check-"));
  const root = path.join(siteRoot, "node_modules", "@acme", "widgets");
  mkdirSync(path.join(root, "dist"), { recursive: true });

  const files = {
    "dist/index.js": "export const phiModuleDefinitions = [];\n",
    "dist/server.js": "export const phiModuleServerContributions = [];\n",
    "dist/client.js": '"use client";\nexport const phiModuleClientContributions = {};\n',
    "dist/authoring-client.js": '"use client";\nexport const phiModuleAuthoringContributions = [];\n',
    ...input.files,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content);
  }

  const entry = (name: string) => ({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: PACKAGE,
      sideEffects: false,
      exports: {
        ".": entry("index"),
        "./server": entry("server"),
        "./client": entry("client"),
        "./authoring-client": entry("authoring-client"),
      },
      peerDependencies: { react: "^19", "@phis/ui": "^1" },
      ...input.manifest,
    }),
  );
  return siteRoot;
}

function codesFor(siteRoot: string) {
  return inspectSiteModulePackage(siteRoot, PACKAGE).issues.map((issue) => issue.code);
}

describe("inspecting a built Module package", () => {
  it("passes a package that is put together correctly", () => {
    expect(codesFor(writePackage({}))).toEqual([]);
  });

  it("reports a package that is not installed as such, rather than as sound", () => {
    const siteRoot = mkdtempSync(path.join(tmpdir(), "phis-module-check-"));
    const report = inspectSiteModulePackage(siteRoot, PACKAGE);
    expect(report.root).toBeNull();
    expect(report.issues).toEqual([]);
  });

  it("catches a Client entrypoint whose directive did not survive the build", () => {
    const siteRoot = writePackage({
      files: { "dist/client.js": "export const phiModuleClientContributions = {};\n" },
    });
    expect(codesFor(siteRoot)).toEqual(["client_directive_missing"]);
  });

  it("reads the directive past leading comments, and not from further down the file", () => {
    expect(codesFor(writePackage({
      files: { "dist/client.js": '/* built by acme */\n"use client";\nexport const x = 1;\n' },
    }))).toEqual([]);
    expect(codesFor(writePackage({
      files: { "dist/client.js": 'export const note = "use client";\n' },
    }))).toEqual(["client_directive_missing"]);
  });

  it("catches a Server entrypoint that declares the Client boundary", () => {
    expect(codesFor(writePackage({
      files: { "dist/server.js": '"use client";\nexport const phiModuleServerContributions = [];\n' },
    }))).toEqual(["server_entry_is_client"]);
  });

  it("catches a missing entrypoint", () => {
    const siteRoot = writePackage({
      manifest: {
        exports: {
          ".": { import: "./dist/index.js" },
          "./server": { import: "./dist/server.js" },
          "./client": { import: "./dist/client.js" },
        },
      },
    });
    expect(codesFor(siteRoot)).toEqual(["entrypoint_missing"]);
  });

  it("catches a shared runtime declared as an ordinary dependency", () => {
    expect(codesFor(writePackage({ manifest: { dependencies: { react: "^19" } } })))
      .toEqual(["runtime_not_peer"]);
  });

  it("catches CSS that a bundler would be free to drop", () => {
    expect(codesFor(writePackage({ files: { "dist/widget.css": ".a{color:red}" } })))
      .toEqual(["css_without_side_effects"]);
    // Stating it is what makes the imports survive; either form of statement counts.
    expect(codesFor(writePackage({
      manifest: { sideEffects: ["**/*.css"] },
      files: { "dist/widget.css": ".a{color:red}" },
    }))).toEqual([]);
  });
});
