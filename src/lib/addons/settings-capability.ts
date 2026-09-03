import "server-only";

import type {
  PhisAddonSettingDescriptor,
  PhisSettingsCapabilityV1,
} from "./contract.ts";
import { readPhisAddonSettings } from "@/db/server-addon-settings.mts";
import { getPool } from "@/lib/db";

/**
 * Reading what an operator configured.
 *
 * The declared settings are the shape of the answer, not the stored row: a value nobody set falls back
 * to its declared default, and a stored key nobody declared is ignored rather than handed over. An
 * Add-on therefore reads exactly what it declared it would read, whatever else has accumulated in the
 * column across versions.
 *
 * There is no writer here, for the same reason `secrets:v1` has none. These are the operator's answers
 * to the Add-on's questions, and an Add-on able to answer for them could widen what it was granted.
 */

function coerce(
  descriptor: PhisAddonSettingDescriptor,
  stored: unknown,
): string | number | boolean | null {
  if (stored === undefined || stored === null) {
    return descriptor.default ?? null;
  }
  switch (descriptor.type) {
    case "text":
      return typeof stored === "string" ? stored : descriptor.default ?? null;
    case "integer":
      return typeof stored === "number" && Number.isInteger(stored)
        ? stored
        : descriptor.default ?? null;
    case "boolean":
      return typeof stored === "boolean" ? stored : descriptor.default ?? null;
  }
}

export function buildPhisAddonSettingsCapability(input: {
  addonId: string;
  siteId: number;
  declared: readonly PhisAddonSettingDescriptor[];
}): PhisSettingsCapabilityV1 {
  const { addonId, siteId, declared } = input;
  const byName = new Map(declared.map((descriptor) => [descriptor.name, descriptor]));

  return Object.freeze({
    async read(name) {
      const descriptor = byName.get(name);
      if (!descriptor) {
        // Undeclared is null rather than an error, and identical to unset with no default. An Add-on
        // asking for something it never declared has a bug in its manifest, not in this call.
        return null;
      }
      const stored = await readPhisAddonSettings(getPool(), addonId, siteId);
      return coerce(descriptor, stored[name]);
    },

    async all() {
      const stored = await readPhisAddonSettings(getPool(), addonId, siteId);
      return Object.freeze(Object.fromEntries(
        declared.map((descriptor) => [descriptor.name, coerce(descriptor, stored[descriptor.name])]),
      ));
    },
  } satisfies PhisSettingsCapabilityV1);
}
