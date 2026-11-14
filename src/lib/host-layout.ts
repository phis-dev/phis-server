/**
 * Where a host keeps what its stages share, beside `/srv/phis/stages`: Local media, the Sites' sources
 * and the links to their running releases. One host, one layout -- every stage names the same three unless
 * its configuration says otherwise, which is why `phis stage remove` lists them and never removes them.
 * `phis install` creates them (`src/lib/configured-directories.ts`). A module of their own, with no imports,
 * so code that reaches the browser -- the operator's deployment snippets -- names the same paths.
 */
export const PHIS_DEFAULT_MEDIA_ROOT = "/srv/phis/media";
export const PHIS_DEFAULT_SITE_SOURCE_ROOT = "/srv/phis/sites";
export const PHIS_DEFAULT_SITE_INSTANCE_ROOT = "/srv/phis/instances";
