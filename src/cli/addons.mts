import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Pool } from "pg";
import packageJson from "../../package.json" with { type: "json" };

import {
  migratePhisAddon,
  purgePhisAddon,
} from "../db/server-addon-migrate.mts";
import {
  reconcilePhisAddons,
  type PhisAddonReconcileEntry,
} from "../db/server-addon-reconcile.mts";

import { type PhisAddonDesiredState } from "../lib/addons/contract.ts";
import { PHIS_CORE_CAPABILITIES } from "../lib/addons/core-capabilities.ts";
import { phiServerAddonUnindexedSearches } from "../lib/addons/query-descriptor.ts";
import { ensurePhisAddonSiteGroups } from "../db/server-addon-groups.mts";
import {
  readPhisAddonEnabledSiteIds,
  recordPhisAddonSiteEffectiveStatus,
} from "../db/server-addon-sites.mts";
import {
  resolvePhisAddonArtifactPath,
  resolvePhisAddonInstallRoot,
  resolvePhisAddonVersionDirectory,
} from "../lib/addons/install-root.ts";
import {
  assertPhisAddonManifest,
  digestPhisAddonManifest,
  validatePhisAddonDesiredState,
} from "../lib/addons/manifest.ts";

type FlagMap = Map<string, string | boolean>;

type AddonArtifactModule = {
  phiServerAddon?: {
    manifest?: unknown;
    serviceFactories?: Record<string, (config: unknown, context: unknown) => unknown>;
  };
};

type LoadedAddon = PhisAddonReconcileEntry;

function getOptionalFlag(flags: FlagMap, key: string) {
  const value = flags.get(key);
  return typeof value === "string" ? value.trim() : undefined;
}

function getRequiredFlag(flags: FlagMap, key: string) {
  const value = getOptionalFlag(flags, key);
  if (!value) {
    throw new Error(`Missing --${key}.`);
  }
  return value;
}

function getAddonPaths(root: string) {
  return {
    desiredState: path.join(root, "config", "phis-addons.json"),
    installRoot: resolvePhisAddonInstallRoot(root),
  };
}

function digestArtifact(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeAtomic(filePath: string, content: string) {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, filePath);
}

/**
 * Replaces an artifact through a rename rather than in place.
 *
 * A process that already loaded the old bytes keeps its own handle, so a same-version replacement --
 * a security patch that does not move the version -- cannot pull the file out from under it.
 */
function writeArtifactAtomic(filePath: string, bytes: Buffer) {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, bytes);
  renameSync(temporaryPath, filePath);
}

