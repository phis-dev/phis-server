import { PHIS_CORE_CAPABILITIES, type PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisUserField } from "@phis/contracts/users";

import type { PhisAddonUsersGrant } from "../../db/users-grants.mts";
import { isPhisUserField, phisUserFieldBitsOf, phisUserFieldsOf } from "../constants/users.ts";

/**
 * What a Site has granted the Add-ons that read people (`users:v1` background access), one row per Add-on
 * requiring the capability: what it reads at all, what it asks to read with nobody acting, what is granted,
 * what of that counts -- the intersection with what the manifest still asks -- and what awaits a grant.
 * Pure, and free of `server-only`: `phis addon users` and `GET /api/site/admin/users-access` answer from it.
 */
export type PhisAddonUsersAccessRow = {
  addonId: string;
  fields: PhisUserField[];
  background: PhisUserField[];
  granted: PhisUserField[];
  effective: PhisUserField[];
  awaiting: PhisUserField[];
  grantedAt: string | null;
  grantedByUserId: number | null;
};

export function isPhisUsersReader(manifest: Pick<PhisAddonManifestV1, "requiredCoreCapabilities">) {
  return manifest.requiredCoreCapabilities.includes(PHIS_CORE_CAPABILITIES.users);
}

export function describePhisAddonUsersAccess(
  addons: readonly { addonId: string; manifest: Pick<PhisAddonManifestV1, "requiredCoreCapabilities" | "users"> }[],
  grants: readonly PhisAddonUsersGrant[],
): PhisAddonUsersAccessRow[] {
  const byAddon = new Map(grants.map((grant) => [grant.addonId, grant]));
  return addons
    .filter((entry) => isPhisUsersReader(entry.manifest))
    .map((entry) => {
      const background = (entry.manifest.users?.background ?? []).filter(isPhisUserField);
      const held = byAddon.get(entry.addonId);
      const grantedBits = held?.fields ?? 0;
      return {
        addonId: entry.addonId,
        fields: (entry.manifest.users?.fields ?? []).filter(isPhisUserField),
        background,
        granted: phisUserFieldsOf(grantedBits),
        effective: phisUserFieldsOf(grantedBits & phisUserFieldBitsOf(background)),
        awaiting: background.filter((field) => (grantedBits & phisUserFieldBitsOf([field])) === 0),
        grantedAt: held?.grantedAt ?? null,
        grantedByUserId: held?.grantedByUserId ?? null,
      };
    });
}

/**
 * The fields a grant may name for an Add-on: a non-empty part of what its manifest asks in the background,
 * without duplicates. Answers the fields, or the reason they cannot be granted.
 */
export function readPhisUsersGrantFields(
  asked: readonly PhisUserField[],
  named: unknown,
): { fields: PhisUserField[] } | { error: string } {
  if (asked.length === 0) {
    return { error: "The Add-on asks for no background access (manifest users.background); there is nothing to grant." };
  }
  if (
    !Array.isArray(named) || named.length === 0 || new Set(named).size !== named.length
    || named.some((field) => !isPhisUserField(field) || !asked.includes(field))
  ) {
    return { error: `The fields are a part of what the Add-on asks for in the background: ${asked.join(", ")}.` };
  }
  return { fields: named as PhisUserField[] };
}
