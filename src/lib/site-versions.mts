/**
 * Which versions a new Site's `package.json` pins: `@phis/ui` and the framework it was tested with.
 *
 * Nothing here is a version. `@phis/ui` is the newest one published in this Server's own Major.Minor line
 * -- contracts, Server and `@phis/ui` share Major.Minor, and that is the guarantee they work together.
 * Everything else (`next`, `react`, `antd`, the Site's toolchain) is `@phis/ui`'s concern: the package
 * states the exact versions it is built and tested with in `package.json#phis.testedWith`, and that field
 * is read from the registry metadata of the chosen version. Until 2026-11-25 the scaffold kept its own list
 * by hand; it fell months behind, and a clean install pinned a `next` that Next refuses to build.
 *
 * The registry is asked through `npm view`, so the operator's npm configuration -- registry, scope
 * registries, auth, proxy -- applies as it does to the install that follows. When the registry cannot be
 * asked, or the chosen version carries no `phis.testedWith` (0.8.1 and earlier), the set recorded when this
 * CLI was built answers instead (`scripts/build-cli.mjs`, from `readPhiSiteVersionsAtBuild`).
 *
 * Node built-ins only: `scripts/build-cli.mjs` imports this file as it is.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHI_UI_PACKAGE = "@phis/ui";
/** Where in `@phis/ui`'s `package.json` the tested versions stand, as `npm view` names a nested field. */
export const PHI_UI_TESTED_WITH_FIELD = "phis.testedWith";

/** An `@phis/ui` version and the exact versions of everything a Site installs beside it. */
export type PhiSiteVersionSet = {
  uiVersion: string;
  packages: Record<string, string>;
};

export type PhiSiteVersionsResolution = PhiSiteVersionSet & {
  /** `registry`: the chosen `@phis/ui` stated them; `fallback`: the set recorded when this CLI was built. */
  source: "registry" | "fallback";
  /** Why the fallback answered; absent when the registry did. */
  reason?: string;
};

/** What the registry is asked. `readField` answers `undefined` for a field the version does not carry. */
export type PhiPackageRegistry = {
  listVersions(name: string): Promise<string[]>;
  readField(name: string, version: string, field: string): Promise<unknown>;
};

type ParsedVersion = { major: number; minor: number; patch: number; prerelease: (string | number)[] };

const EXACT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function parseVersion(value: string): ParsedVersion | null {
  const match = EXACT_VERSION.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".").map((part) => (/^\d+$/u.test(part) ? Number(part) : part)) : [],
  };
}

/** True for an exact version, as `1.2.3` or `1.0.0-beta.4`; a range is not one. */
export function isPhiExactVersion(value: unknown): value is string {
  return typeof value === "string" && parseVersion(value) !== null;
}

