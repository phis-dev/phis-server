import {
  PHI_SERVER_SERVICE_INTERFACE_DIGESTS,
  PHI_SERVER_SERVICE_KINDS,
  type PhiServerServiceKind,
} from "./contract.ts";

/**
 * The Core-owned service kinds, as this release checks them.
 *
 * The names and digests are not stated here. They belong to `@phis/contracts`, because an Add-on
 * has to spell them the same way and receives nothing else to read them out of. What stays here is the
 * checking: whether a name is one Core owns, and whether the interface an Add-on was built against is
 * the one this release offers.
 *
 * The digest is what makes an incompatible Add-on fail at install rather than at the first call. Change
 * the shape of an interface, raise its version in the contract, replace its digest there, and every
 * Add-on built against the old one is refused with its own value quoted back.
 */

export { PHI_SERVER_SERVICE_KINDS };
export type { PhiServerServiceKind };

export function phiServerServiceInterfaceDigest(kind: PhiServerServiceKind) {
  return PHI_SERVER_SERVICE_INTERFACE_DIGESTS[kind];
}

const SERVICE_KIND_SET = new Set<string>(Object.values(PHI_SERVER_SERVICE_KINDS));

export function isPhiServerServiceKind(value: unknown): value is PhiServerServiceKind {
  return typeof value === "string" && SERVICE_KIND_SET.has(value);
}

/** Whether an Add-on was built against the interface this release actually offers. */
export function isPhiServerServiceInterfaceCurrent(kind: string, interfaceDigest: string) {
  return isPhiServerServiceKind(kind) &&
    phiServerServiceInterfaceDigest(kind) === interfaceDigest;
}
