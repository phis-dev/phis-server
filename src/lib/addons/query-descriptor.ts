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
};

type QueryContext = {
  table: PhisAddonTableDescriptor;
  columns: Set<string>;
  parameters: Set<string>;
  nullableParameters: Set<string>;
  listParameters: Set<string>;
  jsonParameters: Set<string>;
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

function checkAssignments(context: QueryContext, raw: unknown, where: string) {
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
    if (checkColumn(context, assignment.column, `${at}.column`)) {
      seen.push(assignment.column as string);
      checkJsonAssignment(context, assignment.column as string, assignment.value, at);
    }
    checkValue(context, assignment.value, `${at}.value`, "assignment");
  });
  const duplicates = seen.filter((column, index) => seen.indexOf(column) !== index);
  if (duplicates.length > 0) {
    context.issues.push(`${context.field}.${where} sets ${duplicates[0]} more than once.`);
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
   */
  if (
    (raw.kind === "update" || raw.kind === "delete") &&
    table.ownerScoped !== true && table.groupScoped !== true &&
    raw.requiresRole === undefined
  ) {
    issues.push(
      `${field} changes rows of "${table.name}", which is neither ownerScoped nor groupScoped. ` +
      "Core has no row to judge, so such a query must state requiresRole.",
    );
  }
  const context: QueryContext = {
    table,
    columns: readableColumns(table),
    parameters,
    nullableParameters: declared.nullable,
    listParameters: declared.lists,
    jsonParameters: declared.jsons,
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
        raw.orderBy.forEach((entry, index) => {
          if (!isPhiRecord(entry)) {
            issues.push(`${field}.orderBy[${index}] must be an object.`);
            return;
          }
          if (checkColumn(context, entry.column, `orderBy[${index}].column`)) {
            /*
             * A nullable ordering column has no defined place for its nulls -- the descriptor cannot say
             * whether they come first or last -- and the keyset comparison that continues a page cannot
             * be written against one: a comparison with null is null, so the page would end early and
             * quietly rather than carry on. Refused here, where the author can still choose a default.
             */
            const declaredColumn = table.columns.find((column) => column.name === entry.column);
            if (declaredColumn?.nullable === true) {
              issues.push(
                `${field}.orderBy[${index}].column "${entry.column}" is nullable. An ordering column ` +
                "must be NOT NULL: paging continues by comparing against the last row's values, and " +
                "where nulls sort is not something the descriptor can say.",
              );
            }
          }
          if (entry.direction !== "asc" && entry.direction !== "desc") {
            issues.push(`${field}.orderBy[${index}].direction must be "asc" or "desc".`);
          }
        });
      } else if (raw.orderBy !== undefined) {
        issues.push(`${field}.orderBy must be an array.`);
      }
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
        // null, so the paging would end early and quietly.
        const declaredColumn = table.columns.find((entry) => entry.name === column);
        if (declaredColumn?.nullable === true) {
          issues.push(
            `${field}.groupBy[${index}] names nullable column "${column}". The grouping columns are ` +
            "what this query is paged by, and a paging column must be NOT NULL.",
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
      checkAssignments(context, raw.values, "values");
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
        checkAssignments(context, raw.set, "set");
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
    parametersByQuery.set(queryName, { names, nullable, lists, jsons });
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
        ?? { names: new Set(), nullable: new Set(), lists: new Set(), jsons: new Set() },
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
