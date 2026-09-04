import { hostname } from "node:os";

export const PHIS_INSTANCE_ID_ENV = "PHIS_INSTANCE_ID";

/**
 * One serving process's identity in the fleet.
 *
 * Derived rather than configured, for the same reason `PHIS_RELEASE_ID` is baked in rather than set:
 * one more line an operator keeps true per host is one more line that will be wrong. Host name and
 * stage root are what actually distinguish two instances -- one host may serve several stages side by
 * side, and several hosts may serve the same one.
 *
 * The environment override exists for the case where the derivation is wrong rather than inconvenient:
 * a container's host name is regenerated on every start, so a restart would abandon the row it wrote
 * before. That is a fact about the host, and unlike the release id a host-describing value is exactly
 * what an environment variable is for.
 *
 * It lives in its own module because two processes have to agree on the answer: the runtime writes the
 * row, and `phis instance drain` withdraws it from outside on the way down.
 */
export function resolvePhisInstanceId(root: string) {
  const configured = process.env[PHIS_INSTANCE_ID_ENV]?.trim();
  if (configured) {
    return configured;
  }
  return `${hostname()}:${root}`;
}
