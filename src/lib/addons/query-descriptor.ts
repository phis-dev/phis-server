import {
  PHI_SERVER_ADDON_QUERY_MAX_LIMIT,
  type PhiServerAddonQueryCatalog,
  type PhiServerAddonQueryDescriptor,
  type PhiServerAddonSchemaDescriptor,
  type PhiServerAddonTableDescriptor,
} from "./contract.ts";
import {
  PHI_SERVER_ADDON_GROUP_COLUMN,
  PHI_SERVER_ADDON_OWNER_COLUMN,
  PHI_SERVER_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";

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
]);
const MAX_CONDITION_DEPTH = 8;
const AGGREGATE_FUNCTIONS = new Set(["count", "sum", "avg", "min", "max"]);
/** What `sum` and `avg` have something to add up over. `identity` is a key, and averaging one is a bug. */
const NUMERIC_COLUMN_TYPES = new Set(["smallInteger", "integer", "bigInteger"]);

const CORE_WRITTEN_COLUMNS = new Set([
  PHI_SERVER_ADDON_SITE_COLUMN,
  PHI_SERVER_ADDON_GROUP_COLUMN,
  PHI_SERVER_ADDON_OWNER_COLUMN,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ParameterDeclarations = {
  names: Set<string>;
  nullable: Set<string>;
  lists: Set<string>;
};

type QueryContext = {
  table: PhiServerAddonTableDescriptor;
  columns: Set<string>;
  parameters: Set<string>;
  nullableParameters: Set<string>;
  listParameters: Set<string>;
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
function readableColumns(table: PhiServerAddonTableDescriptor) {
  return new Set([
    ...table.columns.map((column) => column.name),
    ...(table.siteScoped ? [PHI_SERVER_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHI_SERVER_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHI_SERVER_ADDON_OWNER_COLUMN] : []),
  ]);
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

function checkValue(context: QueryContext, value: unknown, where: string) {
  if (!isRecord(value)) {
    context.issues.push(`${context.field}.${where} must be an object.`);
    return;
  }
  switch (value.kind) {
    case "parameter":
      if (typeof value.name !== "string" || !context.parameters.has(value.name)) {
        context.issues.push(`${context.field}.${where} names an undeclared parameter.`);
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
  if (!isRecord(condition)) {
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
      if (isRecord(condition.value) && (condition.value.kind === "actor" || condition.value.kind === "now")) {
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

function checkAssignments(context: QueryContext, raw: unknown, where: string) {
  const assignments = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw) || assignments.length === 0) {
    context.issues.push(`${context.field}.${where} must be a non-empty array.`);
    return;
  }
  const seen: string[] = [];
  assignments.forEach((assignment, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(assignment)) {
      context.issues.push(`${context.field}.${at} must be an object.`);
      return;
    }
    if (typeof assignment.column === "string" && CORE_WRITTEN_COLUMNS.has(assignment.column)) {
      // The scope columns are Core's on the way in as much as on the way out.
      context.issues.push(
        `${context.field}.${at}.column is "${assignment.column}", which Core writes itself.`,
      );
      return;
    }
    if (checkColumn(context, assignment.column, `${at}.column`)) {
      seen.push(assignment.column as string);
    }
    checkValue(context, assignment.value, `${at}.value`);
  });
  const duplicates = seen.filter((column, index) => seen.indexOf(column) !== index);
  if (duplicates.length > 0) {
    context.issues.push(`${context.field}.${where} sets ${duplicates[0]} more than once.`);
  }
}

function validateQuery(
  raw: unknown,
  schema: PhiServerAddonSchemaDescriptor,
  declared: ParameterDeclarations,
  declaredRoles: Set<string>,
  field: string,
  issues: string[],
) {
  if (!isRecord(raw)) {
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
          if (!isRecord(entry)) {
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
        raw.limit <= 0 || raw.limit > PHI_SERVER_ADDON_QUERY_MAX_LIMIT
      ) {
        issues.push(
          `${field}.limit must be an integer between 1 and ${PHI_SERVER_ADDON_QUERY_MAX_LIMIT}.`,
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
        if (!isRecord(entry)) {
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
          raw.limit <= 0 || raw.limit > PHI_SERVER_ADDON_QUERY_MAX_LIMIT
        ) {
          issues.push(
            `${field}.limit must be an integer between 1 and ${PHI_SERVER_ADDON_QUERY_MAX_LIMIT}: ` +
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
  return raw as unknown as PhiServerAddonQueryDescriptor;
}

/**
 * Validates a query catalog against the schema its Add-on declares.
 *
 * A catalog without a schema is refused outright rather than treated as empty: queries against tables
 * that do not exist are a mistake worth naming, not an absence.
 */
export function validatePhiServerAddonQueryCatalog(
  value: unknown,
  schema: PhiServerAddonSchemaDescriptor | null,
  field: string,
  issues: string[],
  /** The role names the manifest declares. A query may only require one of these. */
  declaredRoles: Set<string> = new Set(),
): PhiServerAddonQueryCatalog | null {
  const before = issues.length;
  if (!isRecord(value)) {
    issues.push(`${field} must be an object.`);
    return null;
  }
  if (!schema) {
    issues.push(`${field} declares queries, but this Add-on owns no tables to run them against.`);
    return null;
  }

  const rawParameters = isRecord(value.parameters) ? value.parameters : null;
  if (!rawParameters) {
    issues.push(`${field}.parameters must be an object keyed by query name.`);
    return null;
  }
  const parametersByQuery = new Map<string, ParameterDeclarations>();
  for (const [queryName, declared] of Object.entries(rawParameters)) {
    const names = new Set<string>();
    const nullable = new Set<string>();
    const lists = new Set<string>();
    const list = Array.isArray(declared) ? declared : [];
    if (!Array.isArray(declared)) {
      issues.push(`${field}.parameters.${queryName} must be an array.`);
    }
    list.forEach((parameter, index) => {
      const at = `${field}.parameters.${queryName}[${index}]`;
      if (!isRecord(parameter)) {
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
    });
    parametersByQuery.set(queryName, { names, nullable, lists });
  }

  const rawQueries = Array.isArray(value.queries) ? value.queries : [];
  if (!Array.isArray(value.queries)) {
    issues.push(`${field}.queries must be an array.`);
    return null;
  }
  const names: string[] = [];
  rawQueries.forEach((query, index) => {
    const queryName = isRecord(query) && typeof query.name === "string" ? query.name : `[${index}]`;
    names.push(queryName);
    validateQuery(
      query,
      schema,
      parametersByQuery.get(queryName) ?? { names: new Set(), nullable: new Set(), lists: new Set() },
      declaredRoles,
      `${field}.queries[${index}]`,
      issues,
    );
  });
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    issues.push(`${field}.queries declares "${duplicates[0]}" more than once.`);
  }

  return issues.length === before ? (value as unknown as PhiServerAddonQueryCatalog) : null;
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
export function phiServerAddonUnindexedSearches(
  schema: PhiServerAddonSchemaDescriptor,
  catalog: PhiServerAddonQueryCatalog,
): { query: string; table: string; column: string }[] {
  const found: { query: string; table: string; column: string }[] = [];
  const searched = (condition: unknown, into: Set<string>) => {
    if (!isRecord(condition)) {
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