function comparePrerelease(a: (string | number)[], b: (string | number)[]) {
  // A release ranks above its prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function compareVersions(a: ParsedVersion, b: ParsedVersion) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * The newest of `versions` in the Major.Minor line of `serverVersion`.
 *
 * Releases only, unless the Server is a prerelease itself: a `1.0.0-beta.3` Server takes the newest
 * `1.0.x`, betas included, since its line may have no release yet.
 */
export function selectPhiUiVersionInLine(versions: readonly string[], serverVersion: string): string | null {
  const server = parseVersion(serverVersion);
  if (!server) throw new Error(`"${serverVersion}" is not a version this CLI can take its line from.`);
  let best: { value: string; parsed: ParsedVersion } | null = null;
  for (const value of versions) {
    const parsed = parseVersion(value);
    if (!parsed || parsed.major !== server.major || parsed.minor !== server.minor) continue;
    if (parsed.prerelease.length > 0 && server.prerelease.length === 0) continue;
    if (!best || compareVersions(parsed, best.parsed) > 0) best = { value, parsed };
  }
  return best?.value ?? null;
}

/**
 * `phis.testedWith` as `@phis/ui` states it, or null when it is missing or not a map of exact versions.
 * `@phis/ui` itself is never taken from it: its version is the one chosen.
 */
export function readPhiTestedWith(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(([name]) => name !== PHI_UI_PACKAGE);
  if (entries.length === 0 || !entries.every(([, version]) => isPhiExactVersion(version))) return null;
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}

/** A recorded set as the build wrote it, or null for anything else. */
export function readPhiSiteVersionSet(value: unknown): PhiSiteVersionSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { uiVersion?: unknown; packages?: unknown };
  const packages = readPhiTestedWith(record.packages);
  return isPhiExactVersion(record.uiVersion) && packages ? { uiVersion: record.uiVersion, packages } : null;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The versions a Site is pinned to.
 *
 * `uiVersion` names the `@phis/ui` to read the tested versions of -- a Site that pins one exactly already
 * has its own -- and is otherwise the newest of the Server's line. A registry that answers with the field
 * wins; a version without it takes the recorded packages beside the chosen `@phis/ui`; a registry that
 * cannot be asked, or has nothing in the line, takes the recorded set whole. Without a recorded set (a
 * CLI run from source with neither a registry nor a phis-ui checkout beside it) that is an error.
 */
export async function resolvePhiSiteVersions(input: {
  serverVersion: string;
  registry: PhiPackageRegistry;
  fallback: PhiSiteVersionSet | null;
  uiVersion?: string | null;
}): Promise<PhiSiteVersionsResolution> {
  const answerWithFallback = (reason: string, uiVersion?: string): PhiSiteVersionsResolution => {
    if (!input.fallback) {
      throw new Error(
        `${reason}, and this phis carries no Site versions recorded at build time. Run it from a build ` +
        "(pnpm build:cli), with a phis-ui checkout beside phis-server, or where the npm registry answers.",
      );
    }
    return { uiVersion: uiVersion ?? input.fallback.uiVersion, packages: input.fallback.packages, source: "fallback", reason };
  };
  const anchored = input.uiVersion && isPhiExactVersion(input.uiVersion) ? input.uiVersion : null;
  let answer: { chosen: string | null; packages: Record<string, string> | null } | { error: string };
  try {
    const chosen = anchored
      ?? selectPhiUiVersionInLine(await input.registry.listVersions(PHI_UI_PACKAGE), input.serverVersion);
    const packages = chosen
      ? readPhiTestedWith(await input.registry.readField(PHI_UI_PACKAGE, chosen, PHI_UI_TESTED_WITH_FIELD))
      : null;
    answer = { chosen, packages };
  } catch (error) {
    answer = { error: describeError(error) };
  }
  if ("error" in answer) return answerWithFallback(`the npm registry could not be asked (${answer.error})`, anchored ?? undefined);
  if (!answer.chosen) return answerWithFallback(`the registry has no ${PHI_UI_PACKAGE} in the line of phis ${input.serverVersion}`);
  if (answer.packages) return { uiVersion: answer.chosen, packages: answer.packages, source: "registry" };
  return answerWithFallback(`${PHI_UI_PACKAGE} ${answer.chosen} states no ${PHI_UI_TESTED_WITH_FIELD}`, answer.chosen);
}

/** The versions as the scaffold writes them: `@phis/ui` beside the packages it was tested with. */
export function flattenPhiSiteVersions(set: PhiSiteVersionSet): Record<string, string> {
  return { [PHI_UI_PACKAGE]: set.uiVersion, ...set.packages };
}

const NPM_VIEW_TIMEOUT_MS = 30_000;

/**
 * The npm cache `npm view` uses when the environment names none.
 *
 * npm caches under `~/.npm`, and the `phis` service account has no home (`/nonexistent`): every `npm view`
 * it ran failed with EACCES, and `init` fell back to the recorded set without ever asking the registry.
 * An operator who creates this directory for the account (`install -d -o phis -g phis /var/cache/phis-npm`)
 * gives those calls a cache; without it npm keeps its default, which serves every account with a home.
 */
export const PHI_NPM_VIEW_CACHE_DIRECTORY = "/var/cache/phis-npm";

/** An environment as `spawn` takes it. */
type PhiProcessEnvironment = Record<string, string | undefined>;

/** True when the environment sets npm's `cache`; npm reads `npm_config_*` without regard to case. */
function namesNpmCache(env: PhiProcessEnvironment) {
  return Object.entries(env).some(([key, value]) => key.toLowerCase() === "npm_config_cache" && value !== undefined && value !== "");
}

/**
 * The environment `npm view` runs with: the caller's, without npm's update check, and with `npm_config_cache`
 * set to `cacheDirectory` when the caller sets no cache and that directory exists and this process may
 * write to it. Anything else leaves npm its own default.
 */
export async function resolvePhiNpmViewEnvironment(
  env: PhiProcessEnvironment = process.env,
  cacheDirectory: string = PHI_NPM_VIEW_CACHE_DIRECTORY,
): Promise<PhiProcessEnvironment> {
  const resolved: PhiProcessEnvironment = { ...env, NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" };
  if (namesNpmCache(env)) return resolved;
  try {
    if (!(await stat(cacheDirectory)).isDirectory()) return resolved;
    await access(cacheDirectory, fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return resolved;
  }
  return { ...resolved, npm_config_cache: cacheDirectory };
}

function runNpmView(args: readonly string[], cwd: string, timeoutMs: number, env: PhiProcessEnvironment) {
  return new Promise<string>((resolve, reject) => {
    // One try, a bounded wait: an unreachable registry falls back instead of holding `phis init` for the
    // minutes npm's own retries take.
    const child = spawn("npm", ["view", ...args, "--json", "--fetch-retries=0", `--fetch-timeout=${Math.min(timeoutMs, 15_000)}`], {
      cwd,
      // Next's types demand NODE_ENV of every ProcessEnv; npm needs none of it.
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`npm view did not answer within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const summary = /npm error (?!code |errno |syscall |path )(.+)/u.exec(stderr)?.[1]?.trim();
      reject(new Error(`npm view ${args.join(" ")} failed with exit code ${code ?? "unknown"}${summary ? `: ${summary}` : ""}`));
    });
  });
}

/**
 * The registry as `npm view` answers it, run in `cwd` so a project `.npmrc` there applies too.
 *
 * `npm view <name>@<version> <field>` prints nothing for a field the version does not carry.
 */
export function createPhiNpmViewRegistry(options: { cwd: string; timeoutMs?: number }): PhiPackageRegistry {
  const timeoutMs = options.timeoutMs ?? NPM_VIEW_TIMEOUT_MS;
  let environment: Promise<PhiProcessEnvironment> | null = null;
  const view = async (args: readonly string[]) => {
    environment ??= resolvePhiNpmViewEnvironment();
    return runNpmView(args, options.cwd, timeoutMs, await environment);
  };
  return {
    async listVersions(name) {
      const output = await view([name, "versions"]);
      const value = output ? JSON.parse(output) as unknown : [];
      if (typeof value === "string") return [value];
      if (!Array.isArray(value)) throw new Error(`npm view ${name} versions answered no list`);
      return value.filter((entry): entry is string => typeof entry === "string");
    },
    async readField(name, version, field) {
      const output = await view([`${name}@${version}`, field]);
      return output ? JSON.parse(output) as unknown : undefined;
    },
  };
}

/**
 * A phis-ui checkout's own statement, from its `package.json` -- which phis-ui's verification holds to
 * what that checkout has installed. Throws with the reason when it is not in the Server's line or states
 * nothing.
 */
export async function readPhiUiCheckoutVersions(uiRoot: string, serverVersion: string): Promise<PhiSiteVersionSet> {
  const manifestFile = path.join(uiRoot, "package.json");
  let manifest: { name?: unknown; version?: unknown; phis?: { testedWith?: unknown } };
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8")) as typeof manifest;
  } catch (error) {
    throw new Error(`${manifestFile} could not be read (${describeError(error)})`);
  }
  if (manifest.name !== PHI_UI_PACKAGE || !isPhiExactVersion(manifest.version)) {
    throw new Error(`${manifestFile} is no ${PHI_UI_PACKAGE} manifest`);
  }
  if (selectPhiUiVersionInLine([manifest.version], serverVersion) !== manifest.version) {
    throw new Error(`${manifestFile} is ${PHI_UI_PACKAGE} ${manifest.version}, outside the line of ${serverVersion}`);
  }
  const packages = readPhiTestedWith(manifest.phis?.testedWith);
  if (!packages) throw new Error(`${manifestFile} states no ${PHI_UI_TESTED_WITH_FIELD}`);
  return { uiVersion: manifest.version, packages };
}

/**
 * The set `scripts/build-cli.mjs` records into the bundle, for when the registry cannot answer at run time.
 *
 * The registry's newest `@phis/ui` of the line, when it states its tested versions -- that is what a
 * release build in GitHub finds, `@phis/ui` being released before the Server. Otherwise a phis-ui checkout
 * beside phis-server (or at `PHIS_UI_ROOT`), as `readPhiUiCheckoutVersions` reads it. Neither is an error
 * naming both reasons: a CLI built without a set would fail the first offline `phis init` instead.
 */
export async function readPhiSiteVersionsAtBuild(input: {
  serverVersion: string;
  registry: PhiPackageRegistry;
  uiRoot: string;
}): Promise<PhiSiteVersionSet & { source: string }> {
  const reasons: string[] = [];
  try {
    const chosen = selectPhiUiVersionInLine(await input.registry.listVersions(PHI_UI_PACKAGE), input.serverVersion);
    if (chosen) {
      const packages = readPhiTestedWith(await input.registry.readField(PHI_UI_PACKAGE, chosen, PHI_UI_TESTED_WITH_FIELD));
      if (packages) return { uiVersion: chosen, packages, source: `the registry's ${PHI_UI_PACKAGE} ${chosen}` };
      reasons.push(`the registry's ${PHI_UI_PACKAGE} ${chosen} states no ${PHI_UI_TESTED_WITH_FIELD}`);
    } else {
      reasons.push(`the registry has no ${PHI_UI_PACKAGE} in the line of ${input.serverVersion}`);
    }
  } catch (error) {
    reasons.push(`the registry could not be asked (${describeError(error)})`);
  }
  try {
    return { ...await readPhiUiCheckoutVersions(input.uiRoot, input.serverVersion), source: path.join(input.uiRoot, "package.json") };
  } catch (error) {
    reasons.push(describeError(error));
  }
  throw new Error(`No Site versions to record: ${reasons.join("; ")}.`);
}

/** Where a phis-ui checkout is looked for: `PHIS_UI_ROOT`, else beside phis-server. */
export function resolvePhiUiCheckoutRoot(serverRoot: string) {
  return process.env.PHIS_UI_ROOT?.trim() || path.resolve(serverRoot, "..", "phis-ui");
}

/** Replaced by `scripts/build-cli.mjs` with the set it recorded; not defined when phis runs from source. */
declare const __PHIS_SITE_VERSIONS_AT_BUILD__: unknown;

/**
 * The fallback set: the one recorded in the bundle, or -- run from source -- the phis-ui checkout beside
 * this tree, read now. Null when there is neither.
 */
export async function readPhiRecordedSiteVersions(serverVersion: string): Promise<PhiSiteVersionSet | null> {
  if (typeof __PHIS_SITE_VERSIONS_AT_BUILD__ !== "undefined") return readPhiSiteVersionSet(__PHIS_SITE_VERSIONS_AT_BUILD__);
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    return await readPhiUiCheckoutVersions(resolvePhiUiCheckoutRoot(serverRoot), serverVersion);
  } catch {
    return null;
  }
}

async function nearestExistingDirectory(directory: string) {
  let current = path.resolve(directory);
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Not there yet: `init` creates it.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** The `@phis/ui` a Site's `package.json` pins exactly, in either section; null for a range or none. */
export async function readPhiSiteUiPin(siteRoot: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(siteRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const pinned = manifest.dependencies?.[PHI_UI_PACKAGE] ?? manifest.devDependencies?.[PHI_UI_PACKAGE];
    return isPhiExactVersion(pinned) ? pinned : null;
  } catch {
    return null;
  }
}

/**
 * The versions `phis init`, `reconcile` and `update` hand the scaffold.
 *
 * `init` takes the newest `@phis/ui` of the Server's line. `reconcile` and `update` ask for the tested
 * versions of the `@phis/ui` the Site already pins, if it pins one exactly, since they reach only a
 * dependency the Site lacks and that one should match what the Site runs; the Site's own pins are never
 * raised. npm runs in the Site root, or the nearest directory of it that exists, so its `.npmrc` applies.
 */
export async function resolvePhiSiteScaffoldVersions(input: {
  serverVersion: string;
  siteRoot: string;
  mode: "init" | "reconcile";
  registry?: PhiPackageRegistry;
  fallback?: PhiSiteVersionSet | null;
}) {
  const registry = input.registry ?? createPhiNpmViewRegistry({ cwd: await nearestExistingDirectory(input.siteRoot) });
  const fallback = input.fallback === undefined ? await readPhiRecordedSiteVersions(input.serverVersion) : input.fallback;
  const uiVersion = input.mode === "reconcile" ? await readPhiSiteUiPin(input.siteRoot) : null;
  return resolvePhiSiteVersions({ serverVersion: input.serverVersion, registry, fallback, uiVersion });
}
