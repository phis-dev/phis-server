import {
  PHI_SERVER_ADDON_QUERY_MAX_LIMIT,
  type PhiServerAddonInsertQueryDescriptor,
  type PhiServerAddonQueryCatalog,
  type PhiServerAddonQueryCondition,
  type PhiServerAddonQueryDescriptor,
  type PhiServerAddonQueryValue,
  type PhiServerAddonSchemaDescriptor,
  type PhiServerAddonSelectQueryDescriptor,
  type PhiServerAddonTableDescriptor,
} from "./contract.ts";
import {
  PHI_SERVER_ADDON_GROUP_COLUMN,
  PHI_SERVER_ADDON_OWNER_COLUMN,
  PHI_SERVER_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import { quotePhiIdentifier } from "./schema-ddl.ts";

/**
 * The only place an Add-on's declared queries turn into SQL.
 *
 * The counterpart of `schema-ddl.ts`, and PostgreSQL-specific for the same reason: the descriptor is
 * the portable half. Given a schema name, a schema descriptor and a query catalog, the output is fixed
 * -- nothing here consults a request, a database, or an Add-on's code, which is what lets `phis-cli`
 * print every statement an installed Add-on is able to run.
 *
 * Every value an Add-on supplies becomes a bind parameter. No argument reaches the text of a statement,
 * and identifiers come from the schema descriptor rather than from anything a caller passes.
 */

export type PhiServerAddonCompiledQuery = {
  name: string;
  kind: PhiServerAddonQueryDescriptor["kind"];
  table: string;
  sql: string;
  /** What to bind, in order. Resolved per call against the arguments and the bound context. */
  bindings: PhiServerAddonQueryBinding[];
};

export type PhiServerAddonQueryBinding =
  | { from: "parameter"; name: string }
  | { from: "literal"; value: string | number | boolean }
  | { from: "actor" }
  | { from: "site" }
  | { from: "id" }
  | { from: "group" }
  | { from: "offset" };

/** `now()` is emitted as SQL rather than bound, so the instant is the database's and not the process's. */
const NOW_SQL = "NOW()";

type Compiler = {
  bindings: PhiServerAddonQueryBinding[];
  place(binding: PhiServerAddonQueryBinding): string;
};

function createCompiler(): Compiler {
  const bindings: PhiServerAddonQueryBinding[] = [];
  return {
    bindings,
    place(binding) {
      bindings.push(binding);
      return `$${bindings.length}`;
    },
  };
}

function valueSql(compiler: Compiler, value: PhiServerAddonQueryValue) {
  switch (value.kind) {
    case "parameter":
      return compiler.place({ from: "parameter", name: value.name });
    case "literal":
      return compiler.place({ from: "literal", value: value.value });
    case "actor":
      return compiler.place({ from: "actor" });
    case "now":
      return NOW_SQL;
  }
}

function conditionSql(
  compiler: Compiler,
  condition: PhiServerAddonQueryCondition,
): string {
  switch (condition.kind) {
    case "compare":
      return `${quotePhiIdentifier(condition.column)} ${condition.operator} ${valueSql(compiler, condition.value)}`;
    case "isNull":
      return `${quotePhiIdentifier(condition.column)} IS ${condition.negated ? "NOT " : ""}NULL`;
    case "in":
      // An empty list is `IN ()`, which is a syntax error, and `FALSE` is what it means anyway.
      return condition.values.length === 0
        ? "FALSE"
        : `${quotePhiIdentifier(condition.column)} IN (${
          condition.values.map((value) => valueSql(compiler, value)).join(", ")
        })`;
    case "all":
    case "any": {
      if (condition.conditions.length === 0) {
        return condition.kind === "all" ? "TRUE" : "FALSE";
      }
      const joiner = condition.kind === "all" ? " AND " : " OR ";
      return `(${condition.conditions.map((entry) => conditionSql(compiler, entry)).join(joiner)})`;
    }
  }
}

function qualify(schemaName: string, table: string) {
  return `${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}`;
}

/**
 * The Site filter Core puts into every statement against a Site-scoped table.
 *
 * This is what `siteScoped` promises beyond a column and a foreign key: not that an Add-on remembers
 * to filter, but that it has no statement in which the filter is missing.
 */
function siteScopeSql(compiler: Compiler, table: PhiServerAddonTableDescriptor) {
  return table.siteScoped
    ? `${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} = ${compiler.place({ from: "site" })}`
    : null;
}

/**
 * What a select returns when it names nothing: the declared columns and the scope columns with them.
 *
 * The scope columns are readable, and a row that came back without them would be a row an Add-on
 * cannot tell apart from anyone else's -- which is exactly what it needs them for.
 */
function selectableColumns(
  table: PhiServerAddonTableDescriptor,
  descriptor: PhiServerAddonSelectQueryDescriptor,
) {
  if (descriptor.columns && descriptor.columns.length > 0) {
    return descriptor.columns;
  }
  return [
    ...(table.siteScoped ? [PHI_SERVER_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHI_SERVER_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHI_SERVER_ADDON_OWNER_COLUMN] : []),
    ...table.columns.map((column) => column.name),
  ];
}

function compileSelect(
  schemaName: string,
  table: PhiServerAddonTableDescriptor,
  descriptor: PhiServerAddonSelectQueryDescriptor,
): PhiServerAddonCompiledQuery {
  const compiler = createCompiler();
  const columns = selectableColumns(table, descriptor)
    .map((column) => quotePhiIdentifier(column))
    .join(", ");
  const clauses = [
    siteScopeSql(compiler, table),
    descriptor.where ? conditionSql(compiler, descriptor.where) : null,
  ].filter((clause): clause is string => clause !== null);
  const order = descriptor.orderBy?.length
    ? ` ORDER BY ${
      descriptor.orderBy
        .map((entry) => `${quotePhiIdentifier(entry.column)} ${entry.direction === "desc" ? "DESC" : "ASC"}`)
        .join(", ")
    }`
    : "";
  const limit = Math.min(descriptor.limit, PHI_SERVER_ADDON_QUERY_MAX_LIMIT);
  const offset = descriptor.offsetParameter
    ? ` OFFSET ${compiler.place({ from: "offset" })}`
    : "";
  return {
    name: descriptor.name,
    kind: "select",
    table: table.name,
    sql:
      `SELECT ${columns} FROM ${qualify(schemaName, table.name)}` +
      (clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "") +
      `${order} LIMIT ${limit}${offset}`,
    bindings: compiler.bindings,
  };
}

function compileInsert(
  schemaName: string,
  table: PhiServerAddonTableDescriptor,
  descriptor: PhiServerAddonInsertQueryDescriptor,
): PhiServerAddonCompiledQuery {
  const compiler = createCompiler();
  const columns: string[] = [];
  const values: string[] = [];

  // Core's columns first, and written by Core. The descriptor has nowhere to name them, so there is no
  // form of this statement in which an Add-on chooses its own Site, group, or owner.
  if (table.siteScoped) {
    columns.push(PHI_SERVER_ADDON_SITE_COLUMN);
    values.push(compiler.place({ from: "site" }));
  }
  if (table.groupScoped) {
    columns.push(PHI_SERVER_ADDON_GROUP_COLUMN);
    values.push(compiler.place({ from: "group" }));
  }
  if (table.ownerScoped) {
    columns.push(PHI_SERVER_ADDON_OWNER_COLUMN);
    values.push(compiler.place({ from: "actor" }));
  }
  for (const assignment of descriptor.values) {
    columns.push(assignment.column);
    values.push(valueSql(compiler, assignment.value));
  }

  const returning = [
    ...table.columns.map((column) => column.name),
    ...(table.siteScoped ? [PHI_SERVER_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHI_SERVER_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHI_SERVER_ADDON_OWNER_COLUMN] : []),
  ];
  return {
    name: descriptor.name,
    kind: "insert",
    table: table.name,
    sql:
      `INSERT INTO ${qualify(schemaName, table.name)} ` +
      `(${columns.map((column) => quotePhiIdentifier(column)).join(", ")}) ` +
      `VALUES (${values.join(", ")}) ` +
      `RETURNING ${returning.map((column) => quotePhiIdentifier(column)).join(", ")}`,
    bindings: compiler.bindings,
  };
}

/**
 * Update and delete address one row by its primary key, and carry the Site filter as well.
 *
 * The row-level authority check happens before either statement runs, against the same id. Both halves
 * are needed: the check settles whether this actor may touch the row, the Site filter settles that the
 * row is on the Site the request belongs to.
 */
function compileByIdMutation(
  schemaName: string,
  table: PhiServerAddonTableDescriptor,
  descriptor: PhiServerAddonQueryDescriptor & { kind: "update" | "delete" },
): PhiServerAddonCompiledQuery {
  const compiler = createCompiler();
  const assignments = descriptor.kind === "update"
    ? descriptor.set
      .map((assignment) =>
        `${quotePhiIdentifier(assignment.column)} = ${valueSql(compiler, assignment.value)}`
      )
      .join(", ")
    : "";
  const key = quotePhiIdentifier(table.primaryKey[0]!);
  const where = [
    `${key} = ${compiler.place({ from: "id" })}`,
    ...(table.siteScoped
      ? [`${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} = ${compiler.place({ from: "site" })}`]
      : []),
  ].join(" AND ");
  return {
    name: descriptor.name,
    kind: descriptor.kind,
    table: table.name,
    sql: descriptor.kind === "update"
      ? `UPDATE ${qualify(schemaName, table.name)} SET ${assignments} WHERE ${where}`
      : `DELETE FROM ${qualify(schemaName, table.name)} WHERE ${where}`,
    bindings: compiler.bindings,
  };
}

/**
 * Every declared query of one Add-on, compiled.
 *
 * A descriptor naming a table the schema does not declare is skipped rather than compiled; validation
 * has already refused such a catalog, and this stays a pure derivation with nothing to report.
 */
export function compilePhiServerAddonQueries(
  schemaName: string,
  schema: PhiServerAddonSchemaDescriptor,
  catalog: PhiServerAddonQueryCatalog,
): Map<string, PhiServerAddonCompiledQuery> {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  const compiled = new Map<string, PhiServerAddonCompiledQuery>();
  for (const descriptor of catalog.queries) {
    const table = tables.get(descriptor.table);
    if (!table) {
      continue;
    }
    if (descriptor.kind === "select") {
      compiled.set(descriptor.name, compileSelect(schemaName, table, descriptor));
    } else if (descriptor.kind === "insert") {
      compiled.set(descriptor.name, compileInsert(schemaName, table, descriptor));
    } else if (table.primaryKey.length === 1) {
      compiled.set(descriptor.name, compileByIdMutation(schemaName, table, descriptor));
    }
  }
  return compiled;
}