export function readAddonDesiredState(root: string) {
  const { desiredState } = getAddonPaths(root);
  if (!existsSync(desiredState)) {
    throw new Error(`Missing Add-on desired state: ${desiredState}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(desiredState, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse ${desiredState}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const result = validatePhisAddonDesiredState(parsed);
  if (!result.state) {
    throw new Error(`Invalid Add-on desired state:\n- ${result.issues.join("\n- ")}`);
  }
  return result.state;
}

/**
 * The stored state as data, for commands that change or merely describe it.
 *
 * `readAddonDesiredState` refuses a state it cannot validate, which is right for anything that is about
 * to *run* an Add-on and wrong for everything else. A Core release that renames a capability or a service
 * kind can invalidate a stored manifest through no fault of the operator -- and then the strict read
 * locked them out of `remove` and `upgrade` as well, so the only way back was a text editor. The way out
 * of a broken state must not require the state to be intact.
 *
 * Entries are returned as they were parsed, unvalidated, and typed as entries deliberately: here they
 * are rows to be listed, replaced or deleted, never manifests to be executed. What gets *written* is
 * still validated, which is the check that matters.
 */
export function readAddonDesiredStateForChange(root: string): {
  state: PhisAddonDesiredState;
  invalid: { addonId: string; issues: string[] }[];
} {
  const { desiredState } = getAddonPaths(root);
  if (!existsSync(desiredState)) {
    throw new Error(`Missing Add-on desired state: ${desiredState}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(desiredState, "utf8")) as unknown;
  } catch (error) {
    // A file that is not JSON is not a state with a broken entry -- there is nothing to recover.
    throw new Error(
      `Could not parse ${desiredState}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const strict = validatePhisAddonDesiredState(parsed);
  if (strict.state) {
    return { state: strict.state, invalid: [] };
  }

  const raw = parsed as { addons?: unknown };
  const entries = Array.isArray(raw.addons) ? raw.addons : [];
  const invalid: { addonId: string; issues: string[] }[] = [];
  for (const entry of entries) {
    const one = validatePhisAddonDesiredState({ formatVersion: 1, addons: [entry] });
    if (!one.state) {
      const addonId = (entry as { addonId?: unknown }).addonId;
      invalid.push({
        addonId: typeof addonId === "string" ? addonId : "(unnamed)",
        issues: one.issues,
      });
    }
  }
  if (invalid.length === 0) {
    // The entries are each fine, so the fault is in the envelope, and that is not an entry to remove.
    throw new Error(`Invalid Add-on desired state:\n- ${strict.issues.join("\n- ")}`);
  }
  return {
    state: { formatVersion: 1, addons: entries as PhisAddonDesiredState["addons"] },
    invalid,
  };
}

function writeAddonDesiredState(root: string, state: PhisAddonDesiredState) {
  const sorted: PhisAddonDesiredState = {
    formatVersion: 1,
    addons: [...state.addons].sort((left, right) =>
      left.addonId.localeCompare(right.addonId),
    ),
  };
  writeAtomic(
    getAddonPaths(root).desiredState,
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}

/**
 * Reads the manifest out of an artifact by importing it once.
 *
 * This is the moment the no-top-level-side-effects rule pays for itself: it runs on an operator's
 * machine, before the Add-on is enabled and before any request has reached it, for an artifact that
 * may then be rejected. The digest in the specifier keeps a re-read of a changed file from being
 * answered out of the module cache.
 */
async function loadArtifactManifest(artifactPath: string, artifactDigest: string) {
  let imported: AddonArtifactModule;
  try {
    const specifier = `${pathToFileURL(artifactPath).href}?v=${artifactDigest}`;
    imported = (await import(specifier)) as AddonArtifactModule;
  } catch (error) {
    throw new Error(
      `Could not load the Add-on artifact ${artifactPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!imported.phiServerAddon) {
    throw new Error(
      `${artifactPath} does not export phiServerAddon. An artifact has exactly one export.`,
    );
  }

  return assertPhisAddonManifest(imported.phiServerAddon.manifest);
}

/**
 * Reads what is installed, and checks the three things that have to agree.
 *
 * The descriptors are in the desired state, the code is in the install root, and the two digests bind
 * them: the manifest digest covers the descriptors, the artifact digest covers the file. Reading the
 * descriptors from the entry rather than from the artifact is what lets the server learn what an
 * Add-on declares without evaluating it.
 */
/**
 * Loads an installed Add-on's runtime the way the Server would.
 *
 * The CLI cannot import the Server's loader -- it runs as plain Node without the application's path
 * aliases -- so the three steps are repeated here: derive the address, verify the artifact against the
 * digest the desired state records, import it. What must not be duplicated is what the artifact then
 * does; a Provider is built by calling the artifact's own factory, never by a second implementation.
 */
export async function loadInstalledAddonRuntime(root: string, addonId: string) {
  const state = readAddonDesiredState(root);
  const entry = state.addons.find((addon) => addon.addonId === addonId);
  if (!entry) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }

  const { installRoot } = getAddonPaths(root);
  const artifactPath = resolvePhisAddonArtifactPath(
    installRoot,
    entry.addonId,
    entry.packageVersion,
  );
  if (!existsSync(artifactPath)) {
    throw new Error(`Add-on ${addonId} has no artifact at ${artifactPath}.`);
  }
  const artifactDigest = digestArtifact(readFileSync(artifactPath));
  if (artifactDigest !== entry.artifactDigest) {
    throw new Error(
      `Add-on ${addonId} artifact does not match its recorded digest; run "phis addon check".`,
    );
  }

  const imported = (await import(
    `${pathToFileURL(artifactPath).href}?v=${artifactDigest}`
  )) as AddonArtifactModule;
  if (!imported.phiServerAddon) {
    throw new Error(`${artifactPath} does not export phiServerAddon.`);
  }
  return { entry, runtime: imported.phiServerAddon };
}

function loadDesiredAddons(root: string) {
  const state = readAddonDesiredState(root);
  const { installRoot } = getAddonPaths(root);
  const loaded: LoadedAddon[] = [];

  for (const desired of state.addons) {
    const manifest = desired.manifest;
    const digest = digestPhisAddonManifest(manifest);
    const mismatches: string[] = [];
    if (digest !== desired.manifestDigest) {
      mismatches.push(`manifestDigest ${digest} != ${desired.manifestDigest}`);
    }

    const artifactPath = resolvePhisAddonArtifactPath(
      installRoot,
      desired.addonId,
      desired.packageVersion,
    );
    if (!existsSync(artifactPath)) {
      mismatches.push(`artifact missing at ${artifactPath}`);
    } else {
      const artifactDigest = digestArtifact(readFileSync(artifactPath));
      if (artifactDigest !== desired.artifactDigest) {
        mismatches.push(
          `artifactDigest ${artifactDigest} != ${desired.artifactDigest}`,
        );
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Installed Add-on ${desired.addonId} does not match desired state:\n- ${mismatches.join(
          "\n- ",
        )}`,
      );
    }
    loaded.push({ desired, manifest, digest });
  }

  // Section 10 makes (service kind, provider key) unique across the installation, not just within one
  // Add-on: a Storage Profile row names exactly that pair, and two implementations answering to it
  // would make the row ambiguous. The manifest validator cannot see this, because it only ever sees one
  // Add-on at a time.
  const claimedServices = new Map<string, string>();
  for (const { desired, manifest } of loaded) {
    for (const provider of manifest.serviceProviders) {
      const key = `${provider.serviceKind}:${provider.providerKey}`;
      const owner = claimedServices.get(key);
      if (owner) {
        throw new Error(
          `Service provider ${key} is declared by both ${owner} and ${desired.addonId}.`,
        );
      }
      claimedServices.set(key, desired.addonId);
    }
  }

  return loaded;
}

export async function checkAddons(root: string) {
  // Diagnose before loading. An entry a Core release invalidated cannot be loaded at all, and saying so
  // by name -- with the way out -- beats failing on the first artifact import with a wall of issues.
  const { invalid } = readAddonDesiredStateForChange(root);
  if (invalid.length > 0) {
    return {
      ok: false,
      action: "addon.check",
      addons: [],
      invalid,
      hint: "Rebuild the Add-on against this release and run phis addon upgrade, or phis addon remove.",
    };
  }
  const loaded = loadDesiredAddons(root);
  const unindexedSearches = loaded.flatMap(({ desired, manifest }) =>
    manifest.schema && manifest.queries
      ? phiServerAddonUnindexedSearches(manifest.schema, manifest.queries)
        .map((search) => ({ addonId: desired.addonId, ...search }))
      : []
  );
  return {
    ok: true,
    action: "addon.check",
    unindexedSearches,
    addons: loaded.map(({ desired, manifest }) => ({
      ...desired,
      serverAbi: manifest.serverAbi,
      migrationVersion: manifest.migrationVersion,
      capabilities: manifest.capabilities.map((capability) => capability.id),
      serviceProviders: manifest.serviceProviders.map(
        (provider) => `${provider.serviceKind}:${provider.providerKey}`,
      ),
    })),
  };
}

export function listAddons(root: string) {
  // Tolerant on purpose: an operator whose state has one broken entry still needs to see what is there,
  // and the broken one most of all.
  const { state, invalid } = readAddonDesiredStateForChange(root);
  return {
    ok: invalid.length === 0,
    action: "addon.list",
    addons: state.addons,
    invalid,
  };
}

/** Reads an artifact from the path an operator named, and validates what it declares. */
async function readArtifact(flags: FlagMap) {
  const source = path.resolve(getRequiredFlag(flags, "artifact"));
  if (!existsSync(source)) {
    throw new Error(`No Add-on artifact at ${source}.`);
  }

  const bytes = readFileSync(source);
  const artifactDigest = digestArtifact(bytes);
  const manifest = await loadArtifactManifest(source, artifactDigest);
  return {
    bytes,
    artifactDigest,
    manifest,
    manifestDigest: digestPhisAddonManifest(manifest),
  };
}

export async function installAddon(root: string, flags: FlagMap) {
  const { bytes, artifactDigest, manifest, manifestDigest } = await readArtifact(flags);

  const state = readAddonDesiredState(root);
  if (state.addons.some((addon) => addon.addonId === manifest.addonId)) {
    throw new Error(`Add-on ${manifest.addonId} is already installed.`);
  }
  if (state.addons.some((addon) => addon.packageName === manifest.packageName)) {
    throw new Error(`Add-on package ${manifest.packageName} is already installed.`);
  }

  const { installRoot } = getAddonPaths(root);
  const versionDirectory = resolvePhisAddonVersionDirectory(
    installRoot,
    manifest.addonId,
    manifest.packageVersion,
  );
  const target = resolvePhisAddonArtifactPath(
    installRoot,
    manifest.addonId,
    manifest.packageVersion,
  );

  // A half-installed Add-on is worse than an uninstalled one, so anything written here is taken back
  // if the entry cannot be recorded.
  mkdirSync(versionDirectory, { recursive: true });
  writeArtifactAtomic(target, bytes);
  try {
    writeAddonDesiredState(root, {
      formatVersion: 1,
      addons: [
        ...state.addons,
        {
          addonId: manifest.addonId,
          packageName: manifest.packageName,
          packageVersion: manifest.packageVersion,
          manifestDigest,
          artifactDigest,
          manifest,
          enabled: false,
        },
      ],
    });
  } catch (error) {
    rmSync(versionDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    ok: true,
    action: "addon.install",
    addon: {
      addonId: manifest.addonId,
      packageName: manifest.packageName,
      packageVersion: manifest.packageVersion,
      manifestDigest,
      artifactDigest,
      enabled: false,
    },
    artifact: target,
  };
}

/**
 * Replaces an installed Add-on with a newer artifact.
 *
 * Versions sit side by side, so the previous one stays on disk and a rollback is this same command with
 * the older artifact. Replacing an artifact without moving the version is allowed on purpose -- that is
 * what a security patch looks like -- and works because the digest, not the path, is what the load
 * address carries.
 *
 * A changed package name is refused unless `--repackage` says so. The physical name may legitimately
 * change -- section 1 of `SERVER_ADDONS.md` allows a replacement package, which is why `addonId` and
 * `packageName` are separate fields at all -- but it is not what an upgrade normally is. Far more often
 * it means the wrong artifact was pointed at, and that is worth one flag to say out loud, because the
 * logical id an operator types is the same either way.
 *
 * Nothing here touches the registry. Between this command and the next `reconcile`, the desired state
 * names a version the registry does not, and the dispatcher refuses rather than guesses; a schema bump
 * keeps it refusing until `migrate` has run. Both are the intended failure, and both are why the
 * command says what has to follow it.
 */
export async function upgradeAddon(root: string, flags: FlagMap) {
  const addonId = getRequiredFlag(flags, "addon");
  const { state, invalid } = readAddonDesiredStateForChange(root);
  const existing = state.addons.find((addon) => addon.addonId === addonId);
  if (!existing) {
    throw new Error(`Add-on ${addonId} is not installed; use \`addon install\` for a new one.`);
  }

  const { bytes, artifactDigest, manifest, manifestDigest } = await readArtifact(flags);
  if (manifest.addonId !== addonId) {
    throw new Error(
      `The artifact declares ${manifest.addonId}, not ${addonId}. An upgrade does not change identity.`,
    );
  }
  if (manifest.packageName !== existing.packageName && flags.get("repackage") !== true) {
    throw new Error(
      `The artifact names package ${manifest.packageName}, not ${existing.packageName}. ` +
      "If the Add-on was genuinely republished under a new name, pass --repackage.",
    );
  }
  if (manifest.migrationVersion < existing.manifest.migrationVersion) {
    throw new Error(
      `The artifact declares schema version ${manifest.migrationVersion}, below the installed ` +
      `${existing.manifest.migrationVersion}. A schema cannot be walked back by an upgrade.`,
    );
  }
  const entryIsBroken = invalid.some((entry) => entry.addonId === addonId);
  if (
    manifest.packageVersion === existing.packageVersion &&
    artifactDigest === existing.artifactDigest &&
    !entryIsBroken
  ) {
    throw new Error(`${addonId} ${existing.packageVersion} is already installed from this artifact.`);
  }

  const { installRoot } = getAddonPaths(root);
  const versionDirectory = resolvePhisAddonVersionDirectory(
    installRoot,
    addonId,
    manifest.packageVersion,
  );
  const target = resolvePhisAddonArtifactPath(installRoot, addonId, manifest.packageVersion);
  const previous = {
    packageVersion: existing.packageVersion,
    artifactDigest: existing.artifactDigest,
    directory: resolvePhisAddonVersionDirectory(installRoot, addonId, existing.packageVersion),
  };

  mkdirSync(versionDirectory, { recursive: true });
  writeArtifactAtomic(target, bytes);
  writeAddonDesiredState(root, {
    formatVersion: 1,
    addons: state.addons.map((addon) =>
      addon.addonId === addonId
        ? {
            ...addon,
            packageName: manifest.packageName,
            packageVersion: manifest.packageVersion,
            manifestDigest,
            artifactDigest,
            manifest,
          }
        : addon,
    ),
  });

  return {
    ok: true,
    action: "addon.upgrade",
    addonId,
    from: previous.packageVersion,
    to: manifest.packageVersion,
    artifact: target,
    previousArtifactKept:
      previous.packageVersion === manifest.packageVersion ? null : previous.directory,
    schemaChanged: manifest.migrationVersion > existing.manifest.migrationVersion,
    enabled: existing.enabled,
    pendingRegistryReconciliation: true,
  };
}

/** Removes every installed version of an Add-on, then any directory that leaves empty behind it. */
function pruneEmptyInstallDirectories(installRoot: string, versionDirectory: string) {
  let current = path.dirname(versionDirectory);
  while (current.startsWith(installRoot) && current !== installRoot) {
    if (readdirSync(current).length > 0) {
      return;
    }
    rmSync(current, { recursive: true, force: true });
    current = path.dirname(current);
  }
}

export async function removeAddon(root: string, flags: FlagMap) {
  const addonId = getRequiredFlag(flags, "addon");
  const { state } = readAddonDesiredStateForChange(root);
  const existing = state.addons.find((addon) => addon.addonId === addonId);
  if (!existing) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }
  if (existing.enabled) {
    throw new Error(`Disable Add-on ${addonId} before removing it.`);
  }

  const { installRoot } = getAddonPaths(root);
  const versionDirectory = resolvePhisAddonVersionDirectory(
    installRoot,
    existing.addonId,
    existing.packageVersion,
  );
  // Every version, not only the installed one: an upgrade leaves its predecessor behind for rollback,
  // and removing the Add-on has to take those with it rather than orphan them.
  const nameDirectory = path.dirname(versionDirectory);
  rmSync(nameDirectory, { recursive: true, force: true });
  pruneEmptyInstallDirectories(installRoot, nameDirectory);

  writeAddonDesiredState(root, {
    formatVersion: 1,
    addons: state.addons.filter((addon) => addon.addonId !== addonId),
  });

  return {
    ok: true,
    action: "addon.remove",
    addonId,
    packageName: existing.packageName,
    artifact: versionDirectory,
  };
}


/**
 * Takes an Add-on out of the desired state without reading what is stored about it.
 *
 * The escape hatch for a manifest that has become unreadable -- a field whose meaning changed, a state
 * written by a release nobody has any more. `remove` validates before it deletes, which is right when
 * the state is sound and useless when it is not: an operator would otherwise be left with a file only a
 * text editor can repair, and the digest deliberately makes editing it pointless.
 *
 * It leaves the artifact where it is. Nothing here has read the manifest, so nothing here knows which
 * version directory belonged to this Add-on, and guessing at a path to delete recursively is not a
 * thing a recovery command should do. `phis addon check` reports what is left over.
 */
export function forgetAddon(root: string, flags: FlagMap) {
  const addonId = getRequiredFlag(flags, "addon");
  const { desiredState } = getAddonPaths(root);
  if (!existsSync(desiredState)) {
    throw new Error(`Missing Add-on desired state: ${desiredState}`);
  }
  const parsed = JSON.parse(readFileSync(desiredState, "utf8")) as {
    formatVersion?: unknown;
    addons?: unknown;
  };
  const addons = Array.isArray(parsed.addons) ? parsed.addons : [];
  const remaining = addons.filter(
    (addon) => !(addon && typeof addon === "object" && (addon as { addonId?: unknown }).addonId === addonId),
  );
  if (remaining.length === addons.length) {
    throw new Error(`Add-on ${addonId} is not in the desired state.`);
  }
  writeAtomic(desiredState, `${JSON.stringify({ formatVersion: 1, addons: remaining }, null, 2)}\n`);
  return {
    ok: true,
    action: "addon.forget",
    addonId,
    remaining: remaining.length,
    artifactsLeftInPlace: true,
  };
}

export async function setAddonEnabled(
  root: string,
  flags: FlagMap,
  enabled: boolean,
) {
  const addonId = getRequiredFlag(flags, "addon");
  const { state } = readAddonDesiredStateForChange(root);
  const index = state.addons.findIndex((addon) => addon.addonId === addonId);
  if (index < 0) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }

  const addons = [...state.addons];
  addons[index] = { ...addons[index], enabled };
  writeAddonDesiredState(root, { formatVersion: 1, addons });

  return {
    ok: true,
    action: enabled ? "addon.enable" : "addon.disable",
    addon: addons[index],
    pendingRegistryReconciliation: true,
  };
}

