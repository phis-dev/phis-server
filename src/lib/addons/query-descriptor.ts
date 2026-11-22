import {
  PHIS_ADDON_QUERY_MAX_LIMIT,
  type PhisAddonQueryCatalog,
  type PhisAddonQueryDescriptor,
  type PhisAddonSchemaDescriptor,
  type PhisAddonTableDescriptor,
} from "./contract.ts";
import {
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import { isPhiRecord } from "../helpers/record.ts";

/**
 * What Core checks before a declared query becomes a statement.
 *
 * The counterpart of `schema-descriptor.ts`. Most of section 15's rules about queries are unstatable
 * rather than checked -- there is no join, no expression, and no place to put SQL -- so what remains is
 * what a well-meaning Add-on can still get wrong: a column it never declared, a parameter it never
 * named, a mutation on a table whose key is composite, or an attempt to write one of Core's own
 * columns.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const COMPARISONS = new Set(["=", "<>", "<", "<=", ">", ">="]);
const PARAMETER_TYPES = new Set([
  "integer",
  "bigInteger",
  "text",
  "boolean",
  "instant",
  "uuid",
  "json",
]);
const MAX_CONDITION_DEPTH = 8;
const AGGREGATE_FUNCTIONS = new Set(["count", "sum", "avg", "min", "max"]);
/** What `sum` and `avg` have something to add up over. `identity` is a key, and averaging one is a bug. */
const NUMERIC_COLUMN_TYPES = new Set(["smallInteger", "integer", "bigInteger"]);

const CORE_WRITTEN_COLUMNS = new Set([
  PHIS_ADDON_SITE_COLUMN,
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
]);

type ParameterDeclarations = {
  names: Set<string>;
  nullable: Set<string>;
  lists: Set<string>;
  jsons: Set<string>;
  types: Map<string, string>;
};

type QueryContext = {
  table: PhisAddonTableDescriptor;
  columns: Set<string>;
  parameters: Set<string>;
  nullableParameters: Set<string>;
  listParameters: Set<string>;
  jsonParameters: Set<string>;
  parameterTypes: Map<string, string>;
  field: string;
  issues: string[];
};

/**
 * The columns a query may name, which is more than the Add-on declared.
 *
 * Core's scope columns are readable and not writable. "The rows that are mine" is the commonest filter
 * an owner-scoped table has, and it needs `owner_user_id` by name; writing one is refused separately,
 * where assignments are checked. Reading what Core wrote gives an Add-on nothing it did not already
 * have -- it owns the rows.
 */
function readableColumns(table: PhisAddonTableDescriptor) {
  return new Set([
    ...table.columns.map((column) => column.name),
    ...mirrorColumns(table),
    ...(table.siteScoped ? [PHIS_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHIS_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHIS_ADDON_OWNER_COLUMN] : []),
  ]);
}

/**
 * The columns a slot mirrors its delivery path into: readable, and Core's to write.
 *
 * Readable because a listing that could not select the path would be back to asking per row, which is
 * the cost the mirror exists to remove. Not writable for the same reason the scope columns are not: a
 * row that could name its own file could name somebody else's.
 */
function mirrorColumns(table: PhisAddonTableDescriptor) {
  return (table.assets ?? [])
    .map((slot) => slot.mirrorColumn)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/**
 * Whether a readable column can hold null, Core's own included.
 *
 * The declared columns say so themselves. Core's are fixed by the DDL: `owner_user_id` is NULL once the
 * owning account is gone, and a mirror column is NULL while its slot is empty; the Site and group columns
 * are NOT NULL. Asking only the declared list would let the two nullable ones through as paging columns.
 */
function isNullableColumn(table: PhisAddonTableDescriptor, column: string) {
  if (column === PHIS_ADDON_OWNER_COLUMN || mirrorColumns(table).includes(column)) {
    return true;
  }
  return table.columns.find((entry) => entry.name === column)?.nullable === true;
}

/**
 * Whether a condition leaves out every row whose `column` is null: an `isNull` negated on it, alone or as
 * one of an `all`. An `any` or a `whenPresent` does not, since either may hold without it.
 */
function excludesNullOf(condition: unknown, column: string): boolean {
  if (!isPhiRecord(condition)) {
    return false;
  }
  if (condition.kind === "isNull") {
    return condition.column === column && condition.negated === true;
  }
  return condition.kind === "all" && Array.isArray(condition.conditions) &&
    condition.conditions.some((entry) => excludesNullOf(entry, column));
}

function checkColumn(context: QueryContext, column: unknown, where: string) {
  if (typeof column !== "string" || !context.columns.has(column)) {
    context.issues.push(
      `${context.field}.${where} does not name a column of ${context.table.name}.`,
    );
    return false;
  }
  return true;
}

/**
 * @param position Where this value stands. A `json` parameter is a document and not a comparable, so it
 * is refused everywhere a condition could reach it -- see `PhisAddonQueryParameterType`.
 */
function checkValue(
  context: QueryContext,
  value: unknown,
  where: string,
  position: "filter" | "assignment" = "filter",
) {
  if (!isPhiRecord(value)) {
    context.issues.push(`${context.field}.${where} must be an object.`);
    return;
  }
  switch (value.kind) {
    case "parameter":
      if (typeof value.name !== "string" || !context.parameters.has(value.name)) {
        context.issues.push(`${context.field}.${where} names an undeclared parameter.`);
      } else if (position === "filter" && context.jsonParameters.has(value.name)) {
        context.issues.push(
          `${context.field}.${where} filters on the json parameter "${value.name}". ` +
          "A document is written, never compared: filtering one would need paths and operators this " +
          "vocabulary does not have.",
        );
      }
      return;
    case "literal":
      if (!["string", "number", "boolean"].includes(typeof value.value)) {
        context.issues.push(`${context.field}.${where} is not a literal this vocabulary offers.`);
      }
      return;
    case "actor":
    case "now":
      return;
    default:
      context.issues.push(`${context.field}.${where} is not a value this vocabulary offers.`);
  }
}

function checkCondition(
  context: QueryContext,
  condition: unknown,
  where: string,
  depth: number,
) {
  if (depth > MAX_CONDITION_DEPTH) {
    context.issues.push(`${context.field}.${where} nests deeper than ${MAX_CONDITION_DEPTH}.`);
    return;
  }
  if (!isPhiRecord(condition)) {
    context.issues.push(`${context.field}.${where} must be an object.`);
    return;
  }
  switch (condition.kind) {
    case "compare":
      checkColumn(context, condition.column, `${where}.column`);
      if (typeof condition.operator !== "string" || !COMPARISONS.has(condition.operator)) {
        context.issues.push(`${context.field}.${where}.operator is not a comparison this offers.`);
      }
      checkValue(context, condition.value, `${where}.value`);
      return;
    case "isNull":
      checkColumn(context, condition.column, `${where}.column`);
      return;
    case "flags": {
      if (checkColumn(context, condition.column, `${where}.column`)) {
        const declared = context.table.columns.find((column) => column.name === condition.column);
        const type = declared && !("references" in declared) ? declared.type : undefined;
        if (type !== "smallInteger" && type !== "integer" && type !== "bigInteger") {
          context.issues.push(
            `${context.field}.${where}.column "${condition.column}" is not an integer column. ` +
            "flags tests the bits of an integer and nothing else.",
          );
        }
      }
      if (condition.match !== "all" && condition.match !== "none") {
        context.issues.push(`${context.field}.${where}.match must be "all" or "none".`);
      }
      const mask = condition.mask;
      if (isPhiRecord(mask) && mask.kind === "literal") {
        if (typeof mask.value !== "number" || !Number.isSafeInteger(mask.value) || mask.value <= 0) {
          context.issues.push(
            `${context.field}.${where}.mask must be a positive integer: a mask of no bits matches ` +
            "every row under all and none alike.",
          );
        }
      } else if (isPhiRecord(mask) && mask.kind === "parameter") {
        checkValue(context, mask, `${where}.mask`);
      } else {
        context.issues.push(
          `${context.field}.${where}.mask must be a parameter or a literal: an actor id and the ` +
          "current instant are not bits.",
        );
      }
      return;
    }
    case "contains": {
      if (checkColumn(context, condition.column, `${where}.column`)) {
        // Core's scope columns are readable but hold ids, and none of them is text -- a `find` returns
        // no descriptor for them either, so this one check answers both cases.
        const declared = context.table.columns.find((column) => column.name === condition.column);
        const type = declared && !("references" in declared) ? declared.type : undefined;
        if (type !== "text" && type !== "string") {
          context.issues.push(
            `${context.field}.${where}.column "${condition.column}" is not a text column. ` +
            "contains searches text and nothing else.",
          );
        }
      }
      if (isPhiRecord(condition.value) && (condition.value.kind === "actor" || condition.value.kind === "now")) {
        context.issues.push(
          `${context.field}.${where}.value must be a parameter or a literal: an actor id and the ` +
          "current instant are not things to search a text column for.",
        );
      } else {
        checkValue(context, condition.value, `${where}.value`);
      }
      return;
    }
    case "in": {
      checkColumn(context, condition.column, `${where}.column`);
      if (condition.parameter !== undefined) {
        if (condition.values !== undefined) {
          context.issues.push(
            `${context.field}.${where} states both values and parameter. ` +
            "A set fixed in the descriptor and a set the caller brings are two different conditions.",
          );
        }
        const name = condition.parameter;
        if (typeof name !== "string" || !context.parameters.has(name)) {
          context.issues.push(`${context.field}.${where}.parameter names an undeclared parameter.`);
        } else if (!context.listParameters.has(name)) {
          // Otherwise the statement compiles to `= ANY($n)` over a single value, which PostgreSQL
          // refuses at the first call rather than here.
          context.issues.push(
            `${context.field}.${where}.parameter "${name}" must be declared with list: true.`,
          );
        }
        return;
      }
      const values = Array.isArray(condition.values) ? condition.values : [];
      if (!Array.isArray(condition.values)) {
        context.issues.push(`${context.field}.${where}.values must be an array.`);
      }
      values.forEach((value, index) => checkValue(context, value, `${where}.values[${index}]`));
      return;
    }
    case "all":
    case "any": {
      const conditions = Array.isArray(condition.conditions) ? condition.conditions : [];
      if (!Array.isArray(condition.conditions)) {
        context.issues.push(`${context.field}.${where}.conditions must be an array.`);
      }
      conditions.forEach((entry, index) =>
        checkCondition(context, entry, `${where}.conditions[${index}]`, depth + 1)
      );
      return;
    }
    case "whenPresent": {
      const name = condition.parameter;
      if (typeof name !== "string" || !context.parameters.has(name)) {
        context.issues.push(`${context.field}.${where}.parameter names an undeclared parameter.`);
      } else if (!context.nullableParameters.has(name)) {
        context.issues.push(
          `${context.field}.${where}.parameter "${name}" must be nullable: absence is what switches ` +
          "this condition off, and a parameter that cannot be null is never absent.",
        );
      }
      checkCondition(context, condition.condition, `${where}.condition`, depth + 1);
      return;
    }
    default:
      context.issues.push(`${context.field}.${where}.kind is not a condition this vocabulary offers.`);
  }
}

/**
 * A document goes in a document column, and nothing else goes in one either.
 *
 * Both directions, because both mistakes are silent. A `json` parameter written to a `text` column
 * stores the serialised document as a string that reads back as one; a literal written to a `json`
 * column stores a bare JSON scalar where the Add-on meant an object, and every reader that expected a
 * document gets a string. PostgreSQL accepts both, which is why this is checked here.
 */
function checkJsonAssignment(
  context: QueryContext,
  column: string,
  value: unknown,
  at: string,
) {
  const declared = context.table.columns.find((entry) => entry.name === column);
  // Core's own scope columns reach here as undefined; assigning one is refused before this. A reference
  // column carries no type of its own -- it takes the type of what it points at, and never json.
  const columnType = declared && !("references" in declared) ? declared.type : null;
  if (!columnType) {
    return;
  }
  const wantsJson = columnType === "json";
  const isJsonParameter = isPhiRecord(value)
    && value.kind === "parameter"
    && typeof value.name === "string"
    && context.jsonParameters.has(value.name);
  if (wantsJson && !isJsonParameter) {
    context.issues.push(
      `${context.field}.${at} writes "${column}", which is json, from something other than a json ` +
      "parameter. A literal would be stored as a bare JSON scalar rather than as the document a " +
      "reader expects.",
    );
  }
  if (!wantsJson && isJsonParameter) {
    context.issues.push(
      `${context.field}.${at} writes the json parameter into "${column}", which is ${columnType}. ` +
      "The document would be stored as its serialised text and read back as a string.",
    );
  }
}

/**
 * `column = column + add`, checked for the three ways it can go quietly wrong.
 *
 * The column must hold an integer, or the sum is PostgreSQL's error at the first call -- or, for a text
 * column, a concatenation nobody meant. The summand must be an integer that cannot be null: `NULL` added
 * to a count makes the count `NULL`, which erases it rather than leaving it alone. And it must be a
 * parameter or a literal; an actor id and the current instant are not amounts.
 */
function checkIncrement(
  context: QueryContext,
  column: string,
  value: unknown,
  at: string,
) {
  const declared = context.table.columns.find((entry) => entry.name === column);
  // A reference column is a key into another table, and adding to a key is a bug, whatever its type.
  const type = declared && !("references" in declared) ? declared.type : undefined;
  if (!type || !NUMERIC_COLUMN_TYPES.has(type)) {
    context.issues.push(
      `${context.field}.${at}.column "${column}" is not an integer column. ` +
      "add sums integers and nothing else.",
    );
  }
  if (!isPhiRecord(value)) {
    context.issues.push(`${context.field}.${at}.add must be an object.`);
    return;
  }
  if (value.kind === "literal") {
    if (typeof value.value !== "number" || !Number.isSafeInteger(value.value)) {
      context.issues.push(`${context.field}.${at}.add must be an integer literal.`);
    }
    return;
  }
  if (value.kind !== "parameter") {
    context.issues.push(
      `${context.field}.${at}.add must be a parameter or a literal: an actor id and the current ` +
      "instant are not amounts.",
    );
    return;
  }
  if (typeof value.name !== "string" || !context.parameters.has(value.name)) {
    context.issues.push(`${context.field}.${at}.add names an undeclared parameter.`);
    return;
  }
  const parameterType = context.parameterTypes.get(value.name);
  if (parameterType !== "integer" && parameterType !== "bigInteger") {
    context.issues.push(
      `${context.field}.${at}.add names "${value.name}", which is ${String(parameterType)}. ` +
      "The amount added must be an integer or bigInteger parameter.",
    );
  }
  if (context.listParameters.has(value.name)) {
    context.issues.push(`${context.field}.${at}.add names the list parameter "${value.name}".`);
  }
  if (context.nullableParameters.has(value.name)) {
    context.issues.push(
      `${context.field}.${at}.add names the nullable parameter "${value.name}". A null amount would ` +
      "make the column null rather than leave it alone.",
    );
  }
}

/**
 * @param kind An insert writes values and nothing else. `add` needs a value to add to, which only an
 * update has.
 */
function checkAssignments(
  context: QueryContext,
  raw: unknown,
  where: string,
  kind: "insert" | "update",
) {
  const assignments = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw) || assignments.length === 0) {
    context.issues.push(`${context.field}.${where} must be a non-empty array.`);
    return;
  }
  const seen: string[] = [];
  assignments.forEach((assignment, index) => {
    const at = `${where}[${index}]`;
    if (!isPhiRecord(assignment)) {
      context.issues.push(`${context.field}.${at} must be an object.`);
      return;
    }
    if (
      typeof assignment.column === "string"
      && (
        CORE_WRITTEN_COLUMNS.has(assignment.column)
        || mirrorColumns(context.table).includes(assignment.column)
      )
    ) {
      // The scope columns are Core's on the way in as much as on the way out, and so is a slot's mirror.
      context.issues.push(
        `${context.field}.${at}.column is "${assignment.column}", which Core writes itself.`,
      );
      return;
    }
    const adds = assignment.add !== undefined;
    if (adds && assignment.value !== undefined) {
      context.issues.push(
        `${context.field}.${at} states both value and add. Writing a value and adding to the one ` +
        "that is there are two different assignments.",
      );
      return;
    }
    if (adds && kind !== "update") {
      context.issues.push(
        `${context.field}.${at}.add is only meaningful in an update: an insert has nothing to add to.`,
      );
      return;
    }
    if (checkColumn(context, assignment.column, `${at}.column`)) {
      seen.push(assignment.column as string);
      if (adds) {
        checkIncrement(context, assignment.column as string, assignment.add, at);
      } else {
        checkJsonAssignment(context, assignment.column as string, assignment.value, at);
      }
    }
    if (!adds) {
      checkValue(context, assignment.value, `${at}.value`, "assignment");
    }
  });
  const duplicates = seen.filter((column, index) => seen.indexOf(column) !== index);
  if (duplicates.length > 0) {
    context.issues.push(`${context.field}.${where} sets ${duplicates[0]} more than once.`);
  }
}

