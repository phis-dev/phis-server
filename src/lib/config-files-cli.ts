import path from "node:path";

import {
  PHIS_ROOT_ENV,
  type PhiConfigPaths,
  type PhisConfig,
  readMergedPhiConfigSync as readMergedPhiConfigFromPathsSync,
  readPhiRuntimeConfigSync as readPhiRuntimeConfigFromPathsSync,
  writePhiRuntimeConfigSync as writePhiRuntimeConfigToPathsSync,
} from "./config-core.ts";

export {
  loadConfigFileSync,
  type PlatformSuperUser,
  resolvePhiSiteSourceLocale,
  validatePhiConfig,
} from "./config-core.ts";

export function getDefaultPhiRoot() {
  const configuredRoot = process.env[PHIS_ROOT_ENV]?.trim();
  return path.resolve(configuredRoot || process.cwd());
}

export function resolvePhiConfigPaths(root = getDefaultPhiRoot()): PhiConfigPaths {
  const resolvedRoot = path.resolve(root);

  return {
    root: resolvedRoot,
    static: path.join(resolvedRoot, "config", "phis-config.json"),
    runtime: path.join(resolvedRoot, "config", "phis-runtime.json"),
  };
}

export function readMergedPhiConfigSync(root?: string) {
  return readMergedPhiConfigFromPathsSync(resolvePhiConfigPaths(root ?? getDefaultPhiRoot()));
}

export function readPhiRuntimeConfigSync(root?: string) {
  return readPhiRuntimeConfigFromPathsSync(resolvePhiConfigPaths(root ?? getDefaultPhiRoot()));
}

export function writePhiRuntimeConfigSync(config: PhisConfig, root?: string) {
  writePhiRuntimeConfigToPathsSync(resolvePhiConfigPaths(root ?? getDefaultPhiRoot()), config);
}
