/**
 * Where an Add-on's tables live.
 *
 * The name is derived from the logical Add-on id and never from the physical package name. The two
 * normally hold the same string, which makes this look like a distinction without a difference until
 * the day it is not: a replacement package under section 1 may be named differently, and deriving from
 * the physical name would demand a rename with rows already in the schema.
 *
 * The derivation is lossy -- `@acme-a/b` and `@acme/a-b` reach the same name -- and that is answered by
 * writing the result into `phis.server_addons.schema_name` under a unique index, not by a digest an
 * operator cannot read. The database is then what refuses a second Add-on on one schema, which holds
 * even for someone working around the CLI. What this function returns is a suggestion computed once,
 * not a rule applied repeatedly: an installed Add-on keeps the name it already carries.
 */

/** An Add-on id is an npm package name in which neither `_` nor `.` occurs. */
export const PHIS_ADDON_ID_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
export const PHIS_ADDON_SCHEMA_PREFIX = "phis_addon_";
export const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

export function derivePhisAddonSchemaName(addonId: string) {
  const id = addonId.trim();
  if (!PHIS_ADDON_ID_PATTERN.test(id)) {
    throw new Error(
      `"${addonId}" is not a valid Add-on id: an npm package name containing neither _ nor .`,
    );
  }
  const name = `${PHIS_ADDON_SCHEMA_PREFIX}${id.slice(1).replaceAll(/[/-]/g, "_")}`;
  if (name.length > POSTGRES_IDENTIFIER_MAX_LENGTH) {
    throw new Error(
      `Schema name "${name}" for ${addonId} exceeds ${POSTGRES_IDENTIFIER_MAX_LENGTH} characters. ` +
      "A truncated name would put two Add-ons on one schema, so this is refused rather than shortened.",
    );
  }
  return name;
}

/**
 * Composes a physical constraint or index name.
 *
 * An Add-on names these per table, so two tables may both call an index `by_state`; PostgreSQL scopes
 * them per schema, so Core is what makes them distinct.
 */
export function composePhisAddonObjectName(
  table: string,
  name: string,
  suffix: "idx" | "check" | "fk" | "uq",
) {
  return `${table}_${name}_${suffix}`;
}

/** The suffix Core appends for the table holding a table's files. */
export const PHIS_ADDON_ASSET_TABLE_SUFFIX = "assets";

/**
 * The table Core keeps beside a table that declares assets.
 *
 * Derived rather than declared, so an Add-on cannot name it, cannot query it directly, and cannot
 * collide with it -- validation refuses a declared table that would land on this name.
 */
export function composePhisAddonAssetTableName(table: string) {
  return `${table}_${PHIS_ADDON_ASSET_TABLE_SUFFIX}`;
}

/**
 * Where one Add-on's objects live on one Site: `addons/<derived name>/<site key>`.
 *
 * Derived, never given. An Add-on hands in a relative key and gets a relative key back, so there is no
 * address it could store, guess, or be tricked into passing -- which is what makes the isolation
 * structural rather than a check somebody has to keep writing. It is also the prefix a purge empties
 * and a sweep reads, so everything an Add-on owns has to be under it.
 */
export function phiServerAddonStoragePrefix(addonId: string, siteKey: string) {
  return `addons/${derivePhisAddonSchemaName(addonId)}/${siteKey}`;
}