export async function reconcileAddons(
  root: string,
  flags: FlagMap,
  pool: Pool,
) {
  const releaseBuildId = readReleaseBuildId();
  const loaded = loadDesiredAddons(root);
  await reconcilePhisAddons(pool, releaseBuildId, loaded);

  /*
   * Groups are caught up here as well as at the Site that asks for the Add-on, because a release can
   * bring a group its predecessor did not declare -- and the Sites that already run it would otherwise
   * never get one. Nothing is retired here: a group the manifest stopped declaring may still hold the
   * memberships an operator entered, and taking those away belongs to removing the Add-on, not to
   * upgrading it.
   */
  /*
   * After reconcile the registry matches the desired state by construction, so every Site that asked
   * for the Add-on is now getting it. Recorded rather than derived on read: this is what an operator
   * sees when they ask why something is or is not running, and it must not require re-running the
   * capability snapshot to answer.
   */
  for (const { desired } of loaded) {
    await recordPhisAddonSiteEffectiveStatus(pool, {
      addonId: desired.addonId,
      status: desired.enabled ? "available" : "disabled",
      diagnosticCode: desired.enabled ? null : "globally_disabled",
    });
  }

  const groups: Array<{ addonId: string; siteId: number; key: string; action: string }> = [];
  for (const { desired, manifest } of loaded) {
    const declared = manifest.groups ?? [];
    if (declared.length === 0) {
      continue;
    }
    for (const siteId of await readPhisAddonEnabledSiteIds(pool, desired.addonId)) {
      const applied = await ensurePhisAddonSiteGroups(pool, {
        addonId: desired.addonId,
        siteId,
        declared,
      });
      groups.push(
        ...applied.map((entry) => ({
          addonId: desired.addonId,
          siteId,
          key: entry.key,
          action: entry.action,
        })),
      );
    }
  }

  return {
    ok: true,
    action: "addon.reconcile",
    releaseBuildId,
    addons: loaded.map(({ desired }) => desired),
    groups,
    coreCapabilities: PHIS_CORE_CAPABILITIES,
  };
}

