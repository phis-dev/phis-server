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
  | "declaration_unknown_category";

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

type PackageManifest = {
  name?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  sideEffects?: unknown;
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

  return { packageName, root, issues };
}
