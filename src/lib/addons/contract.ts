/**
 * The Add-on ABI, re-exported from the contract package.
 *
 * The types live in `@phis/contracts` so an Add-on has something to build against that is not
 * this application: phi-server is private and has no export surface, and an Add-on typed against a
 * path inside it would break on a rename nobody would notice until the next Add-on build.
 *
 * Nothing here is a second definition. This file exists so no import inside phi-server had to move.
 */

export * from "@phis/contracts/addon";