/**
 * The release this CLI writes against, which is the package it was built from.
 *
 * It is not an operator's to choose. What the registry records has to be the code that wrote it, and
 * the CLI ships inside the same package as the runtime it reconciles -- so the version is already the
 * answer, and asking for one could only introduce a wrong one. `next build` bakes the same value into
 * the runtime for its capability responses, so the two cannot disagree.
 */
function readReleaseBuildId() {
  return packageJson.version;
}

/**
 * Brings one Add-on's schema, or every installed Add-on's, to the shape its descriptor declares.
 *
 * Without `--addon` this covers the whole installation, which is safe to repeat: an Add-on already at
 * its declared shape reports unchanged and nothing runs.
 */
export async function migrateAddons(
  root: string,
  flags: FlagMap,
  pool: Pool,
  servingRole: string,
) {
  const releaseBuildId = readReleaseBuildId();
  const addonId = getOptionalFlag(flags, "addon");
  const loaded = loadDesiredAddons(root);
  const selected = addonId
    ? loaded.filter((entry) => entry.desired.addonId === addonId)
    : loaded;
  if (addonId && selected.length === 0) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }

  const outcomes = [];
  for (const { manifest, digest } of selected) {
    outcomes.push(
      await migratePhisAddon(pool, { manifest, releaseBuildId, servingRole }, digest),
    );
  }

  return { ok: true, action: "addon.migrate", releaseBuildId, outcomes };
}

