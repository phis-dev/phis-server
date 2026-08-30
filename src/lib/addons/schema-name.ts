/**
 * Where an Add-on's tables live.
 *
 * The name is derived from the logical Add-on id and never from the physical package name: deriving
 * from the package would write `-server` into every schema and would demand a rename, with rows already
 * in it, on the replacement package section 1 allows.
 *
 * The derivation is lossy -- `@acme-a/b` and `@acme/a-b` reach the same name -- and that is answered by
 * writing the result into `phis.server_addons.schema_name` under a unique index, not by a digest an
 * operator cannot read. The database is then what refuses a second Add-on on one schema, which holds
 * even for someone working around the CLI. What this function returns is a suggestion computed once,
 * not a rule applied repeatedly: an installed Add-on keeps the name it already carries.
 */

/** An Add-on id is an npm package name without `-server`, in which neither `_` nor `.` occurs. */
export const PHI_SERVER_ADDON_ID_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
export const PHI_SERVER_ADDON_SCHEMA_PREFIX = "phis_addon_";
export const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

export function derivePhiServerAddonSchemaName(addonId: string) {
  const id = addonId.trim();
  if (!PHI_SERVER_ADDON_ID_PATTERN.test(id)) {
    throw new Error(
      `"${addonId}" is not a valid Add-on id: an npm package name without the -server postfix, ` +
      "containing neither _ nor .",
    );
  }
  const name = `${PHI_SERVER_ADDON_SCHEMA_PREFIX}${id.slice(1).replaceAll(/[/-]/g, "_")}`;
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
export function composePhiServerAddonObjectName(
  table: string,
  name: string,
  suffix: "idx" | "check" | "fk",
) {
  return `${table}_${name}_${suffix}`;
}
