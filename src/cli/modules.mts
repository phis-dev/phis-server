import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { siteModulePackageDeclaresFonts } from "./module-package.mts";

/**
 * What Site Modules an operator installed, and the projection generated from it.
 *
 * A Module reaches a Site through a generated file the Area hosts are handed. `phis module` owns that
 * file: it writes a list of imports and one call, and never loads a Module to do it. A Module's
 * boundaries include TSX and Client code that has no business running inside a command-line tool, and
 * the placement into Areas happens where the projection is imported instead.
 *
 * The desired state is per Site because a Module is a property of one Site's build, unlike a server
 * Add-on which is installed once for the machine.
 */

export type PhiSiteModuleEntry = {
  packageName: string;
  origin: "local" | "resolved" | "source";
  spec?: string;
};

export type PhiSiteModuleDesiredState = {
  formatVersion: 1;
  sites: Record<string, { modules: PhiSiteModuleEntry[] }>;
};

const PROJECTION_SERVER = "src/generated/site-modules.ts";
const PROJECTION_CLIENT = "src/generated/site-modules-client.ts";
const PROJECTION_AUTHORING_CLIENT = "src/generated/site-modules-authoring-client.ts";
const PROJECTION_FONTS = "src/generated/site-modules-fonts.ts";

function desiredStatePath(root: string) {
  return path.join(root, "config", "phis-modules.json");
}

function writeAtomic(filePath: string, content: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, filePath);
}

/**
 * Absence is an empty state, not an error.
 *
 * An installation that never added a Module has no file, and refusing to read one would make every
 * `module list` on a fresh machine look like a fault.
 */
