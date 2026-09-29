import path from "node:path";

import { getPhiAppRoot } from "./app-paths";
import {
  PHIS_ROOT_ENV,
  PHIS_DEFAULT_STAGE_ROOT,
  type PhiConfigPaths,
  type PhisConfig,
  readMergedPhiConfigSync as readMergedPhiConfigFromPathsSync,
  readPhiRuntimeConfigSync as readPhiRuntimeConfigFromPathsSync,
  writePhiRuntimeConfigSync as writePhiRuntimeConfigToPathsSync,
} from "./config-core";

export {
  type PhisConfig,
  resolvePhiSiteSourceLocale,
} from "./config-core";

export function getDefaultServerPhiRoot() {
  const configuredRoot = process.env[PHIS_ROOT_ENV]?.trim();
  if (configuredRoot) {
    return path.resolve(/* turbopackIgnore: true */ configuredRoot);
  }

  if (process.env.NODE_ENV?.trim() === "production") {
    return path.resolve(/* turbopackIgnore: true */ PHIS_DEFAULT_STAGE_ROOT);
  }

  return getPhiAppRoot();
}

export function resolvePhiConfigPaths(root = getDefaultServerPhiRoot()): PhiConfigPaths {
  const resolvedRoot = path.resolve(/* turbopackIgnore: true */ root);

  return {
    root: resolvedRoot,
    static: path.join(/* turbopackIgnore: true */ resolvedRoot, "config", "phis-config.json"),
    runtime: path.join(/* turbopackIgnore: true */ resolvedRoot, "config", "phis-runtime.json"),
  };
}

export function getPhiStaticConfigPath(root?: string) {
  return resolvePhiConfigPaths(root).static;
}

export function getPhiRuntimeConfigPath(root?: string) {
  return resolvePhiConfigPaths(root).runtime;
}

export function readPhiRuntimeConfigSync(root?: string) {
  return readPhiRuntimeConfigFromPathsSync(resolvePhiConfigPaths(root));
}

export function readMergedPhiConfigSync(root?: string) {
  return readMergedPhiConfigFromPathsSync(resolvePhiConfigPaths(root));
}

export function writePhiRuntimeConfigSync(config: PhisConfig, root?: string) {
  writePhiRuntimeConfigToPathsSync(resolvePhiConfigPaths(root), config);
}
