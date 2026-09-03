/**
 * Where an installed Add-on artifact lives, and how its address is derived.
 *
 * The path is computed from the logical Add-on id and its version, never read from a stored string:
 * a database row, a request, or a configuration value selects among the artifacts that are already
 * on this instance, and never becomes an import specifier of its own. That is the whole difference
 * between an install root and a plugin directory.
 *
 * Path math only. This file is shared by the server and the CLI, so it must not reach for a config
 * loader, a database handle, or anything that only exists on one of the two sides.
 */

import path from "node:path";

import { PHIS_ADDON_ID_PATTERN } from "./schema-name.ts";

/** The install root, relative to the stage root that `PHIS_ROOT` names. */
export const PHIS_ADDON_INSTALL_DIRECTORY = "addons";

/** The one file an Add-on installs. There is no second entrypoint and no package manifest beside it. */
export const PHIS_ADDON_ARTIFACT_FILENAME = "addon.mjs";

const PACKAGE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolvePhisAddonInstallRoot(stageRoot: string) {
  return path.join(stageRoot, PHIS_ADDON_INSTALL_DIRECTORY);
}

/**
 * `<install root>/<scope>/<name>/<version>` -- versions sit side by side so a rollback changes one
 * field rather than reinstalling, and so an upgrade never overwrites the artifact a running process
 * still has open.
 */
export function resolvePhisAddonVersionDirectory(
  installRoot: string,
  addonId: string,
  packageVersion: string,
) {
  if (!PHIS_ADDON_ID_PATTERN.test(addonId)) {
    throw new Error(
      `"${addonId}" is not a valid Add-on id, so no install path can be derived from it.`,
    );
  }
  if (!PACKAGE_VERSION_PATTERN.test(packageVersion)) {
    throw new Error(`"${packageVersion}" is not a valid package version for ${addonId}.`);
  }

  // The id pattern already excludes separators, traversal, and anything but one scope and one name.
  const [scope, name] = addonId.slice(1).split("/");
  return path.join(installRoot, scope ?? "", name ?? "", packageVersion);
}

export function resolvePhisAddonArtifactPath(
  installRoot: string,
  addonId: string,
  packageVersion: string,
) {
  return path.join(
    resolvePhisAddonVersionDirectory(installRoot, addonId, packageVersion),
    PHIS_ADDON_ARTIFACT_FILENAME,
  );
}