/**
 * One order a select is read in: `orderBy`, or one of its `orderings`.
 *
 * The same rules for each, because each is what a cursor is made of: a column of the table, a direction,
 * and no column that may be null.
 */
function checkOrdering(context: QueryContext, entries: unknown[], at: string) {
  const { field, issues, table } = context;
  entries.forEach((entry, index) => {
    if (!isPhiRecord(entry)) {
      issues.push(`${field}.${at}[${index}] must be an object.`);
      return;
    }
    if (checkColumn(context, entry.column, `${at}[${index}].column`)) {
      /*
       * A nullable ordering column has no defined place for its nulls -- the descriptor cannot say
       * whether they come first or last -- and the keyset comparison that continues a page cannot
       * be written against one: a comparison with null is null, so the page would end early and
       * quietly rather than carry on. Refused here, where the author can still choose a default.
       */
      if (isNullableColumn(table, entry.column as string)) {
        issues.push(
          `${field}.${at}[${index}].column "${entry.column}" is nullable. An ordering column ` +
          "must be NOT NULL: paging continues by comparing against the last row's values, and " +
          "where nulls sort is not something the descriptor can say.",
        );
      }
    }
    if (entry.direction !== "asc" && entry.direction !== "desc") {
      issues.push(`${field}.${at}[${index}].direction must be "asc" or "desc".`);
    }
  });
}

