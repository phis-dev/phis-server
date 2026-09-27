/**
 * The request header names, re-exported from the one place that defines them.
 *
 * The names themselves live in `@phis/contracts/http`, because the site UI writes the headers this
 * server reads and the two must agree. They are re-exported here so that call sites follow the ordinary
 * rule that runtime constants are reached through `src/lib/constants/*`, without the names existing
 * twice.
 */

export {
  PHIS_AREA_HEADER,
  PHIS_REQUEST_PATH_HEADER,
  PHIS_REQUEST_SEARCH_HEADER,
  PHIS_SITE_KEY_HEADER,
  PHIS_TOKEN_HEADER,
} from "@phis/contracts/http";

/**
 * The application a write to the global translation store belongs to.
 *
 * Defined here rather than in `@phis/contracts/http` because the party on the other side is not the site
 * UI. Nothing in this workspace sends it: it is written by an application outside the platform, and what
 * the two sides agree on is the route contract (TRANSLATIONS.md, "Somebody else's strings in the global
 * store") rather than a shared type.
 */
export const PHIS_APP_HEADER = "x-phis-app";
