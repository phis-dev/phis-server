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
  PHI_SERVER_ADDON_CORE_REFERENCES,
  PHI_SERVER_ADDON_SCHEMA_DESCRIPTOR_VERSION,
  type PhiServerAddonColumnDescriptor,
  type PhiServerAddonReferenceColumnDescriptor,
  type PhiServerAddonSchemaDescriptor,
  type PhiServerAddonTableDescriptor,
  type PhiServerAddonValueColumnDescriptor,
} from "./contract.ts";
import {
  POSTGRES_IDENTIFIER_MAX_LENGTH,
  composePhiServerAddonObjectName,
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
const CORE_REFERENCES = new Set<string>(Object.values(PHI_SERVER_ADDON_CORE_REFERENCES));
const MAX_STRING_LENGTH = 10_485_760;
const POSTGRES_SMALLINT_MAX = 32_767;

/** Core writes this column for a Site-scoped table, so an Add-on must not declare it. */
export const PHI_SERVER_ADDON_SITE_COLUMN = "site_id";

/** The same, for the two scopes that carry authority rather than a boundary. */
export const PHI_SERVER_ADDON_OWNER_COLUMN = "owner_user_id";
export const PHI_SERVER_ADDON_GROUP_COLUMN = "group_id";

const CORE_WRITTEN_COLUMNS: Readonly<Record<string, string>> = {
  [PHI_SERVER_ADDON_SITE_COLUMN]: "siteScoped",
  [PHI_SERVER_ADDON_OWNER_COLUMN]: "ownerScoped",
  [PHI_SERVER_ADDON_GROUP_COLUMN]: "groupScoped",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReferenceColumn(
  column: PhiServerAddonColumnDescriptor,
): column is PhiServerAddonReferenceColumnDescriptor {
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
  const composed = composePhiServerAddonObjectName(table, name, suffix);
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
): PhiServerAddonColumnDescriptor | null {
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
    return issues.length === before ? (value as PhiServerAddonReferenceColumnDescriptor) : null;
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
  return issues.length === before ? (value as PhiServerAddonValueColumnDescriptor) : null;
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

function validateTable(
  value: unknown,
  field: string,
  issues: string[],
): PhiServerAddonTableDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  const table = readName(value.name, `${field}.name`, issues);
  if (table.length > POSTGRES_IDENTIFIER_MAX_LENGTH) {
    issues.push(`${field}.name exceeds ${POSTGRES_IDENTIFIER_MAX_LENGTH} characters.`);
  }
  for (const scope of ["siteScoped", "ownerScoped", "groupScoped"] as const) {
    if (value[scope] !== undefined && typeof value[scope] !== "boolean") {
      issues.push(`${field}.${scope} must be a boolean.`);
    }
  }
  if (value.groupScoped === true && value.siteScoped !== true) {
    issues.push(
      `${field}.groupScoped requires siteScoped: a group belongs to a Site and has no meaning without one.`,
    );
  }

  const rawColumns = Array.isArray(value.columns) ? value.columns : [];
  if (!Array.isArray(value.columns) || rawColumns.length === 0) {
    issues.push(`${field}.columns must be a non-empty array.`);
  }
  const columns = rawColumns
    .map((column, index) => validateColumn(column, `${field}.columns[${index}]`, issues))
    .filter((column): column is PhiServerAddonColumnDescriptor => column !== null);
  const columnNames = new Set(columns.map((column) => column.name));
  assertUnique(columns.map((column) => column.name), `${field}.columns.name`, issues);
  for (const column of columns) {
    if (!isReferenceColumn(column) || column.references !== PHI_SERVER_ADDON_CORE_REFERENCES.group) {
      continue;
    }
    if (value.siteScoped !== true) {
      issues.push(
        `${field}.columns "${column.name}" points at ${PHI_SERVER_ADDON_CORE_REFERENCES.group}, ` +
        "so the table must be siteScoped. Core binds a group together with its Site.",
      );
    }
    // The foreign key covers the Site column too, and `SET NULL` would clear that one as well.
    if (column.onDelete !== "cascade") {
      issues.push(
        `${field}.columns "${column.name}" points at ${PHI_SERVER_ADDON_CORE_REFERENCES.group} ` +
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

  return issues.length === before ? (value as PhiServerAddonTableDescriptor) : null;
}

/**
 * Validates a descriptor and resolves what it points at.
 *
 * Own-table references are resolved last, because a table may reference one declared after it and the
 * descriptor is a shape rather than a sequence.
 */
export function validatePhiServerAddonSchemaDescriptor(
  value: unknown,
  field: string,
  issues: string[],
): PhiServerAddonSchemaDescriptor | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  if (value.descriptorVersion !== PHI_SERVER_ADDON_SCHEMA_DESCRIPTOR_VERSION) {
    issues.push(`${field}.descriptorVersion must be ${PHI_SERVER_ADDON_SCHEMA_DESCRIPTOR_VERSION}.`);
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
    .filter((table): table is PhiServerAddonTableDescriptor => table !== null);
  assertUnique(tables.map((table) => table.name), `${field}.tables.name`, issues);

  const tablesByName = new Map(tables.map((table) => [table.name, table]));
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
    }
  }

  return issues.length === before ? (value as PhiServerAddonSchemaDescriptor) : null;
}