/**
 * The orders a caller may choose between, and the one a call that chooses none is read in.
 *
 * Each is held to `orderBy`'s rules. `orderBy` beside them is refused rather than ranked: with
 * `orderings` the query's own order is `defaultOrdering`, and a second one would leave it to the reader
 * which of the two a plain call gets.
 */
function checkOrderings(context: QueryContext, raw: Record<string, unknown>) {
  const { field, issues } = context;
  const orderings = raw.orderings;
  if (orderings === undefined) {
    if (raw.defaultOrdering !== undefined) {
      issues.push(`${field}.defaultOrdering names one of orderings, and this query declares none.`);
    }
    return;
  }
  const keys = isPhiRecord(orderings) ? Object.keys(orderings) : [];
  if (!isPhiRecord(orderings) || keys.length === 0) {
    issues.push(`${field}.orderings must be an object naming at least one ordering.`);
  } else {
    for (const key of keys) {
      if (!NAME_PATTERN.test(key)) {
        issues.push(`${field}.orderings key "${key}" is invalid.`);
      }
      const entries = orderings[key];
      if (!Array.isArray(entries) || entries.length === 0) {
        issues.push(`${field}.orderings.${key} must name at least one column to order by.`);
        continue;
      }
      checkOrdering(context, entries, `orderings.${key}`);
    }
  }
  if (raw.orderBy !== undefined) {
    issues.push(
      `${field} states both orderBy and orderings. With orderings the order a call that names none ` +
      "is read in is defaultOrdering, and orderBy beside it would be a second one.",
    );
  }
  const choice = raw.defaultOrdering;
  if (!isPhiRecord(choice)) {
    issues.push(
      `${field}.defaultOrdering must name one of orderings and a direction: it is the order a call ` +
      "that names none is read in.",
    );
    return;
  }
  if (typeof choice.key !== "string" || !keys.includes(choice.key)) {
    issues.push(`${field}.defaultOrdering.key does not name one of orderings.`);
  }
  if (choice.direction !== "asc" && choice.direction !== "desc") {
    issues.push(`${field}.defaultOrdering.direction must be "asc" or "desc".`);
  }
}

