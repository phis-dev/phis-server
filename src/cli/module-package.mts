import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  isPhiRuntimeModuleCategory,
  readPhisModulePackageDeclaration,
  type PhisModulePackageDeclaration,
} from "@phis/contracts/catalog";

/**
 * What a Module package has to look like once it is built, checked where it arrives.
 *
 * A Module package is consumed by the Site's bundler, not by this process, so the three ways it can be
 * wrong all fail late: at the Site's build, or -- worse -- at runtime in somebody's browser. They are
 * cheap to see from the outside, so they are looked at here instead.
 *
 * Nothing is loaded to do it. The files are read as text, exactly as `phis module` reads nothing else
 * about a Module either.
 */

export type PhiSiteModulePackageIssueCode =
  | "entrypoint_missing"
  | "client_directive_missing"
  | "server_entry_is_client"
  | "runtime_not_peer"
  | "vendored_dependencies"
  | "css_without_side_effects"
  | "declaration_missing"
  | "declaration_invalid"
  | "declaration_foreign_module"
  | "declaration_unknown_category"
  | "server_only_in_client_graph";

export type PhiSiteModulePackageIssue = {
  code: PhiSiteModulePackageIssueCode;
  message: string;
};

export type PhiSiteModulePackageReport = {
  packageName: string;
  /** Null when the package is not installed yet, which is not a fault of the package. */
  root: string | null;
  issues: PhiSiteModulePackageIssue[];
};

/** The four fixed subpaths, and whether each one has to be a Client module. */
const ENTRYPOINTS = [
  { subpath: ".", client: false },
  { subpath: "./server", client: false },
  { subpath: "./client", client: true },
  { subpath: "./authoring-client", client: true },
] as const;

const SHARED_RUNTIMES = ["react", "@phis/ui"] as const;

/** The three whose graph the browser gets. `./server` may reach whatever it likes. */
const CLIENT_REACHABLE = [".", "./client", "./authoring-client"] as const;

type PackageManifest = {
  name?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  sideEffects?: unknown;
  phis?: { serverOnlyExports?: unknown };
};

/**
 * The target one export subpath points at.
 *
 * Only the shapes a Module package actually uses are resolved. Conditions beyond `import` and `default`
 * would be a package doing something more elaborate than the contract asks for, and guessing at it here
 * would report a fault that is really this function's.
 */
function resolveExportTarget(manifest: PackageManifest, subpath: string) {
  const entry = manifest.exports?.[subpath];
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object") {
    const conditions = entry as Record<string, unknown>;
    for (const key of ["import", "default"]) {
      if (typeof conditions[key] === "string") {
        return conditions[key] as string;
      }
    }
  }
  return null;
}

/**
 * Whether a compiled file declares the Client boundary.
 *
 * The directive has to be the first statement, so leading comments are stepped over and nothing else
 * is. A file that merely contains the string somewhere below is not a Client module, and reporting it
 * as one would hide the fault rather than find it.
 */
function declaresClientBoundary(source: string) {
  let rest = source.replace(/^#![^\n]*\n/, "").trimStart();
  while (rest.startsWith("//") || rest.startsWith("/*")) {
    const end = rest.startsWith("//")
      ? rest.indexOf("\n")
      : rest.indexOf("*/") + 2;
    if (end <= 0) {
      return false;
    }
    rest = rest.slice(end).trimStart();
  }
  return /^["']use client["']\s*;?/.test(rest);
}

function collectFiles(root: string, depth = 0): string[] {
  if (depth > 12 || !existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(full, depth + 1));
    } else {
      found.push(full);
    }
  }
  return found;
}

function statesCssSideEffects(sideEffects: unknown) {
  if (sideEffects === undefined || sideEffects === true) {
    // Absent means "assume everything has side effects", which is the safe default for CSS.
    return true;
  }
  if (Array.isArray(sideEffects)) {
    return sideEffects.some((pattern) => typeof pattern === "string" && pattern.includes(".css"));
  }
  return false;
}

/**
 * Whether an installed package declares typefaces through a `./fonts` boundary.
 *
 * The one entrypoint that cannot be read at all: it calls `next/font/local` at module scope, which
 * throws outside a Next build, and `phis module` loads no Module anyway. What it can see is the
 * package's own manifest in the Site's `node_modules` -- the same file `check` reads the four fixed
 * entrypoints from -- so the export map is taken as the declaration.
 *
 * The subpath is optional, so its absence is an answer and not a fault. A package that exports it and
 * ships no file behind it is a broken package and says so at the Site's build; leaving it out of the
 * projection here would instead be a Site whose Modules quietly render in the core families.
 */
