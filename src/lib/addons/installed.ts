import "server-only";

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getDefaultServerPhiRoot } from "@/lib/config-files";
import {
  resolvePhisAddonArtifactPath,
  resolvePhisAddonInstallRoot,
} from "@/lib/addons/install-root";
import { validatePhisAddonDesiredState } from "@/lib/addons/manifest";
import type {
  PhisAddonBuildEntry,
  PhisAddonBuildManifest,
  PhisAddonDesiredStateEntry,
  PhisAddonRuntimeModuleV1,
} from "@/lib/addons/contract";

/**
 * What this release can load, read at runtime instead of compiled in.
 *
 * The generated build manifest this replaces made the set of loadable Add-ons a property of the
 * build, which is why installing one used to mean rebuilding and restarting every tenant on the
 * instance. The set is now deployment state: `config/phis-addons.json` says what is installed, the
 * install root holds the artifacts, and the database still decides what may run.
 *
 * Nothing here weakens the rule the generated file existed for. The import specifier is derived from
 * the Add-on id under a fixed root and is never a stored string, the digest is verified against the
 * bytes before the first load, and an entry whose artifact is missing or altered is refused rather
 * than loaded.
 */

type CachedDesiredState = {
  signature: string;
  entries: PhisAddonBuildManifest;
};

let cache: CachedDesiredState | null = null;

function getDesiredStatePath() {
  return path.join(getDefaultServerPhiRoot(), "config", "phis-addons.json");
}

/** Cheap enough to do per read, and it is what lets an installation take effect without a restart. */
function readDesiredStateSignature(filePath: string) {
  try {
    const stats = statSync(filePath);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "absent";
  }
}

export class PhisAddonArtifactError extends Error {
  readonly addonId: string;
  readonly reason: "missing" | "digest-mismatch";

  constructor(addonId: string, reason: "missing" | "digest-mismatch", detail: string) {
    super(`Add-on ${addonId} artifact ${reason}: ${detail}`);
    this.name = "PhisAddonArtifactError";
    this.addonId = addonId;
    this.reason = reason;
  }
}

/**
 * Verifies the artifact against the digest the operator recorded, then loads it.
 *
 * The digest travels in the query string, which is what makes an upgrade possible at all: Node cannot
 * unload an ES module, but a different specifier is a different module, so the next dispatch after a
 * new digest reaches the new code while requests already in flight finish on the old one.
 */
async function loadArtifact(entry: PhisAddonDesiredStateEntry) {
  const installRoot = resolvePhisAddonInstallRoot(getDefaultServerPhiRoot());
  const artifactPath = resolvePhisAddonArtifactPath(
    installRoot,
    entry.addonId,
    entry.packageVersion,
  );

  let bytes: Buffer;
  try {
    bytes = readFileSync(artifactPath);
  } catch (error) {
    throw new PhisAddonArtifactError(
      entry.addonId,
      "missing",
      `${artifactPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.artifactDigest) {
    throw new PhisAddonArtifactError(
      entry.addonId,
      "digest-mismatch",
      `expected ${entry.artifactDigest}, found ${digest}`,
    );
  }

  const specifier = `${pathToFileURL(artifactPath).href}?v=${entry.artifactDigest}`;
  return (await import(/* turbopackIgnore: true */ specifier)) as PhisAddonRuntimeModuleV1;
}

function toBuildEntry(entry: PhisAddonDesiredStateEntry): PhisAddonBuildEntry {
  return {
    enabled: entry.enabled,
    manifestDigest: entry.manifestDigest,
    manifest: entry.manifest,
    load: () => loadArtifact(entry),
  };
}

export function getPhisAddonInstalledManifest(): PhisAddonBuildManifest {
  const filePath = getDesiredStatePath();
  const signature = readDesiredStateSignature(filePath);
  if (cache && cache.signature === signature) {
    return cache.entries;
  }

  let entries: PhisAddonBuildManifest = Object.freeze({});
  if (signature !== "absent") {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const validation = validatePhisAddonDesiredState(parsed);
    if (!validation.state) {
      // An unreadable desired state is an empty one: no Add-on becomes reachable by accident.
      throw new Error(
        `Add-on desired state at ${filePath} is invalid: ${validation.issues.join("; ")}`,
      );
    }
    entries = Object.freeze(
      Object.fromEntries(
        validation.state.addons.map((entry) => [entry.addonId, toBuildEntry(entry)]),
      ),
    );
  }

  cache = { signature, entries };
  return entries;
}
