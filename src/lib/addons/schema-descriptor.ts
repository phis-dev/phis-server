/**
 * What Core checks before it will generate anything from a descriptor.
 *
 * The Add-on states a shape; this is where the shape is held to the rules of section 15 before a single
 * statement exists. Most of those rules are not checked here at all -- an Add-on cannot name a schema,
 * cannot choose a third delete rule, and cannot write the Site column, because the descriptor has
 * nowhere to say any of it. What remains are the things a well-meaning Add-on can still get wrong:
 * a column that is referenced but not declared, a `setNull` on a column that cannot be null, a name that
 * would collide once Core composes the physical one.
 */

import {
  PHIS_ADDON_CORE_REFERENCES,
  PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION,
  type PhisAddonAssetSlotDescriptor,
  type PhisAddonColumnDescriptor,
  type PhisAddonReferenceColumnDescriptor,
  type PhisAddonSchemaDescriptor,
  type PhisAddonTableDescriptor,
  type PhisAddonValueColumnDescriptor,
} from "./contract.ts";
import {
  POSTGRES_IDENTIFIER_MAX_LENGTH,
  composePhisAddonAssetTableName,
  composePhisAddonObjectName,
} from "./schema-name.ts";

const OBJECT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const COLUMN_TYPES = new Set([
  "identity",
  "smallInteger",
  "integer",
  "bigInteger",
  "text",
  "string",
  "boolean",
  "instant",
  "json",
  "uuid",
  "binary",
]);
const DELETE_RULES = new Set(["cascade", "setNull"]);
const COMPARISON_OPERATORS = new Set(["<", "<=", ">", ">="]);
const CORE_REFERENCES = new Set<string>(Object.values(PHIS_ADDON_CORE_REFERENCES));
const MAX_STRING_LENGTH = 10_485_760;
const POSTGRES_SMALLINT_MAX = 32_767;

/** Core writes this column for a Site-scoped table, so an Add-on must not declare it. */
export const PHIS_ADDON_SITE_COLUMN = "site_id";

/** The same, for the two scopes that carry authority rather than a boundary. */
export const PHIS_ADDON_OWNER_COLUMN = "owner_user_id";
export const PHIS_ADDON_GROUP_COLUMN = "group_id";

/**
 * Who wrote the row, beside who owns it now.
 *
 * Written once and never again, which is what makes a handover possible without losing the trail: the
 * owner is authority and moves, the author is history and stays. Media keeps the same pair for the same
 * reason -- an Asset handed to somebody else stays attributable to whoever brought it in.
 *
 * Present wherever the owner is, because it exists to survive the owner changing.
 */
export const PHIS_ADDON_CREATED_BY_COLUMN = "created_by_user_id";

const CORE_WRITTEN_COLUMNS: Readonly<Record<string, string>> = {
  [PHIS_ADDON_SITE_COLUMN]: "siteScoped",
  [PHIS_ADDON_OWNER_COLUMN]: "ownerScoped",
  [PHIS_ADDON_CREATED_BY_COLUMN]: "ownerScoped",
  [PHIS_ADDON_GROUP_COLUMN]: "groupScoped",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReferenceColumn(
  column: PhisAddonColumnDescriptor,
): column is PhisAddonReferenceColumnDescriptor {
  return "references" in column;
}

function readName(value: unknown, field: string, issues: string[]) {
  if (typeof value !== "string" || !OBJECT_NAME_PATTERN.test(value)) {
    issues.push(`${field} must be lowercase, start with a letter, and use only letters, digits, and _.`);
    return "";
  }
  return value;
}

function assertUnique(values: string[], field: string, issues: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (value && seen.has(value)) {
      issues.push(`${field} contains duplicate "${value}".`);
    }
    seen.add(value);
  }
}

function assertComposedNameFits(
  table: string,
  name: string,
  suffix: "idx" | "check" | "fk" | "uq",
  field: string,
  issues: string[],
) {
  if (!table || !name) {
    return "";
  }
  const composed = composePhisAddonObjectName(table, name, suffix);
  if (composed.length > POSTGRES_IDENTIFIER_MAX_LENGTH) {
    issues.push(
      `${field} becomes "${composed}", which exceeds ${POSTGRES_IDENTIFIER_MAX_LENGTH} characters.`,
    );
    return "";
  }
  return composed;
}

