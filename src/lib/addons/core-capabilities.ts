import { createHash } from "node:crypto";

import { PHIS_CORE_CAPABILITIES as CORE_CAPABILITY_IDS } from "./contract.ts";
import type { PhisAddonCapabilityDescriptor } from "./contract.ts";

/**
 * The Core capabilities this release offers, as descriptors.
 *
 * The ids come from `@phis/contracts`: an Add-on declares which of them it needs, so both sides
 * have to spell them identically and only one of the two may own the spelling. The digest is derived
 * from the id alone -- it identifies the capability in a snapshot, it does not describe an interface
 * shape -- so deriving it here costs nothing and keeps a node builtin out of the contract.
 */

function coreCapability(id: string): PhisAddonCapabilityDescriptor {
  return {
    id,
    interfaceDigest: createHash("sha256")
      .update(`phi-server-core-capability:${id}`)
      .digest("hex"),
  };
}

export const PHIS_CORE_CAPABILITIES = Object.freeze(
  Object.values(CORE_CAPABILITY_IDS).map(coreCapability),
);

const CORE_CAPABILITY_ID_SET = new Set<string>(Object.values(CORE_CAPABILITY_IDS));

export function hasPhisCoreCapability(capabilityId: string) {
  return CORE_CAPABILITY_ID_SET.has(capabilityId);
}

/**
 * The capabilities this release actually binds to a handler's context.
 *
 * The catalogue above is the vocabulary, and a name may be reserved in it long before anything builds
 * it -- `authentication:v1` is one today, and is a name a Site Module asks about rather than a thing an
 * Add-on receives. Membership in the catalogue therefore says what an Add-on may ask for, never what it
 * will receive, and the two gates below have to ask this set instead. Asking the catalogue let an Add-on declaring a reserved name pass the dispatcher, the job
 * runner and the service factory, and then find `undefined` where its capability should have been --
 * the opposite of what `PhisAddonCapabilities` states, that a capability this release does not offer
 * stops the Add-on rather than arriving as a broken object.
 *
 * Keep it in step with `buildPhisAddonCapabilities`: an entry here is a promise that the builder
 * assigns that field.
 */
const DELIVERABLE_CAPABILITY_ID_SET = new Set<string>([
  CORE_CAPABILITY_IDS.authorization,
  CORE_CAPABILITY_IDS.data,
  CORE_CAPABILITY_IDS.threads,
  CORE_CAPABILITY_IDS.resourceLinks,
  CORE_CAPABILITY_IDS.support,
  CORE_CAPABILITY_IDS.groups,
  CORE_CAPABILITY_IDS.storage,
  CORE_CAPABILITY_IDS.assets,
  CORE_CAPABILITY_IDS.secrets,
  CORE_CAPABILITY_IDS.settings,
  CORE_CAPABILITY_IDS.roles,
]);

/**
 * Whether an Add-on requiring this capability can be served at all.
 *
 * Not the same question as `hasPhisCoreCapability`, which answers whether the id is one Core knows.
 * A name Core knows but cannot yet hand over is refused here, and refused early, because the failure
 * belongs at the point where the Add-on is admitted and not somewhere inside its handler.
 */
export function isPhisAddonCapabilityDeliverable(capabilityId: string) {
  return DELIVERABLE_CAPABILITY_ID_SET.has(capabilityId);
}

/**
 * The capability ids an artifact declares that something else already supplies.
 *
 * A capability has one supplier (`server_capabilities.capability_id` is unique), and nothing enforced
 * that before reconcile wrote the rows: the second supplier's insert broke on the constraint and took the
 * reconcile of every Add-on down with it. The install or upgrade that would introduce the clash asks this
 * and is refused, naming the supplier; the capability snapshot asks it of what is already installed,
 * for a desired state that reached the server some other way.
 */
export function findPhisAddonCapabilityClashes(
  capabilities: readonly { id: string }[],
  others: readonly { addonId: string; manifest: { capabilities: readonly { id: string }[] } }[],
) {
  const suppliers = new Map<string, string>(
    PHIS_CORE_CAPABILITIES.map((capability) => [capability.id, "@phis/server/core"]),
  );
  for (const other of others) {
    for (const capability of other.manifest.capabilities) {
      suppliers.set(capability.id, other.addonId);
    }
  }
  return capabilities.flatMap((capability) => {
    const supplier = suppliers.get(capability.id);
    return supplier ? [{ capabilityId: capability.id, supplier }] : [];
  });
}
