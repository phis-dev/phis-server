import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHIS_APP_ROOT_ENV = "PHIS_APP_ROOT";

const CURRENT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_APP_ROOT = path.resolve(
  /* turbopackIgnore: true */ CURRENT_MODULE_DIR,
  "..",
  "..",
);

export function getPhiAppRoot() {
  const configuredRoot = process.env[PHIS_APP_ROOT_ENV]?.trim();
  return path.resolve(/* turbopackIgnore: true */ configuredRoot || BUNDLED_APP_ROOT);
}

export function resolvePhiAppPath(...segments: string[]) {
  return path.join(getPhiAppRoot(), ...segments);
}