function validateColumn(
  value: unknown,
  field: string,
  issues: string[],
): PhisAddonColumnDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  const name = readName(value.name, `${field}.name`, issues);
  const reservedFor = CORE_WRITTEN_COLUMNS[name];
  if (reservedFor) {
    issues.push(
      `${field}.name is "${name}", which Core writes itself. Declare ${reservedFor} instead.`,
    );
  }
  if (value.nullable !== undefined && typeof value.nullable !== "boolean") {
    issues.push(`${field}.nullable must be a boolean.`);
  }
  if (value.unique !== undefined && typeof value.unique !== "boolean") {
    issues.push(`${field}.unique must be a boolean.`);
  }

  if ("references" in value) {
    const reference = value.references;
    const isCore = typeof reference === "string" && CORE_REFERENCES.has(reference);
    const isOwn = isRecord(reference) && typeof reference.table === "string";
    if (!isCore && !isOwn) {
      issues.push(
        `${field}.references must be a Core reference (${[...CORE_REFERENCES].join(", ")}) ` +
        "or { table } naming one of this Add-on's tables.",
      );
    }
    if (isOwn) {
      readName(reference.table, `${field}.references.table`, issues);
    }
    if (typeof value.onDelete !== "string" || !DELETE_RULES.has(value.onDelete)) {
      issues.push(`${field}.onDelete must be "cascade" or "setNull".`);
    }
    if (value.onDelete === "setNull" && value.nullable !== true) {
      issues.push(`${field} uses onDelete "setNull" but is not nullable.`);
    }
    if ("type" in value) {
      issues.push(`${field} is a reference column and must not state a type.`);
    }
    return issues.length === before ? (value as PhisAddonReferenceColumnDescriptor) : null;
  }

  const type = value.type;
  if (typeof type !== "string" || !COLUMN_TYPES.has(type)) {
    issues.push(`${field}.type must be one of ${[...COLUMN_TYPES].join(", ")}.`);
  }
  if (type === "string") {
    const maxLength = value.maxLength;
    if (!Number.isSafeInteger(maxLength) || Number(maxLength) < 1) {
      issues.push(`${field}.maxLength must be a positive integer for a string column.`);
    } else if (Number(maxLength) > MAX_STRING_LENGTH) {
      issues.push(`${field}.maxLength exceeds what a varchar can hold.`);
    }
  } else if (value.maxLength !== undefined) {
    issues.push(`${field}.maxLength applies only to a string column.`);
  }
  if (type === "identity" && (value.nullable === true || value.default !== undefined)) {
    issues.push(`${field} is an identity column and can be neither nullable nor defaulted.`);
  }
  if (value.default !== undefined) {
    const fallback = value.default;
    if (!isRecord(fallback)) {
      issues.push(`${field}.default must be an object.`);
    } else if (fallback.kind === "now") {
      if (type !== "instant") {
        issues.push(`${field}.default "now" applies only to an instant column.`);
      }
    } else if (fallback.kind === "literal") {
      const literal = fallback.value;
      if (typeof literal !== "string" && typeof literal !== "number" && typeof literal !== "boolean") {
        issues.push(`${field}.default.value must be a string, number, or boolean.`);
      }
    } else {
      issues.push(`${field}.default.kind must be "literal" or "now".`);
    }
  }
  return issues.length === before ? (value as PhisAddonValueColumnDescriptor) : null;
}