/**
 * Removes an Add-on's data.
 *
 * This is the destructive step section 15 keeps separate from disabling and uninstalling, so it refuses
 * to run behind an Add-on that is still installed: an operator who has not yet removed the package is
 * more likely repairing than discarding.
 */
export async function purgeAddon(root: string, flags: FlagMap, pool: Pool) {
  const addonId = getRequiredFlag(flags, "addon");
  const state = readAddonDesiredState(root);
  if (state.addons.some((addon) => addon.addonId === addonId)) {
    throw new Error(
      `Add-on ${addonId} is still installed. Run \`phis addon remove --addon ${addonId}\` first; ` +
      "purge discards its tables and rows and is not part of uninstalling.",
    );
  }

  const result = await purgePhisAddon(pool, addonId);
  return { ok: true, action: "addon.purge", ...result };
}

/**
 * What an installed Add-on says is configurable.
 *
 * Read from the desired state rather than from the running server: `phis addon config` has to work
 * before an instance is up, and the descriptors travel with the installation anyway.
 */
export function readInstalledAddonModules(root: string, addonId: string) {
  const entry = readAddonDesiredState(root).addons.find((addon) => addon.addonId === addonId);
  if (!entry) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }
  return entry.manifest.modules ?? [];
}

/** One package carries one product, so the Module half is this same name. */
export function readInstalledAddonPackageName(root: string, addonId: string) {
  const entry = readAddonDesiredState(root).addons.find((addon) => addon.addonId === addonId);
  if (!entry) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }
  return entry.manifest.packageName;
}

export function readInstalledAddonGroups(root: string, addonId: string) {
  const entry = readAddonDesiredState(root).addons.find((addon) => addon.addonId === addonId);
  if (!entry) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }
  return entry.manifest.groups ?? [];
}

export function readInstalledAddonSettings(root: string, addonId: string) {
  const entry = readAddonDesiredState(root).addons.find((addon) => addon.addonId === addonId);
  if (!entry) {
    throw new Error(`Add-on ${addonId} is not installed.`);
  }
  return entry.manifest.settings ?? [];
}
