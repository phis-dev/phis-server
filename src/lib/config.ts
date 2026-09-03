import {
  readMergedPhiConfigSync,
  type PhisConfig,
} from "./config-files";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4;

let cachedConfig: PhisConfig | null = null;
let cachedAt = 0;

export function resetPhisConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export function getPhisConfigSync() {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  cachedConfig = readMergedPhiConfigSync();
  cachedAt = Date.now();
  return cachedConfig;
}

export async function getPhisConfig() {
  return getPhisConfigSync();
}

export function isBootstrapEnabled() {
  return getPhisConfigSync().bootstrap?.enabled === true;
}