function validateConstraint(
  value: unknown,
  table: string,
  columnNames: Set<string>,
  field: string,
  issues: string[],
) {
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return "";
  }
  const name = readName(value.name, `${field}.name`, issues);
  assertComposedNameFits(table, name, "check", field, issues);

  const requireColumn = (column: unknown, columnField: string) => {
    if (typeof column !== "string" || !columnNames.has(column)) {
      issues.push(`${columnField} does not name a column of ${table}.`);
    }
  };

  switch (value.kind) {
    case "range": {
      requireColumn(value.column, `${field}.column`);
      const hasMin = value.min !== undefined;
      const hasMax = value.max !== undefined;
      if (!hasMin && !hasMax) {
        issues.push(`${field} states neither min nor max.`);
      }
      for (const [key, bound] of [["min", value.min], ["max", value.max]] as const) {
        if (bound !== undefined && typeof bound !== "number") {
          issues.push(`${field}.${key} must be a number.`);
        }
      }
      if (hasMin && hasMax && Number(value.min) > Number(value.max)) {
        issues.push(`${field} has a min above its max.`);
      }
      break;
    }
    case "enumeration": {
      requireColumn(value.column, `${field}.column`);
      const values = value.values;
      if (!Array.isArray(values) || values.length === 0) {
        issues.push(`${field}.values must be a non-empty array.`);
        break;
      }
      if (values.some((entry) => typeof entry !== "string")) {
        issues.push(`${field}.values must contain only strings.`);
        break;
      }
      assertUnique(values as string[], `${field}.values`, issues);
      break;
    }
    case "notEmpty": {
      requireColumn(value.column, `${field}.column`);
      break;
    }
    case "columnComparison": {
      requireColumn(value.left, `${field}.left`);
      requireColumn(value.right, `${field}.right`);
      if (value.left === value.right) {
        issues.push(`${field} compares a column with itself.`);
      }
      if (typeof value.operator !== "string" || !COMPARISON_OPERATORS.has(value.operator)) {
        issues.push(`${field}.operator must be one of ${[...COMPARISON_OPERATORS].join(", ")}.`);
      }
      break;
    }
    case "nullCardinality": {
      const columns = value.columns;
      if (!Array.isArray(columns) || columns.length < 2) {
        issues.push(`${field}.columns must name at least two columns.`);
        break;
      }
      for (const [index, column] of columns.entries()) {
        requireColumn(column, `${field}.columns[${index}]`);
      }
      assertUnique(columns as string[], `${field}.columns`, issues);
      const count = value.nonNullCount;
      if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > columns.length) {
        issues.push(`${field}.nonNullCount must be between 0 and the number of columns.`);
      }
      break;
    }
    default: {
      issues.push(`${field}.kind is not a known constraint kind.`);
    }
  }
  return name;
}

const ASSET_CARDINALITIES = new Set(["one", "many"]);
const MAX_ASSET_SLOT_NAME_LENGTH = 64;
/** Two gigabytes, which is what nginx is configured to pass through in front of Core. */
const MAX_ASSET_BYTES = 2_147_483_648;
/** `type/subtype`, with the parameters a header may carry left out: a stored type is not negotiated. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/**
 * A slot, which is a name plus the two limits Core enforces on the Add-on's behalf.
 *
 * The limits are validated here rather than at upload because a manifest that permits a four-gigabyte
 * logo is wrong when it is written, not when someone finally sends one.
 */
function validateAssetSlot(
  value: unknown,
  field: string,
  issues: string[],
): PhisAddonAssetSlotDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  const name = readName(value.name, `${field}.name`, issues);
  if (name.length > MAX_ASSET_SLOT_NAME_LENGTH) {
    issues.push(`${field}.name exceeds ${MAX_ASSET_SLOT_NAME_LENGTH} characters.`);
  }
  if (typeof value.cardinality !== "string" || !ASSET_CARDINALITIES.has(value.cardinality)) {
    issues.push(`${field}.cardinality must be "one" or "many".`);
  }
  if (
    typeof value.maxBytes !== "number"
    || !Number.isInteger(value.maxBytes)
    || value.maxBytes <= 0
    || value.maxBytes > MAX_ASSET_BYTES
  ) {
    issues.push(`${field}.maxBytes must be a whole number of bytes between 1 and ${MAX_ASSET_BYTES}.`);
  }
  if (!Array.isArray(value.contentTypes) || value.contentTypes.length === 0) {
    /*
     * Refused rather than read as "anything". A slot with no stated types is far more likely to be an
     * author who has not decided yet than one who means every type there is, and the permissive reading
     * is the one that cannot be taken back once packages depend on it.
     */
    issues.push(`${field}.contentTypes must name at least one media type.`);
  } else {
    for (const [index, type] of value.contentTypes.entries()) {
      if (typeof type !== "string" || !MEDIA_TYPE_PATTERN.test(type)) {
        issues.push(`${field}.contentTypes[${index}] must be a media type such as "image/png".`);
      }
    }
    assertUnique(value.contentTypes as string[], `${field}.contentTypes`, issues);
  }
  return issues.length === before ? (value as PhisAddonAssetSlotDescriptor) : null;
}