function validateQuery(
  raw: unknown,
  schema: PhisAddonSchemaDescriptor,
  declared: ParameterDeclarations,
  declaredRoles: Set<string>,
  field: string,
  issues: string[],
) {
  if (!isPhiRecord(raw)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  if (typeof raw.name !== "string" || !NAME_PATTERN.test(raw.name)) {
    issues.push(`${field}.name is invalid.`);
  }
  const table = schema.tables.find((entry) => entry.name === raw.table);
  if (!table) {
    issues.push(`${field}.table does not name a table this Add-on declares.`);
    return null;
  }
  const parameters = declared.names;
  if (raw.authority !== undefined && raw.authority !== "caller" && raw.authority !== "addon") {
    issues.push(`${field}.authority must be "caller" or "addon".`);
  }
  /*
   * The Add-on's own authority, declared on this one query. A role guards the caller's authority --
   * narrowing it or widening it -- and a query that does not run on the caller's authority has nothing
   * for a role to act on, so stating one beside it is a contradiction rather than a refinement.
   *
   * What it does not lift is checked where it always is: the scope columns are refused in every
   * insert's values below, this one's included, and an update or delete still addresses one row by its
   * key.
   */
  const addonAuthority = raw.authority === "addon";
  if (addonAuthority && raw.requiresRole !== undefined) {
    issues.push(
      `${field} states both authority "addon" and requiresRole. A role guards the caller's ` +
      "authority, and this query does not run on it.",
    );
  }
  if (addonAuthority && raw.alsoAllowedByRole !== undefined) {
    issues.push(
      `${field} states both authority "addon" and alsoAllowedByRole. A role widens the caller's ` +
      "authority, and this query does not run on it.",
    );
  }
  if (raw.requiresRole !== undefined) {
    if (typeof raw.requiresRole !== "string" || !declaredRoles.has(raw.requiresRole)) {
      issues.push(`${field}.requiresRole does not name a role this Add-on declares.`);
    }
  }
  if (raw.alsoAllowedByRole !== undefined) {
    if (typeof raw.alsoAllowedByRole !== "string" || !declaredRoles.has(raw.alsoAllowedByRole)) {
      issues.push(`${field}.alsoAllowedByRole does not name a role this Add-on declares.`);
    }
    if (raw.requiresRole !== undefined) {
      issues.push(
        `${field} states both requiresRole and alsoAllowedByRole. One narrows and the other widens; ` +
        "a query that wants both is two queries under one name.",
      );
    }
    if (raw.kind !== "update" && raw.kind !== "delete") {
      issues.push(
        `${field}.alsoAllowedByRole is only meaningful on an update or a delete, ` +
        "which are the only queries that judge a row. Use requiresRole.",
      );
    } else if (table.ownerScoped !== true && table.groupScoped !== true) {
      issues.push(
        `${field}.alsoAllowedByRole stands in for row authority, and "${table.name}" has none to ` +
        "stand in for. Such a table's writes state requiresRole, which is then the whole authority.",
      );
    }
  }
  /*
   * A table with no owner and no group has no row-level authority, so Core answers no to every update
   * and delete against it. A declared role is the only thing that can stand in for that -- and it has
   * to be declared here rather than checked in a handler, or the guarantee is somebody's memory.
   *
   * The Add-on's own authority is the other declaration that does: such a query runs as the Add-on,
   * and the Add-on vouches for it in the descriptor, which is where an operator reads it.
   */
  if (
    (raw.kind === "update" || raw.kind === "delete") &&
    table.ownerScoped !== true && table.groupScoped !== true &&
    raw.requiresRole === undefined && !addonAuthority
  ) {
    issues.push(
      `${field} changes rows of "${table.name}", which is neither ownerScoped nor groupScoped. ` +
      "Core has no row to judge, so such a query must state requiresRole.",
    );
  }
  /*
   * Only a select is read in an order a call chooses. Anywhere else the declaration would be read past,
   * and an Add-on that wrote one would believe it held.
   */
  if (raw.kind !== "select" && (raw.orderings !== undefined || raw.defaultOrdering !== undefined)) {
    issues.push(
      `${field}.orderings and defaultOrdering belong to a select: only a select is read in an order ` +
      "a call chooses.",
    );
  }
  const context: QueryContext = {
    table,
    columns: readableColumns(table),
    parameters,
    nullableParameters: declared.nullable,
    listParameters: declared.lists,
    jsonParameters: declared.jsons,
    parameterTypes: declared.types,
    field,
    issues,
  };

  switch (raw.kind) {
    case "select": {
      if (Array.isArray(raw.columns)) {
        raw.columns.forEach((column, index) => checkColumn(context, column, `columns[${index}]`));
      } else if (raw.columns !== undefined) {
        issues.push(`${field}.columns must be an array.`);
      }
      if (raw.where !== undefined) {
        checkCondition(context, raw.where, "where", 1);
      }
      if (Array.isArray(raw.orderBy)) {
        checkOrdering(context, raw.orderBy, "orderBy");
      } else if (raw.orderBy !== undefined) {
        issues.push(`${field}.orderBy must be an array.`);
      }
      checkOrderings(context, raw);
      if (
        typeof raw.limit !== "number" || !Number.isInteger(raw.limit) ||
        raw.limit <= 0 || raw.limit > PHIS_ADDON_QUERY_MAX_LIMIT
      ) {
        issues.push(
          `${field}.limit must be an integer between 1 and ${PHIS_ADDON_QUERY_MAX_LIMIT}.`,
        );
      }
      break;
    }
    case "aggregate": {
      if (raw.where !== undefined) {
        checkCondition(context, raw.where, "where", 1);
      }
      const aggregates = Array.isArray(raw.aggregates) ? raw.aggregates : [];
      if (!Array.isArray(raw.aggregates) || aggregates.length === 0) {
        issues.push(`${field}.aggregates must be a non-empty array.`);
      }
      const grouping = Array.isArray(raw.groupBy) ? raw.groupBy : [];
      if (raw.groupBy !== undefined && !Array.isArray(raw.groupBy)) {
        issues.push(`${field}.groupBy must be an array.`);
      }
      const taken = new Set<string>(grouping.filter((column): column is string =>
        typeof column === "string"
      ));
      aggregates.forEach((entry, index) => {
        const at = `aggregates[${index}]`;
        if (!isPhiRecord(entry)) {
          issues.push(`${field}.${at} must be an object.`);
          return;
        }
        if (typeof entry.function !== "string" || !AGGREGATE_FUNCTIONS.has(entry.function)) {
          issues.push(`${field}.${at}.function is not an aggregate this vocabulary offers.`);
        }
        if (typeof entry.as !== "string" || !NAME_PATTERN.test(entry.as)) {
          issues.push(`${field}.${at}.as is invalid.`);
        } else if (taken.has(entry.as)) {
          // The answer is one flat row; a name used twice would silently keep one of the two.
          issues.push(`${field}.${at}.as "${entry.as}" collides with another column of the answer.`);
        } else {
          taken.add(entry.as);
        }
        if (entry.column === undefined) {
          if (entry.function !== "count") {
            issues.push(`${field}.${at}.function "${String(entry.function)}" needs a column.`);
          }
          return;
        }
        if (!checkColumn(context, entry.column, `${at}.column`)) {
          return;
        }
        if (entry.function !== "sum" && entry.function !== "avg") {
          return;
        }
        /*
         * Refused here rather than by PostgreSQL at the first call. An average over a text column is a
         * manifest that is wrong when it is written, and an Add-on installed with one would carry a
         * query that raises for every caller -- which is exactly the class of fault declaring queries
         * is meant to move forward in time.
         */
        const declaredColumn = table.columns.find((column) => column.name === entry.column);
        const type = declaredColumn && !("references" in declaredColumn)
          ? declaredColumn.type
          : undefined;
        if (!type || !NUMERIC_COLUMN_TYPES.has(type)) {
          issues.push(
            `${field}.${at}.column "${String(entry.column)}" is not a numeric column, ` +
            `and ${entry.function} has nothing to add up.`,
          );
        }
      });
      grouping.forEach((column, index) => {
        if (!checkColumn(context, column, `groupBy[${index}]`)) {
          return;
        }
        // The grouping columns are the ordering, and an ordering column must be NOT NULL for the same
        // reason a select's must: the keyset comparison that continues a page matches nothing against a
        // null, so the paging would end early and quietly. A nullable column is a grouping column where
        // the query's own `where` leaves its nulls out: then there is no null group to page past.
        if (isNullableColumn(table, column as string) && !excludesNullOf(raw.where, column as string)) {
          issues.push(
            `${field}.groupBy[${index}] names nullable column "${column}". The grouping columns are ` +
            "what this query is paged by, and a paging column must be NOT NULL -- or the where must leave " +
            `its nulls out ({ kind: "isNull", column: "${column}", negated: true }).`,
          );
        }
      });
      if (grouping.length > 0) {
        if (
          typeof raw.limit !== "number" || !Number.isInteger(raw.limit) ||
          raw.limit <= 0 || raw.limit > PHIS_ADDON_QUERY_MAX_LIMIT
        ) {
          issues.push(
            `${field}.limit must be an integer between 1 and ${PHIS_ADDON_QUERY_MAX_LIMIT}: ` +
            "a grouped aggregate has as many rows as there are groups, so it is paged like a select.",
          );
        }
      } else if (raw.limit !== undefined) {
        issues.push(
          `${field}.limit says nothing without groupBy: an aggregate over the whole table is one row.`,
        );
      }
      break;
    }
    case "insert": {
      checkAssignments(context, raw.values, "values", "insert");
      if (table.groupScoped) {
        if (typeof raw.groupParameter !== "string" || !parameters.has(raw.groupParameter)) {
          issues.push(
            `${field}.groupParameter must name a declared parameter: ${table.name} is group-scoped, ` +
            "and Core writes the group from it rather than from the row.",
          );
        }
      } else if (raw.groupParameter !== undefined) {
        issues.push(`${field}.groupParameter is set, but ${table.name} is not group-scoped.`);
      }
      break;
    }
    case "update":
    case "delete": {
      if (table.primaryKey.length !== 1) {
        issues.push(
          `${field} addresses one row by its key, and ${table.name} has a composite primary key.`,
        );
      }
      if (typeof raw.idParameter !== "string" || !parameters.has(raw.idParameter)) {
        issues.push(`${field}.idParameter names an undeclared parameter.`);
      }
      if (raw.kind === "update") {
        checkAssignments(context, raw.set, "set", "update");
        /*
         * The same tree a select takes, checked the same way. It narrows the one row the key addresses
         * and cannot reach another, so there is no scan to report: a `contains` here reads one row.
         */
        if (raw.where !== undefined) {
          checkCondition(context, raw.where, "where", 1);
        }
      } else if (raw.where !== undefined) {
        /*
         * Refused rather than ignored. A delete has no condition beside its key, and one written after the
         * update's pattern would otherwise delete the row whether or not it held.
         */
        issues.push(
          `${field}.where is not part of a delete: it removes the row its key names, and a condition ` +
          "written here would be ignored rather than checked.",
        );
      }
      break;
    }
    default:
      issues.push(`${field}.kind is not a query this vocabulary offers.`);
      return null;
  }
  return raw as unknown as PhisAddonQueryDescriptor;
}

/**
 * Validates a query catalog against the schema its Add-on declares.
 *
 * A catalog without a schema is refused outright rather than treated as empty: queries against tables
 * that do not exist are a mistake worth naming, not an absence.
 */
export function validatePhisAddonQueryCatalog(
  value: unknown,
  schema: PhisAddonSchemaDescriptor | null,
  field: string,
  issues: string[],
  /** The role names the manifest declares. A query may only require one of these. */
  declaredRoles: Set<string> = new Set(),
): PhisAddonQueryCatalog | null {
  const before = issues.length;
  if (!isPhiRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  if (!schema) {
    issues.push(`${field} declares queries, but this Add-on owns no tables to run them against.`);
    return null;
  }

  const rawParameters = isPhiRecord(value.parameters) ? value.parameters : null;
  if (!rawParameters) {
    issues.push(`${field}.parameters must be an object keyed by query name.`);
    return null;
  }
  const parametersByQuery = new Map<string, ParameterDeclarations>();
  for (const [queryName, declared] of Object.entries(rawParameters)) {
    const names = new Set<string>();
    const nullable = new Set<string>();
    const lists = new Set<string>();
    const jsons = new Set<string>();
    const types = new Map<string, string>();
    const list = Array.isArray(declared) ? declared : [];
    if (!Array.isArray(declared)) {
      issues.push(`${field}.parameters.${queryName} must be an array.`);
    }
    list.forEach((parameter, index) => {
      const at = `${field}.parameters.${queryName}[${index}]`;
      if (!isPhiRecord(parameter)) {
        issues.push(`${at} must be an object.`);
        return;
      }
      if (typeof parameter.name !== "string" || !NAME_PATTERN.test(parameter.name)) {
        issues.push(`${at}.name is invalid.`);
        return;
      }
      if (names.has(parameter.name)) {
        issues.push(`${at}.name is declared twice.`);
      }
      if (typeof parameter.type !== "string" || !PARAMETER_TYPES.has(parameter.type)) {
        issues.push(`${at}.type is not a parameter type this vocabulary offers.`);
      }
      names.add(parameter.name);
      if (typeof parameter.type === "string") {
        types.set(parameter.name, parameter.type);
      }
      if (parameter.nullable === true) {
        nullable.add(parameter.name);
      }
      if (parameter.list !== undefined && typeof parameter.list !== "boolean") {
        issues.push(`${at}.list must be a boolean.`);
      }
      if (parameter.list === true) {
        lists.add(parameter.name);
      }
      if (parameter.type === "json") {
        jsons.add(parameter.name);
        if (parameter.list === true) {
          // `= ANY($n::JSONB[])` is a comparison, and a document is not compared. The list form exists
          // for asking a second question about keys that were just read, which documents are not.
          issues.push(`${at}.type json cannot also be a list: a document is written, never matched.`);
        }
      }
    });
    parametersByQuery.set(queryName, { names, nullable, lists, jsons, types });
  }

  const rawQueries = Array.isArray(value.queries) ? value.queries : [];
  if (!Array.isArray(value.queries)) {
    issues.push(`${field}.queries must be an array.`);
    return null;
  }
  const names: string[] = [];
  rawQueries.forEach((query, index) => {
    const queryName = isPhiRecord(query) && typeof query.name === "string" ? query.name : `[${index}]`;
    names.push(queryName);
    validateQuery(
      query,
      schema,
      parametersByQuery.get(queryName)
        ?? {
          names: new Set(),
          nullable: new Set(),
          lists: new Set(),
          jsons: new Set(),
          types: new Map(),
        },
      declaredRoles,
      `${field}.queries[${index}]`,
      issues,
    );
  });
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    issues.push(`${field}.queries declares "${duplicates[0]}" more than once.`);
  }

  return issues.length === before ? (value as unknown as PhisAddonQueryCatalog) : null;
}

/**
 * Searches that will read the whole table, because nothing indexes what they look in.
 *
 * Not an error: `contains` without a text index is correct, only slow, and refusing it would leave an
 * Add-on with a small table paying for a rule written for a large one. But it is exactly the judgement
 * the declarative catalogue exists to make possible -- what an Add-on will do to the database is
 * readable before it does it -- so it is reported where an operator is already looking, at install and
 * at `phis addon check`, rather than discovered later in a slow request.
 */
export function phisAddonUnindexedSearches(
  schema: PhisAddonSchemaDescriptor,
  catalog: PhisAddonQueryCatalog,
): { query: string; table: string; column: string }[] {
  const found: { query: string; table: string; column: string }[] = [];
  const searched = (condition: unknown, into: Set<string>) => {
    if (!isPhiRecord(condition)) {
      return;
    }
    if (condition.kind === "contains" && typeof condition.column === "string") {
      into.add(condition.column);
    }
    if (condition.kind === "whenPresent") {
      searched(condition.condition, into);
    }
    if (Array.isArray(condition.conditions)) {
      for (const entry of condition.conditions) {
        searched(entry, into);
      }
    }
  };

  for (const query of catalog.queries) {
    // An aggregate searches text the same way and scans the same table for it.
    if ((query.kind !== "select" && query.kind !== "aggregate") || !query.where) {
      continue;
    }
    const columns = new Set<string>();
    searched(query.where, columns);
    if (columns.size === 0) {
      continue;
    }
    const table = schema.tables.find((entry) => entry.name === query.table);
    const indexed = new Set(
      (table?.indexes ?? [])
        .filter((index) => index.kind === "text")
        .map((index) => index.columns[0]),
    );
    for (const column of columns) {
      if (!indexed.has(column)) {
        found.push({ query: query.name, table: query.table, column });
      }
    }
  }
  return found;
}

export type PhisAddonAuthorityBypass = {
  query: string;
  kind: PhisAddonQueryDescriptor["kind"];
  table: string;
};

/**
 * The queries that run with the Add-on's own authority, whoever calls the route behind them.
 *
 * Not an error either: a capacity a guest takes from is what `authority: "addon"` is for. But it is a
 * bypass of everything Core would otherwise ask of the caller -- the ladder, the group, the role -- and
 * the operator installing the Add-on is the one who has to agree to it, so it is named where they are
 * already looking, at install, at upgrade and at `phis addon check`. In declaration order, because that
 * is the order the manifest reads in.
 */
export function phisAddonAuthorityBypasses(
  catalog: PhisAddonQueryCatalog,
): PhisAddonAuthorityBypass[] {
  return catalog.queries
    .filter((query) => query.authority === "addon")
    .map((query) => ({ query: query.name, kind: query.kind, table: query.table }));
}
