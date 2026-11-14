import { randomBytes } from "node:crypto";

import type { PhisConfig } from "./config-core.ts";
import { createPhiSecretEncryptionKey, PHI_SECRET_INITIAL_KEY_VERSION } from "./secrets/crypto.ts";

/**
 * The keys an installation makes for itself, once.
 *
 * Each of them is random, local to this installation and never typed by anybody, so there is nothing to ask
 * an operator for -- only something to forget. `phis config init-keys`, `phis install` and the setup's finish
 * step all call this, and it only ever fills a gap: a key that is there is kept, because replacing one
 * orphans what it protects (stored secrets, signed sessions, the Sites' tokens).
 */
export type PhiRuntimeKeyName =
  | "api.internalToken"
  | "auth.transactionEncryptionKey"
  | "registration.intentEncryptionKey"
  | "operator.sessionSecret"
  | "secrets.encryptionKey";

export const PHI_RUNTIME_KEY_NAMES: readonly PhiRuntimeKeyName[] = [
  "api.internalToken",
  "auth.transactionEncryptionKey",
  "registration.intentEncryptionKey",
  "operator.sessionSecret",
  "secrets.encryptionKey",
];

/** 32 random bytes as 64 hex characters: the form every one of these keys is read in. */
function createHexKey() {
  return randomBytes(32).toString("hex");
}

export function listMissingPhiRuntimeKeys(config: PhisConfig): PhiRuntimeKeyName[] {
  const present: Record<PhiRuntimeKeyName, boolean> = {
    "api.internalToken": Boolean(config.api?.internalToken?.trim()),
    "auth.transactionEncryptionKey": Boolean(config.auth?.transactionEncryptionKey?.trim()),
    "registration.intentEncryptionKey": Boolean(config.registration?.intentEncryptionKey?.trim()),
    "operator.sessionSecret": Boolean(config.operator?.sessionSecret?.trim()),
    "secrets.encryptionKey": Boolean(config.secrets?.encryptionKey?.trim()),
  };
  return PHI_RUNTIME_KEY_NAMES.filter((name) => !present[name]);
}

/** The configuration with every missing key made, and which ones were. */
export function fillPhiRuntimeKeys(config: PhisConfig): { config: PhisConfig; created: PhiRuntimeKeyName[] } {
  const created = listMissingPhiRuntimeKeys(config);
  if (created.length === 0) {
    return { config, created };
  }
  const next: PhisConfig = { ...config };
  for (const name of created) {
    switch (name) {
      case "api.internalToken":
        next.api = { ...next.api, internalToken: createHexKey() };
        break;
      case "auth.transactionEncryptionKey":
        next.auth = { ...next.auth, transactionEncryptionKey: createHexKey() };
        break;
      case "registration.intentEncryptionKey":
        next.registration = { ...next.registration, intentEncryptionKey: createHexKey() };
        break;
      case "operator.sessionSecret":
        next.operator = { ...next.operator, sessionSecret: createHexKey() };
        break;
      case "secrets.encryptionKey":
        next.secrets = {
          ...next.secrets,
          encryptionKey: createPhiSecretEncryptionKey(),
          encryptionKeyVersion: PHI_SECRET_INITIAL_KEY_VERSION,
        };
        break;
    }
  }
  return { config: next, created };
}