function validateTable(
  value: unknown,
  field: string,
  issues: string[],
): PhisAddonTableDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  const table = readName(value.name, `${field}.name`, issues);
  if (table.length > POSTGRES_IDENTIFIER_MAX_LENGTH) {
    issues.push(`${field}.name exceeds ${POSTGRES_IDENTIFIER_MAX_LENGTH} characters.`);
  }
  for (const scope of ["ownerScoped", "groupScoped"] as const) {
    if (value[scope] !== undefined && typeof value[scope] !== "boolean") {
      issues.push(`${field}.${scope} must be a boolean.`);
    }
  }
  // Stated, not defaulted. The two below read the answer, and an absent one would quietly mean "no
  // boundary" -- the only place in this descriptor where saying nothing is the permissive choice.
  if (typeof value.siteScoped !== "boolean") {
    issues.push(
      `${field}.siteScoped must be stated as a boolean. ` +
      "A table that belongs to the Add-on rather than to a Site says so with false.",
    );
  }
  if (value.groupScoped === true && value.siteScoped !== true) {
    issues.push(
      `${field}.groupScoped requires siteScoped: a group belongs to a Site and has no meaning without one.`,
    );
  }
  if (value.ownerScoped === true && value.siteScoped !== true) {
    issues.push(
      `${field}.ownerScoped requires siteScoped: Core weighs a person on a Site everywhere else, ` +
      "and ownership without one would let the same account reach a row from a Site it was never admitted to.",
    );
  }

  const rawColumns = Array.isArray(value.columns) ? value.columns : [];
  if (!Array.isArray(value.columns) || rawColumns.length === 0) {
    issues.push(`${field}.columns must be a non-empty array.`);
  }
  const columns = rawColumns
    .map((column, index) => validateColumn(column, `${field}.columns[${index}]`, issues))
    .filter((column): column is PhisAddonColumnDescriptor => column !== null);
  const columnNames = new Set(columns.map((column) => column.name));
  assertUnique(columns.map((column) => column.name), `${field}.columns.name`, issues);
  for (const column of columns) {
    if (!isReferenceColumn(column) || column.references !== PHIS_ADDON_CORE_REFERENCES.group) {
      continue;
    }
    if (value.siteScoped !== true) {
      issues.push(
        `${field}.columns "${column.name}" points at ${PHIS_ADDON_CORE_REFERENCES.group}, ` +
        "so the table must be siteScoped. Core binds a group together with its Site.",
      );
    }
    // The foreign key covers the Site column too, and `SET NULL` would clear that one as well.
    if (column.onDelete !== "cascade") {
      issues.push(
        `${field}.columns "${column.name}" points at ${PHIS_ADDON_CORE_REFERENCES.group} ` +
        "and must use onDelete \"cascade\": Core binds it together with the Site column, which cannot be nulled.",
      );
    }
  }

  // A unique column in a Site-scoped table becomes a named `(site_id, column)` constraint, so its name
  // has to fit the same identifier budget an index or a check does.
  if (value.siteScoped === true) {
    for (const column of columns.filter((entry) => entry.unique)) {
      assertComposedNameFits(table, column.name, "uq", `${field}.columns "${column.name}"`, issues);
    }
  }

  if (value.ownerScoped === true) {
    // The longest name Core composes on an owned table, checked here rather than met as a PostgreSQL
    // error partway through a migration that has already created the table.
    assertComposedNameFits(table, PHIS_ADDON_CREATED_BY_COLUMN, "fk", `${field}.ownerScoped`, issues);
  }

  const primaryKey = Array.isArray(value.primaryKey) ? value.primaryKey : [];
  if (!Array.isArray(value.primaryKey) || primaryKey.length === 0) {
    issues.push(`${field}.primaryKey must name at least one column.`);
  }
  for (const [index, column] of primaryKey.entries()) {
    if (typeof column !== "string" || !columnNames.has(column)) {
      issues.push(`${field}.primaryKey[${index}] does not name a column of ${table}.`);
    }
  }
  assertUnique(primaryKey.filter((column) => typeof column === "string"), `${field}.primaryKey`, issues);
  for (const column of columns) {
    if (!isReferenceColumn(column) && column.type === "identity") {
      if (primaryKey.length !== 1 || primaryKey[0] !== column.name) {
        issues.push(
          `${field}.columns "${column.name}" is an identity column, so it must be the whole primary key.`,
        );
      }
    }
    if (primaryKey.includes(column.name) && column.nullable === true) {
      issues.push(`${field}.columns "${column.name}" is in the primary key and cannot be nullable.`);
    }
  }

  const indexes = Array.isArray(value.indexes) ? value.indexes : [];
  if (value.indexes !== undefined && !Array.isArray(value.indexes)) {
    issues.push(`${field}.indexes must be an array.`);
  }
  const indexNames: string[] = [];
  for (const [index, descriptor] of indexes.entries()) {
    const indexField = `${field}.indexes[${index}]`;
    if (!isRecord(descriptor)) {
      issues.push(`${indexField} must be an object.`);
      continue;
    }
    const name = readName(descriptor.name, `${indexField}.name`, issues);
    assertComposedNameFits(table, name, "idx", indexField, issues);
    indexNames.push(name);
    if (descriptor.unique !== undefined && typeof descriptor.unique !== "boolean") {
      issues.push(`${indexField}.unique must be a boolean.`);
    }
    if (descriptor.kind !== undefined && descriptor.kind !== "ordered" && descriptor.kind !== "text") {
      issues.push(`${indexField}.kind must be "ordered" or "text".`);
    }
    const indexColumns = Array.isArray(descriptor.columns) ? descriptor.columns : [];
    if (indexColumns.length === 0) {
      issues.push(`${indexField}.columns must name at least one column.`);
    }
    for (const [columnIndex, column] of indexColumns.entries()) {
      if (typeof column !== "string" || !columnNames.has(column)) {
        issues.push(`${indexField}.columns[${columnIndex}] does not name a column of ${table}.`);
      }
    }
    if (descriptor.kind === "text") {
      // A text index holds fragments of one column's value, so it can neither span columns nor stand
      // for uniqueness -- and there is nothing to search in a column that does not hold text.
      if (indexColumns.length !== 1) {
        issues.push(`${indexField} is a text index and must name exactly one column.`);
      }
      if (descriptor.unique === true) {
        issues.push(`${indexField} is a text index and cannot be unique: it indexes fragments.`);
      }
      const declared = columns.find((column) => column.name === indexColumns[0]);
      const type = declared && !isReferenceColumn(declared) ? declared.type : undefined;
      if (type !== "text" && type !== "string") {
        issues.push(`${indexField} is a text index, but "${indexColumns[0]}" does not hold text.`);
      }
    }
  }
  assertUnique(indexNames, `${field}.indexes.name`, issues);

  const constraints = Array.isArray(value.constraints) ? value.constraints : [];
  if (value.constraints !== undefined && !Array.isArray(value.constraints)) {
    issues.push(`${field}.constraints must be an array.`);
  }
  const constraintNames = constraints.map((constraint, index) =>
    validateConstraint(constraint, table, columnNames, `${field}.constraints[${index}]`, issues),
  );
  assertUnique(constraintNames, `${field}.constraints.name`, issues);

  if (value.assets !== undefined && !Array.isArray(value.assets)) {
    issues.push(`${field}.assets must be an array.`);
  }
  const assets = Array.isArray(value.assets) ? value.assets : [];
  if (assets.length > 0) {
    /*
     * A file lives in one Site's store, because the store is the Site's Storage Profile. A row shared
     * across every Site has no store its file could belong to, and picking one would give every other
     * Site a file it cannot reach and did not pay for.
     */
    if (value.siteScoped !== true) {
      issues.push(
        `${field}.assets requires siteScoped: an object lives in one Site's store, and a table that ` +
        "belongs to no Site has none.",
      );
    }
    if (table && value.primaryKey !== undefined && Array.isArray(value.primaryKey)
      && value.primaryKey.length !== 1) {
      issues.push(
        `${field}.assets requires a single-column primary key: the asset table points at one column.`,
      );
    }
    // Every name Core will compose on the derived table, checked here rather than met as a PostgreSQL
    // error partway through a migration that has already created tables.
    const assetTable = composePhisAddonAssetTableName(table);
    for (const [part, suffix] of [
      ["slot", "check"], ["status", "check"], ["size", "check"], ["storage_key", "uq"],
      ["upload_token", "uq"],
      ["owner_id", "fk"], [PHIS_ADDON_SITE_COLUMN, "fk"],
      ["owner", "idx"], ["one", "idx"], ["pending", "idx"],
    ] as const) {
      assertComposedNameFits(assetTable, part, suffix, `${field}.assets on "${assetTable}"`, issues);
    }
  }
  const slotNames = assets.map((slot, index) =>
    validateAssetSlot(slot, `${field}.assets[${index}]`, issues)?.name ?? "",
  );
  assertUnique(slotNames, `${field}.assets.name`, issues);

  return issues.length === before ? (value as PhisAddonTableDescriptor) : null;
}