export function siteModulePackageDeclaresFonts(siteRoot: string, packageName: string) {
  const manifestFile = path.join(
    siteRoot,
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
  if (!existsSync(manifestFile)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PackageManifest;
  return resolveExportTarget(manifest, "./fonts") !== null;
}

/*
 * Which of a dependency's doors may not be opened from a file the browser reaches.
 *
 * Read from the dependency itself rather than known here: `@phis/ui` walks its own export map and
 * records the subpaths whose graph reaches `server-only` or `next/headers`
 * (`scripts/validate-module-boundary-exports.mjs`). A package that states nothing is not assumed to be
 * safe -- there is simply nothing to check it against, and inventing a list would report faults that
 * are this function's.
 */
function readServerOnlyExports(siteRoot: string, packageName: string) {
  const manifestFile = path.join(siteRoot, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(manifestFile)) {
    return null;
  }
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PackageManifest;
  } catch {
    return null;
  }
  const declared = manifest.phis?.serverOnlyExports;
  return Array.isArray(declared)
    ? new Set(declared.filter((entry): entry is string => typeof entry === "string"))
    : null;
}

/** `@scope/name/a/b` -> the package and `./a/b`; a bare name -> the package and `.`. */
function splitSpecifier(specifier: string) {
  const segments = specifier.split("/");
  const owned = specifier.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  const rest = segments.slice(owned.length);
  return { packageName: owned.join("/"), subpath: rest.length > 0 ? `./${rest.join("/")}` : "." };
}

const STATIC_IMPORT_PATTERN =
  /(?:^|\n)\s*((?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\2|import\s*(['"])([^'"]+)\4)/g;

/**
 * The specifiers a built file imports eagerly.
 *
 * Comments are stripped first, because a comment quotes an import as often as code makes one. A
 * multi-line `export { ... } from "..."` counts: those are what a barrel is made of, and a pattern that
 * required one line would miss exactly the edge this check exists for. `import type` cannot appear in
 * built JavaScript, so nothing has to be filtered out.
 *
 * Static edges only. A `dynamic(() => import(...))` is its own chunk and its own question; what makes a
 * barrel dangerous is that it arrives with whatever imported it.
 */
function readStaticSpecifiers(source: string) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const specifiers: string[] = [];
  for (const match of code.matchAll(STATIC_IMPORT_PATTERN)) {
    const specifier = match[3] ?? match[5];
    if (specifier) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The first server-only door a Client-reachable file opens, and how it was reached.
 *
 * The definition is the reason this matters: the generated Client projection imports
 * `phiModuleDefinitions` from the package root, so everything the root's graph touches is in the
 * browser graph. A `server-only` module there does not fail to compile -- it answers 500 on every page
 * of the Site, with an import trace that names the barrel and not the file that reached for it.
 */
function findServerOnlyReach(root: string, siteRoot: string, manifest: PackageManifest) {
  const lists = new Map<string, Set<string> | null>();
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [];

  for (const subpath of CLIENT_REACHABLE) {
    const target = resolveExportTarget(manifest, subpath);
    const file = target ? path.join(root, target) : null;
    if (file && existsSync(file)) {
      queue.push({ file, trail: [target as string] });
    }
  }

  while (queue.length > 0) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of readStaticSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const next = resolveRelative(file, specifier);
        if (next) {
          queue.push({ file: next, trail: [...trail, path.relative(root, next)] });
        }
        continue;
      }
      const { packageName, subpath } = splitSpecifier(specifier);
      if (!lists.has(packageName)) {
        lists.set(packageName, readServerOnlyExports(siteRoot, packageName));
      }
      if (lists.get(packageName)?.has(subpath)) {
        return { specifier, trail };
      }
    }
  }
  return null;
}

export function inspectSiteModulePackage(
  siteRoot: string,
  packageName: string,
): PhiSiteModulePackageReport {
  const root = path.join(siteRoot, "node_modules", ...packageName.split("/"));
  const manifestFile = path.join(root, "package.json");
  if (!existsSync(manifestFile)) {
    return { packageName, root: null, issues: [] };
  }

  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as PackageManifest;
  const issues: PhiSiteModulePackageIssue[] = [];

  for (const entrypoint of ENTRYPOINTS) {
    const target = resolveExportTarget(manifest, entrypoint.subpath);
    if (!target) {
      issues.push({
        code: "entrypoint_missing",
        message: `"${entrypoint.subpath}" is not exported. A Module package exports all four subpaths.`,
      });
      continue;
    }
    const file = path.join(root, target);
    if (!existsSync(file)) {
      issues.push({
        code: "entrypoint_missing",
        message: `"${entrypoint.subpath}" points at ${target}, which is not in the package.`,
      });
      continue;
    }
    const declares = declaresClientBoundary(readFileSync(file, "utf8"));
    if (entrypoint.client && !declares) {
      issues.push({
        code: "client_directive_missing",
        message:
          `${target} does not begin with "use client". The directive has to survive the package's own ` +
          `build; bundlers that merge modules tend to drop it, and the Site then fails at render.`,
      });
    }
    if (!entrypoint.client && declares) {
      issues.push({
        code: "server_entry_is_client",
        message: `${target} begins with "use client", but "${entrypoint.subpath}" is a Server entrypoint.`,
      });
    }
  }

  /*
   * What the package says it carries.
   *
   * The fourth way to be wrong, and the only one that fails nowhere: a package with no declaration
   * installs and renders perfectly and is simply never listed, because a catalogue that cannot run a
   * Module has no other way to learn what it is for. Read as text like everything else here.
   */
  let declaration: PhisModulePackageDeclaration | null = null;
  let declarationReadable = true;
  try {
    declaration = readPhisModulePackageDeclaration(manifest);
  } catch (error) {
    declarationReadable = false;
    issues.push({
      code: "declaration_invalid",
      message:
        `${error instanceof Error ? error.message : String(error)} ` +
        "A marketplace refuses a package whose declaration it cannot read.",
    });
  }
  if (declarationReadable && (declaration === null || declaration.modules.length === 0)) {
    issues.push({
      code: "declaration_missing",
      message:
        'The package declares no Modules under "phis" in its package.json. A catalogue cannot run a ' +
        "Module to find out what it is for, so an undeclared package is refused rather than guessed at.",
    });
  }
  for (const entry of declaration?.modules ?? []) {
    if (!entry.moduleId.startsWith(`${packageName}/`)) {
      issues.push({
        code: "declaration_foreign_module",
        message:
          `"${entry.moduleId}" is declared but does not belong to ${packageName}. One package carries ` +
          "one product, so every Module it declares is its own.",
      });
    }
    if (!isPhiRuntimeModuleCategory(entry.category)) {
      issues.push({
        code: "declaration_unknown_category",
        message:
          `"${entry.category}" is not a category this release offers. The list may have grown since ` +
          "this server was built -- the marketplace decides at intake, and this is a warning, not that " +
          "verdict.",
      });
    }
  }

  for (const runtime of SHARED_RUNTIMES) {
    if (manifest.dependencies?.[runtime]) {
      issues.push({
        code: "runtime_not_peer",
        message:
          `${runtime} is a dependency. It has to be a peer dependency, so the Site resolves one copy: ` +
          `a second React means broken hooks, a second @phis/ui means a second set of contexts.`,
      });
    }
  }

  /*
   * A nested node_modules is not itself the fault -- a linked workspace package always has one, and a
   * published tarball never ships it. What matters is whether a shared runtime in there is a different
   * copy from the Site's, because that is the one that produces two Reacts. Same realpath, same module,
   * nothing to report.
   */
  for (const runtime of SHARED_RUNTIMES) {
    const nested = path.join(root, "node_modules", ...runtime.split("/"));
    if (!existsSync(nested)) {
      continue;
    }
    const siteCopy = path.join(siteRoot, "node_modules", ...runtime.split("/"));
    const shared = existsSync(siteCopy) && realpathSync(nested) === realpathSync(siteCopy);
    if (!shared) {
      issues.push({
        code: "vendored_dependencies",
        message:
          `The package carries its own copy of ${runtime}, which is resolved instead of the Site's. ` +
          `Two copies of React mean broken hooks; two of @phis/ui mean two sets of contexts.`,
      });
    }
  }

  const files = collectFiles(root);
  if (files.some((file) => file.endsWith(".css")) && !statesCssSideEffects(manifest.sideEffects)) {
    issues.push({
      code: "css_without_side_effects",
      message:
        'The package ships CSS but states no side effects, so a bundler may drop the imports. State ' +
        'sideEffects: ["**/*.css"] instead of false.',
    });
  }

  const serverOnly = findServerOnlyReach(root, siteRoot, manifest);
  if (serverOnly) {
    issues.push({
      code: "server_only_in_client_graph",
      message:
        `${serverOnly.trail.join(" -> ")} imports "${serverOnly.specifier}", which that package ` +
        "states is server-only. Reached from an entrypoint the browser gets, so the Site answers 500 " +
        "on every page rather than failing to build. Import it only from ./server, or take the " +
        "narrower door.",
    });
  }

  return { packageName, root, issues };
}
