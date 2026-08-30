import {
  readMergedPhiConfigSync,
  type PhiServerConfig,
} from "./config-files";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4;

let cachedConfig: PhiServerConfig | null = null;
let cachedAt = 0;

export function resetPhiServerConfigCache() {
  cachedConfig = null;
  cachedAt = 0;
}

export function getPhiServerConfigSync() {
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedConfig;
  }

  cachedConfig = readMergedPhiConfigSync();
  cachedAt = Date.now();
  return cachedConfig;
}

export async function getPhiServerConfig() {
  return getPhiServerConfigSync();
}

export function isBootstrapEnabled() {
  return getPhiServerConfigSync().bootstrap?.enabled === true;
}
