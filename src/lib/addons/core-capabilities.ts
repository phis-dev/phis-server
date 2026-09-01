import { createHash } from "node:crypto";

import { PHI_SERVER_CORE_CAPABILITIES as CORE_CAPABILITY_IDS } from "./contract.ts";
import type { PhiServerAddonCapabilityDescriptor } from "./contract.ts";

/**
 * The Core capabilities this release offers, as descriptors.
 *
 * The ids come from `@phis/contracts`: an Add-on declares which of them it needs, so both sides
 * have to spell them identically and only one of the two may own the spelling. The digest is derived
 * from the id alone -- it identifies the capability in a snapshot, it does not describe an interface
 * shape -- so deriving it here costs nothing and keeps a node builtin out of the contract.
 */

function coreCapability(id: string): PhiServerAddonCapabilityDescriptor {
  return {
    id,
    interfaceDigest: createHash("sha256")
      .update(`phi-server-core-capability:${id}`)
      .digest("hex"),
  };
}

export const PHI_SERVER_CORE_CAPABILITIES = Object.freeze(
  Object.values(CORE_CAPABILITY_IDS).map(coreCapability),
);

const CORE_CAPABILITY_ID_SET = new Set<string>(Object.values(CORE_CAPABILITY_IDS));

export function hasPhiServerCoreCapability(capabilityId: string) {
  return CORE_CAPABILITY_ID_SET.has(capabilityId);
}