export function readSiteModuleDesiredState(root: string): PhiSiteModuleDesiredState {
  const file = desiredStatePath(root);
  if (!existsSync(file)) {
    return { formatVersion: 1, sites: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = parsed as Partial<PhiSiteModuleDesiredState>;
  if (state?.formatVersion !== 1 || typeof state.sites !== "object" || state.sites === null) {
    throw new Error(`Invalid Site Module desired state in ${file}.`);
  }
  for (const [siteKey, site] of Object.entries(state.sites)) {
    if (!Array.isArray(site?.modules)) {
      throw new Error(`Invalid Site Module desired state for site "${siteKey}" in ${file}.`);
    }
  }
  return state as PhiSiteModuleDesiredState;
}

export function writeSiteModuleDesiredState(root: string, state: PhiSiteModuleDesiredState) {
  writeAtomic(desiredStatePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * A stable, collision-free local name for a package inside the generated file.
 *
 * Derived from the package name rather than numbered, so a diff of the projection shows which Module
 * changed instead of everything shifting when one is removed from the middle.
 */
function importAlias(packageName: string) {
  const cleaned = packageName.replace(/^@/, "").replace(/[^A-Za-z0-9]+/g, "_");
  return `m_${cleaned}`;
}

/**
 * Refuses two packages that would share an import alias.
 *
 * The alias folds every run of other characters into `_`, so `@acme/foo-bar` and `@acme/foo_bar` are
 * both `m_acme_foo_bar`, and the generated file would declare one binding twice -- a build error in the
 * Site, far from the install that caused it.
 */
function assertDistinctImportAliases(packageNames: readonly string[]) {
  const byAlias = new Map<string, string>();
  for (const packageName of packageNames) {
    const alias = importAlias(packageName);
    const other = byAlias.get(alias);
    if (other !== undefined && other !== packageName) {
      throw new Error(
        `Modules ${other} and ${packageName} would share the import alias ${alias}; ` +
        "install only one of them.",
      );
    }
    byAlias.set(alias, packageName);
  }
}

/**
 * The four generated files, from the installed Modules and the subset of them that ships typefaces.
 *
 * `fontPackages` is passed in rather than read here, because it is the one part of the projection that
 * is not in the desired state: a `./fonts` boundary is a property of the package on disk, and this
 * function stays a pure rendering of a list so a test can state both halves.
 */
export function buildSiteModuleProjection(
  modules: readonly PhiSiteModuleEntry[],
  fontPackages: readonly string[],
) {
  const sorted = [...modules].sort((left, right) => left.packageName.localeCompare(right.packageName));
  assertDistinctImportAliases(sorted.map((entry) => entry.packageName));
  const withFonts = sorted.filter((entry) => fontPackages.includes(entry.packageName));

  const serverImports = sorted.map((entry) =>
    `import { phiModuleServerContributions as ${importAlias(entry.packageName)} } from "${entry.packageName}/server";`
  );
  const server = [
    ...serverImports,
    `import { collectPhiSiteModuleServerAreaContributions } from "@phis/ui/module/projection";`,
    "",
    "/**",
    " * Generated by `phis module`. Do not edit.",
    " *",
    " * Placement into Areas happens inside the call, from each Module's own `eligibleAreas`.",
    " */",
    "export const PHI_SITE_MODULES = collectPhiSiteModuleServerAreaContributions([",
    ...sorted.map((entry) => `  ...${importAlias(entry.packageName)},`),
    "]);",
    "",
  ].join("\n");

  const clientImports = sorted.flatMap((entry) => {
    const alias = importAlias(entry.packageName);
    return [
      `import { phiModuleDefinitions as ${alias}_definitions } from "${entry.packageName}";`,
      `import { phiModuleClientContributions as ${alias}_client } from "${entry.packageName}/client";`,
    ];
  });
  const client = [
    '"use client";',
    "",
    ...clientImports,
    `import { collectPhiSiteModuleClientContributions } from "@phis/ui/module/projection/client";`,
    "",
    "/**",
    " * Generated by `phis module`. Do not edit. The Client counterpart of `site-modules.ts`.",
    " *",
    " * Carries no Authoring import. Every Area host imports this file, and a bundler packs whatever a",
    " * value here can reach -- which is how the Builder's table controls once ended up on the Public",
    " * landing page. The Authoring half lives in `site-modules-authoring-client.ts`.",
    " */",
    "export const PHI_SITE_MODULES_CLIENT = collectPhiSiteModuleClientContributions({",
    `  definitions: [${sorted.map((entry) => `...${importAlias(entry.packageName)}_definitions`).join(", ")}],`,
    `  clients: [${sorted.map((entry) => `${importAlias(entry.packageName)}_client`).join(", ")}],`,
    "});",
    "",
  ].join("\n");

  const authoringImports = sorted.flatMap((entry) => {
    const alias = importAlias(entry.packageName);
    return [
      `import { phiModuleDefinitions as ${alias}_definitions } from "${entry.packageName}";`,
      `import { phiModuleAuthoringContributions as ${alias}_authoring } from "${entry.packageName}/authoring-client";`,
    ];
  });
  const authoringClient = [
    '"use client";',
    "",
    ...authoringImports,
    `import { collectPhiSiteModuleAuthoringContributions } from "@phis/ui/module/projection/authoring-client";`,
    "",
    "/**",
    " * Generated by `phis module`. Do not edit. The Authoring half of the Client projection.",
    " *",
    " * Imported by the Builder Area host and by nothing else. Authoring implementations must not reach a",
    " * live Area graph, and separating the file is what keeps that true -- separating the type is not.",
    " */",
    "export const PHI_SITE_MODULES_AUTHORING_CLIENT = collectPhiSiteModuleAuthoringContributions({",
    `  definitions: [${sorted.map((entry) => `...${importAlias(entry.packageName)}_definitions`).join(", ")}],`,
    `  authoring: [${sorted.map((entry) => `...${importAlias(entry.packageName)}_authoring`).join(", ")}],`,
    "});",
    "",
  ].join("\n");

  /*
   * The typefaces, imported by the root layout and by nothing else.
   *
   * A file of its own rather than a field of the Server projection: the `./fonts` boundary calls
   * `next/font/local` at module scope, and every import of it outside a Next build throws. Only the
   * packages that export the subpath appear, so a Site whose Modules ship no lettering imports nothing
   * -- the file is then an empty list, which is what the root layout composes the core catalogue from.
   */
  const fonts = [
    ...withFonts.map((entry) =>
      `import { phiModuleFontContributions as ${importAlias(entry.packageName)} } from "${entry.packageName}/fonts";`
    ),
    ...(withFonts.length > 0 ? [""] : []),
    "/**",
    " * Generated by `phis module`. Do not edit.",
    " *",
    " * Only the packages that export a `./fonts` boundary appear here; the root layout composes the font",
    " * catalogue from them once.",
    " */",
    "export const PHI_SITE_MODULE_FONTS = [",
    ...withFonts.map((entry) => `  ...${importAlias(entry.packageName)},`),
    "];",
    "",
  ].join("\n");

  return { server, client, authoringClient, fonts };
}

/**
 * Writes the projection into a Site's build state.
 *
 * All four files are replaced together. A half-written projection would compile -- the Server half
 * without its Client half is a Module whose Widgets resolve to nothing -- so none is written in place.
 *
 * Which packages ship typefaces is read from the Site's `node_modules` here, and not recorded in the
 * desired state: a package answers for its own boundaries, and an installed version that gains or loses
 * a `./fonts` export would leave a recorded answer stale. A package that is not installed yet reads as
 * one without typefaces, which is why `add` points at `sync` for the run after the install.
 */
export function writeSiteModuleProjection(siteRoot: string, modules: readonly PhiSiteModuleEntry[]) {
  const fontPackages = modules
    .map((entry) => entry.packageName)
    .filter((packageName) => siteModulePackageDeclaresFonts(siteRoot, packageName));
  const { server, client, authoringClient, fonts } = buildSiteModuleProjection(modules, fontPackages);
  writeAtomic(path.join(siteRoot, PROJECTION_SERVER), server);
  writeAtomic(path.join(siteRoot, PROJECTION_CLIENT), client);
  writeAtomic(path.join(siteRoot, PROJECTION_AUTHORING_CLIENT), authoringClient);
  writeAtomic(path.join(siteRoot, PROJECTION_FONTS), fonts);
  return {
    files: [PROJECTION_SERVER, PROJECTION_CLIENT, PROJECTION_AUTHORING_CLIENT, PROJECTION_FONTS],
    moduleCount: modules.length,
    fontPackages,
  };
}

/**
 * Adds the package to the Site's dependencies when a spec is given.
 *
 * Without one the package is assumed to be resolvable already -- a workspace package, or one the
 * package manager installed. `phis module` does not fetch anything: acquisition is a separate step, and
 * conflating them would make an install look like it had verified something it never saw.
 */
export function addSiteModuleDependency(siteRoot: string, packageName: string, spec: string) {
  const file = path.join(siteRoot, "package.json");
  if (!existsSync(file)) {
    throw new Error(`Site has no package.json at ${file}.`);
  }
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = { ...manifest.dependencies, [packageName]: spec };
  manifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  );
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function removeSiteModuleDependency(siteRoot: string, packageName: string) {
  const file = path.join(siteRoot, "package.json");
  if (!existsSync(file)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(file, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  if (!manifest.dependencies?.[packageName]) {
    return false;
  }
  delete manifest.dependencies[packageName];
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}