/**
 * Validates a descriptor and resolves what it points at.
 *
 * Own-table references are resolved last, because a table may reference one declared after it and the
 * descriptor is a shape rather than a sequence.
 */
export function validatePhisAddonSchemaDescriptor(
  value: unknown,
  field: string,
  issues: string[],
): PhisAddonSchemaDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  if (value.descriptorVersion !== PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION) {
    issues.push(`${field}.descriptorVersion must be ${PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION}.`);
  }
  const version = value.version;
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    issues.push(`${field}.version must be a positive integer.`);
  } else if (Number(version) > POSTGRES_SMALLINT_MAX) {
    issues.push(`${field}.version must fit PostgreSQL SMALLINT.`);
  }

  const rawTables = Array.isArray(value.tables) ? value.tables : [];
  if (!Array.isArray(value.tables) || rawTables.length === 0) {
    issues.push(`${field}.tables must be a non-empty array.`);
  }
  const tables = rawTables
    .map((table, index) => validateTable(table, `${field}.tables[${index}]`, issues))
    .filter((table): table is PhisAddonTableDescriptor => table !== null);
  assertUnique(tables.map((table) => table.name), `${field}.tables.name`, issues);

  const tablesByName = new Map(tables.map((table) => [table.name, table]));

  /*
   * A declared table must not land where Core is about to put a derived one.
   *
   * The collision is silent otherwise: the Add-on's own `offering_assets` would be created first and
   * the asset table's `CREATE` would then fail partway through a migration that has already made other
   * tables -- or succeed against a shape that happens to fit, and start mixing Core's rows into the
   * Add-on's.
   */
  for (const table of tables.filter((entry) => (entry.assets ?? []).length > 0)) {
    const derived = composePhisAddonAssetTableName(table.name);
    if (tablesByName.has(derived)) {
      issues.push(
        `${field}.tables declares "${derived}", which is the name Core gives the asset table of ` +
        `"${table.name}". One of the two has to be called something else.`,
      );
    }
  }

  for (const table of tables) {
    for (const column of table.columns) {
      if (!isReferenceColumn(column) || typeof column.references === "string") {
        continue;
      }
      const target = tablesByName.get(column.references.table);
      if (!target) {
        issues.push(
          `${field} table "${table.name}" column "${column.name}" references "${column.references.table}", ` +
          "which this Add-on does not declare.",
        );
        continue;
      }
      if (target.primaryKey.length !== 1) {
        issues.push(
          `${field} table "${table.name}" column "${column.name}" references "${target.name}", ` +
          "whose primary key is composite. A reference column carries one column.",
        );
      }
      if (!target.siteScoped) {
        continue;
      }
      // The key Core lays down on the target so PostgreSQL will accept the pair.
      assertComposedNameFits(
        target.name,
        PHIS_ADDON_SITE_COLUMN,
        "uq",
        `${field} table "${target.name}", referenced by "${table.name}"`,
        issues,
      );
      // Bound together with the Site, exactly as a group reference is, and refused where it cannot be.
      // A row of one Site naming a row of another is not something the declaration would show: the
      // column reads the same and the constraint still holds.
      if (!table.siteScoped) {
        issues.push(
          `${field} table "${table.name}" column "${column.name}" references Site-scoped "${target.name}", ` +
          `so "${table.name}" must be siteScoped too. Core binds the reference to the Site, and a table ` +
          "without one has no Site to bind it to.",
        );
      }
      if (column.onDelete !== "cascade") {
        issues.push(
          `${field} table "${table.name}" column "${column.name}" references Site-scoped "${target.name}" ` +
          "and must use onDelete \"cascade\": Core binds it together with the Site column, which cannot be nulled.",
        );
      }
    }
  }

  return issues.length === before ? (value as PhisAddonSchemaDescriptor) : null;
}
