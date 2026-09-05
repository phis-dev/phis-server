import {
  PHIS_ADDON_QUERY_MAX_LIMIT,
  type PhisAddonAggregateQueryDescriptor,
  type PhisAddonQueryAggregate,
  type PhisAddonInsertQueryDescriptor,
  type PhisAddonQueryCatalog,
  type PhisAddonQueryCondition,
  type PhisAddonQueryDescriptor,
  type PhisAddonQueryOrdering,
  type PhisAddonQueryParameterType,
  type PhisAddonQueryValue,
  type PhisAddonSchemaDescriptor,
  type PhisAddonSelectQueryDescriptor,
  type PhisAddonTableDescriptor,
} from "./contract.ts";
import {
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_CREATED_BY_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
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

export type PhisAddonCompiledQuery = {
  name: string;
  kind: PhisAddonQueryDescriptor["kind"];
  table: string;
  /** The first page, or the whole statement for anything that is not a select. */
  sql: string;
  /** What to bind, in order. Resolved per call against the arguments and the bound context. */
  bindings: PhisAddonQueryBinding[];
  /**
   * Whether the table carries row authority at all: an owner, a group, or both.
   *
   * False means Core has no row to judge, and `mayActOnRow` answers no to everything -- correct for a
   * row that should belong to somebody, and the reason such a table's writes must state a role instead.
   */
  scoped: boolean;
  /** Present on a select, and only there. */
  paging?: {
    /** The same statement with the keyset clause, for every page after the first. */
    sql: string;
    bindings: PhisAddonQueryBinding[];
    /** What the cursor is made of, and what the statement is ordered by. */
    ordering: PhisAddonQueryOrdering[];
    /** The Add-on's own ceiling, already capped at the hard maximum. */
    limit: number;
  };
};

export type PhisAddonQueryBinding =
  /**
   * `json` says the value is a document rather than a scalar, and it has to be said here.
   *
   * `pg` serialises a plain object to JSON of its own accord, and serialises an **array** to a
   * PostgreSQL array literal instead -- so `media: [...]` would arrive as `{...}` and be refused by the
   * column, while `provider: {...}` went through. One of the two shapes a document can have working and
   * the other not is worse than neither, so the value is serialised where its type is known.
   */
  | { from: "parameter"; name: string; json?: true }
  | { from: "literal"; value: string | number | boolean }
  | { from: "actor" }
  | { from: "site" }
  | { from: "id" }
  | { from: "group" }
  /** One value out of the cursor, in the order the query's ordering names them. */
  | { from: "cursor"; index: number }
  /** The page size Core settled on, plus the one row that answers "is there more". */
  | { from: "limit" };

/** `now()` is emitted as SQL rather than bound, so the instant is the database's and not the process's. */
const NOW_SQL = "NOW()";

/**
 * How a declared parameter type is spelled where PostgreSQL has to be told.
 *
 * Only one place needs this: a parameter tested for presence and nothing else. `$1 IS NULL` gives the
 * server no context to infer a type from, and it refuses the statement rather than guessing -- so the
 * declared type, which is known here, is written down.
 */
const PARAMETER_TYPE_SQL: Readonly<Record<PhisAddonQueryParameterType, string>> = {
  integer: "INTEGER",
  bigInteger: "BIGINT",
  text: "TEXT",
  boolean: "BOOLEAN",
  instant: "TIMESTAMPTZ",
  uuid: "UUID",
  json: "JSONB",
};

type Compiler = {
  bindings: PhisAddonQueryBinding[];
  parameterTypes: Map<string, PhisAddonQueryParameterType>;
  place(binding: PhisAddonQueryBinding): string;
};

function createCompiler(
  parameterTypes: Map<string, PhisAddonQueryParameterType> = new Map(),
): Compiler {
  const bindings: PhisAddonQueryBinding[] = [];
  return {
    bindings,
    parameterTypes,
    place(binding) {
      bindings.push(binding);
      return `$${bindings.length}`;
    },
  };
}

function valueSql(compiler: Compiler, value: PhisAddonQueryValue) {
  switch (value.kind) {
    case "parameter": {
      const json = compiler.parameterTypes.get(value.name) === "json";
      const placed = compiler.place(
        json ? { from: "parameter", name: value.name, json: true } : { from: "parameter", name: value.name },
      );
      // The cast is not decoration: the value arrives as JSON text, and the column is JSONB.
      return json ? `${placed}::JSONB` : placed;
    }
    case "literal":
      return compiler.place({ from: "literal", value: value.value });
    case "actor":
      return compiler.place({ from: "actor" });
    case "now":
      return NOW_SQL;
  }
}

/**
 * `contains`, spelled out.
 *
 * `ILIKE` rather than `lower(a) LIKE lower(b)` or `strpos`, because a trigram index answers `ILIKE` and
 * answers neither of the others -- and turning the one search this vocabulary offers into a guaranteed
 * table scan would be a poor trade for a shorter statement.
 *
 * The value is escaped here rather than trusted, and this is the whole reason `contains` is an operator
 * and not a pattern the Add-on writes. Someone searching a catalogue for "100%" means the three
 * characters; unescaped, the `%` would be a wildcard and the search would quietly return everything
 * starting with 100. The backslash goes first, or it would double the escapes added after it.
 */
function containsSql(compiler: Compiler, column: string, value: PhisAddonQueryValue) {
  const placed = valueSql(compiler, value);
  const escaped =
    `replace(replace(replace(${placed}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
  return `${quotePhiIdentifier(column)} ILIKE ('%' || ${escaped} || '%')`;
}

function conditionSql(
  compiler: Compiler,
  condition: PhisAddonQueryCondition,
): string {
  switch (condition.kind) {
    case "compare":
      return `${quotePhiIdentifier(condition.column)} ${condition.operator} ${valueSql(compiler, condition.value)}`;
    case "isNull":
      return `${quotePhiIdentifier(condition.column)} IS ${condition.negated ? "NOT " : ""}NULL`;
    case "contains":
      return containsSql(compiler, condition.column, condition.value);
    case "in": {
      if (condition.parameter !== undefined) {
        /*
         * `= ANY(array)` rather than `IN (a, b, c)`, and that is the point of the form rather than a
         * spelling of it. An expanded list makes the statement text a function of how many values
         * arrived: a different query plan per length, a cache entry per length, and a statement that is
         * assembled at request time -- which is what declaring queries exists to prevent. One binding
         * holds the whole list, so the query has one shape.
         *
         * The cast is not decoration. An array parameter arrives with no type of its own, and without it
         * PostgreSQL cannot tell which `ANY` this is.
         */
        const placed = compiler.place({ from: "parameter", name: condition.parameter });
        const declared = compiler.parameterTypes.get(condition.parameter);
        const cast = declared ? `::${PARAMETER_TYPE_SQL[declared]}[]` : "";
        return `${quotePhiIdentifier(condition.column)} = ANY(${placed}${cast})`;
      }
      // An empty list is `IN ()`, which is a syntax error, and `FALSE` is what it means anyway.
      return condition.values!.length === 0
        ? "FALSE"
        : `${quotePhiIdentifier(condition.column)} IN (${
          condition.values!.map((value) => valueSql(compiler, value)).join(", ")
        })`;
    }
    case "all":
    case "any": {
      if (condition.conditions.length === 0) {
        return condition.kind === "all" ? "TRUE" : "FALSE";
      }
      const joiner = condition.kind === "all" ? " AND " : " OR ";
      return `(${condition.conditions.map((entry) => conditionSql(compiler, entry)).join(joiner)})`;
    }
    case "whenPresent": {
      // The parameter is placed twice, which the compiler allows: each `place` binds it again under its
      // own number, and one call resolves both from the same argument.
      const given = compiler.place({ from: "parameter", name: condition.parameter });
      const declared = compiler.parameterTypes.get(condition.parameter);
      const cast = declared ? `::${PARAMETER_TYPE_SQL[declared]}` : "";
      return `(${given}${cast} IS NULL OR ${conditionSql(compiler, condition.condition)})`;
    }
  }
}

/**
 * The order a select actually runs under: what it asked for, then its primary key.
 *
 * A cursor needs a total order, and an Add-on's own ordering rarely is one. Two rows sharing an
 * `updated_at` may come back either way round, and the page boundary then falls between them
 * differently each time -- one row on two pages, another on none. The primary key is declared, so Core
 * can always finish the job, and no author has to know that they had to.
 */
export function phisAddonQueryOrdering(
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonSelectQueryDescriptor,
): PhisAddonQueryOrdering[] {
  const declared = descriptor.orderBy ?? [];
  const named = new Set(declared.map((entry) => entry.column));
  return [
    ...declared,
    ...table.primaryKey
      .filter((column) => !named.has(column))
      .map((column) => ({ column, direction: "asc" as const })),
  ];
}

/**
 * Where the next page starts, as a comparison against the last row of this one.
 *
 * Written out rather than as a row comparison: `ROW(a, b) > ROW(x, y)` only holds when every column
 * sorts the same way, and a listing that orders by date descending and key ascending is the ordinary
 * case rather than the exotic one. So each step says "equal so far, and past it here", which is the
 * same thing and survives mixed directions.
 *
 * Every ordering column is `NOT NULL` by validation, which is what makes this sound: a comparison
 * against null is null, and the page would end early and silently instead of continuing.
 */
function keysetSql(compiler: Compiler, ordering: PhisAddonQueryOrdering[]) {
  const branches: string[] = [];
  for (let index = 0; index < ordering.length; index += 1) {
    const steps = ordering.slice(0, index).map((entry, position) =>
      `${quotePhiIdentifier(entry.column)} = ${compiler.place({ from: "cursor", index: position })}`
    );
    const last = ordering[index]!;
    steps.push(
      `${quotePhiIdentifier(last.column)} ${last.direction === "desc" ? "<" : ">"} ` +
      `${compiler.place({ from: "cursor", index })}`,
    );
    branches.push(`(${steps.join(" AND ")})`);
  }
  return `(${branches.join(" OR ")})`;
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
function siteScopeSql(compiler: Compiler, table: PhisAddonTableDescriptor) {
  return table.siteScoped
    ? `${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} = ${compiler.place({ from: "site" })}`
    : null;
}

/**
 * What a select returns when it names nothing: the declared columns and the scope columns with them.
 *
 * The scope columns are readable, and a row that came back without them would be a row an Add-on
 * cannot tell apart from anyone else's -- which is exactly what it needs them for.
 */
/**
 * The columns Core keeps a slot's delivery path in.
 *
 * Readable like any other column -- a listing that could not read the path would be back to asking per
 * row, which is what the mirror exists to end -- and assignable by nobody: the compiler refuses a
 * declared query that names one, because a row pointing at a file it was not given is a row pointing at
 * somebody else's.
 */
function mirrorColumns(table: PhisAddonTableDescriptor) {
  return (table.assets ?? [])
    .map((slot) => slot.mirrorColumn)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

function selectableColumns(
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonSelectQueryDescriptor,
) {
  if (descriptor.columns && descriptor.columns.length > 0) {
    return descriptor.columns;
  }
  return [
    ...(table.siteScoped ? [PHIS_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHIS_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHIS_ADDON_OWNER_COLUMN, PHIS_ADDON_CREATED_BY_COLUMN] : []),
    ...table.columns.map((column) => column.name),
    ...mirrorColumns(table),
  ];
}

/**
 * A select is compiled twice: once for the first page, once for every page after it.
 *
 * They differ by one clause, and that clause needs the previous page's key values as bind parameters --
 * which the first call does not have. Two statements rather than one with a null-tolerant comparison,
 * because the first page is then exactly the statement it would have been without paging at all, and an
 * operator reading `phis-cli` sees which one runs.
 */
/** Where a select puts an ordering value for the cursor to read. Stripped before the row is handed on. */
export function cursorColumnName(index: number) {
  return `__phi_cursor_${index}`;
}

function compileSelect(
  schemaName: string,
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonSelectQueryDescriptor,
  continuation: boolean,
  parameterTypes: Map<string, PhisAddonQueryParameterType>,
): PhisAddonCompiledQuery {
  const compiler = createCompiler(parameterTypes);
  const ordering = phisAddonQueryOrdering(table, descriptor);
  /*
   * The ordering values come back as text, in columns of their own, and the cursor is built from those
   * rather than from the row.
   *
   * A `timestamptz` holds microseconds and a JavaScript Date holds milliseconds, so a cursor taken from
   * the mapped row is rounded -- and then matches neither `=` nor `<` against the value it came from.
   * The next page comes back empty and the rows after it are simply never seen: no error, no warning,
   * and only visible if somebody counts. `::text` is exact for every type an ordering column may have,
   * and the database parses it back into its own type on the next statement.
   */
  const cursorColumns = ordering.map((entry, index) =>
    `${quotePhiIdentifier(entry.column)}::text AS ${quotePhiIdentifier(cursorColumnName(index))}`
  );
  const columns = [
    ...selectableColumns(table, descriptor).map((column) => quotePhiIdentifier(column)),
    ...cursorColumns,
  ].join(", ");
  const clauses = [
    siteScopeSql(compiler, table),
    descriptor.where ? conditionSql(compiler, descriptor.where) : null,
    continuation ? keysetSql(compiler, ordering) : null,
  ].filter((clause): clause is string => clause !== null);
  const order = ` ORDER BY ${
    ordering
      .map((entry) => `${quotePhiIdentifier(entry.column)} ${entry.direction === "desc" ? "DESC" : "ASC"}`)
      .join(", ")
  }`;
  return {
    name: descriptor.name,
    kind: "select",
    table: table.name,
    scoped: table.ownerScoped === true || table.groupScoped === true,
    sql:
      `SELECT ${columns} FROM ${qualify(schemaName, table.name)}` +
      (clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "") +
      `${order} LIMIT ${compiler.place({ from: "limit" })}`,
    bindings: compiler.bindings,
  };
}

/**
 * What an aggregate is ordered and paged by: its grouping columns, and nothing else.
 *
 * They are a total order for free. `GROUP BY` yields each combination exactly once, so the grouping
 * columns identify a row of the answer the way a primary key identifies a row of the table -- there is
 * no tie for Core to break and no key to append.
 *
 * An ungrouped aggregate has one row and no order at all.
 */
function aggregateOrdering(
  descriptor: PhisAddonAggregateQueryDescriptor,
): PhisAddonQueryOrdering[] {
  return (descriptor.groupBy ?? []).map((column) => ({ column, direction: "asc" as const }));
}

function aggregateSql(entry: PhisAddonQueryAggregate) {
  const argument = entry.column ? quotePhiIdentifier(entry.column) : "*";
  return `${entry.function.toUpperCase()}(${argument}) AS ${quotePhiIdentifier(entry.as)}`;
}

function compileAggregate(
  schemaName: string,
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonAggregateQueryDescriptor,
  continuation: boolean,
  parameterTypes: Map<string, PhisAddonQueryParameterType>,
): PhisAddonCompiledQuery {
  const compiler = createCompiler(parameterTypes);
  const ordering = aggregateOrdering(descriptor);
  const grouping = (descriptor.groupBy ?? []).map((column) => quotePhiIdentifier(column));
  const columns = [
    ...grouping,
    ...descriptor.aggregates.map(aggregateSql),
    // As text, for the reason a select's ordering values are: a cursor built from the mapped value is
    // rounded, and then matches nothing on the next page.
    ...ordering.map((entry, index) =>
      `${quotePhiIdentifier(entry.column)}::text AS ${quotePhiIdentifier(cursorColumnName(index))}`
    ),
  ].join(", ");
  /*
   * The keyset goes in `WHERE`, before the grouping, not in `HAVING` after it.
   *
   * Sound only because the grouping columns are base columns: dropping the rows that sort before the
   * cursor drops exactly the groups that sort before it, and no surviving group loses a row. It is also
   * the cheaper half -- `HAVING` would compute every group and then throw most of them away.
   */
  const clauses = [
    siteScopeSql(compiler, table),
    descriptor.where ? conditionSql(compiler, descriptor.where) : null,
    continuation && ordering.length > 0 ? keysetSql(compiler, ordering) : null,
  ].filter((clause): clause is string => clause !== null);
  const tail = ordering.length > 0
    ? ` GROUP BY ${grouping.join(", ")} ORDER BY ${grouping.map((column) => `${column} ASC`).join(", ")}` +
      ` LIMIT ${compiler.place({ from: "limit" })}`
    : "";
  return {
    name: descriptor.name,
    kind: "aggregate",
    table: table.name,
    scoped: table.ownerScoped === true || table.groupScoped === true,
    sql:
      `SELECT ${columns} FROM ${qualify(schemaName, table.name)}` +
      (clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "") +
      tail,
    bindings: compiler.bindings,
  };
}

/**
 * Every column of the row, Core's own included.
 *
 * Shared by insert and delete, which hand back the row they wrote and the row they removed. A statement
 * that names its columns rather than `*` keeps the shape of the answer a decision of this file: a column
 * added to a table later does not silently start appearing in what an Add-on receives.
 */
function returningSql(table: PhisAddonTableDescriptor) {
  return [
    ...table.columns.map((column) => column.name),
    ...mirrorColumns(table),
    ...(table.siteScoped ? [PHIS_ADDON_SITE_COLUMN] : []),
    ...(table.groupScoped ? [PHIS_ADDON_GROUP_COLUMN] : []),
    ...(table.ownerScoped ? [PHIS_ADDON_OWNER_COLUMN, PHIS_ADDON_CREATED_BY_COLUMN] : []),
  ]
    .map((column) => quotePhiIdentifier(column))
    .join(", ");
}

function compileInsert(
  schemaName: string,
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonInsertQueryDescriptor,
  parameterTypes: Map<string, PhisAddonQueryParameterType>,
): PhisAddonCompiledQuery {
  const compiler = createCompiler(parameterTypes);
  const columns: string[] = [];
  const values: string[] = [];

  // Core's columns first, and written by Core. The descriptor has nowhere to name them, so there is no
  // form of this statement in which an Add-on chooses its own Site, group, or owner.
  if (table.siteScoped) {
    columns.push(PHIS_ADDON_SITE_COLUMN);
    values.push(compiler.place({ from: "site" }));
  }
  if (table.groupScoped) {
    columns.push(PHIS_ADDON_GROUP_COLUMN);
    values.push(compiler.place({ from: "group" }));
  }
  if (table.ownerScoped) {
    columns.push(PHIS_ADDON_OWNER_COLUMN);
    values.push(compiler.place({ from: "actor" }));
    // The same value, in a column no later statement touches. They part company at the first handover.
    columns.push(PHIS_ADDON_CREATED_BY_COLUMN);
    values.push(compiler.place({ from: "actor" }));
  }
  for (const assignment of descriptor.values) {
    columns.push(assignment.column);
    values.push(valueSql(compiler, assignment.value));
  }

  return {
    name: descriptor.name,
    kind: "insert",
    table: table.name,
    scoped: table.ownerScoped === true || table.groupScoped === true,
    sql:
      `INSERT INTO ${qualify(schemaName, table.name)} ` +
      `(${columns.map((column) => quotePhiIdentifier(column)).join(", ")}) ` +
      `VALUES (${values.join(", ")}) ` +
      `RETURNING ${returningSql(table)}`,
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
  table: PhisAddonTableDescriptor,
  descriptor: PhisAddonQueryDescriptor & { kind: "update" | "delete" },
  parameterTypes: Map<string, PhisAddonQueryParameterType>,
): PhisAddonCompiledQuery {
  const compiler = createCompiler(parameterTypes);
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
      ? [`${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} = ${compiler.place({ from: "site" })}`]
      : []),
  ].join(" AND ");
  return {
    name: descriptor.name,
    kind: descriptor.kind,
    table: table.name,
    scoped: table.ownerScoped === true || table.groupScoped === true,
    sql: descriptor.kind === "update"
      // The row as it now stands, so a caller reads what was written rather than what it sent. The two
      // differ wherever a default, a constraint or another column had a say.
      ? `UPDATE ${qualify(schemaName, table.name)} SET ${assignments} WHERE ${where} RETURNING ${returningSql(table)}`
      /*
       * A delete hands back the row it removed, which is the only moment it can be had.
       *
       * Without it the columns of a deleted row are gone the instant the statement runs, and an Add-on
       * holding an object key in one of them has no way to learn what it should now clean up -- the
       * bytes stay, counted against a quota, and nothing left in the database says whose they were.
       *
       * It tells nobody anything they did not already have. A refusal still answers null, exactly as a
       * missing row does, because the row only comes back when the deletion actually happened.
       */
      : `DELETE FROM ${qualify(schemaName, table.name)} WHERE ${where} RETURNING ${returningSql(table)}`,
    bindings: compiler.bindings,
  };
}

/**
 * Every declared query of one Add-on, compiled.
 *
 * A descriptor naming a table the schema does not declare is skipped rather than compiled; validation
 * has already refused such a catalog, and this stays a pure derivation with nothing to report.
 */
export function compilePhisAddonQueries(
  schemaName: string,
  schema: PhisAddonSchemaDescriptor,
  catalog: PhisAddonQueryCatalog,
): Map<string, PhisAddonCompiledQuery> {
  const tables = new Map(schema.tables.map((table) => [table.name, table]));
  const compiled = new Map<string, PhisAddonCompiledQuery>();
  for (const descriptor of catalog.queries) {
    const table = tables.get(descriptor.table);
    if (!table) {
      continue;
    }
    /*
     * Every kind needs these now, not only the two that page. `in` wanted the declared type to cast an
     * array, and a `json` parameter wants it to cast a document -- and documents are written, so the
     * kinds that write are exactly the ones that were not being told.
     */
    const parameterTypes = new Map(
      (catalog.parameters[descriptor.name] ?? []).map((parameter) =>
        [parameter.name, parameter.type] as const
      ),
    );
    if (descriptor.kind === "select") {
      const first = compileSelect(schemaName, table, descriptor, false, parameterTypes);
      const next = compileSelect(schemaName, table, descriptor, true, parameterTypes);
      compiled.set(descriptor.name, {
        ...first,
        paging: {
          sql: next.sql,
          bindings: next.bindings,
          ordering: phisAddonQueryOrdering(table, descriptor),
          limit: Math.min(descriptor.limit, PHIS_ADDON_QUERY_MAX_LIMIT),
        },
      });
    } else if (descriptor.kind === "aggregate") {
      const first = compileAggregate(schemaName, table, descriptor, false, parameterTypes);
      const ordering = aggregateOrdering(descriptor);
      if (ordering.length === 0) {
        // One row, no order, nothing to continue from.
        compiled.set(descriptor.name, first);
        continue;
      }
      const next = compileAggregate(schemaName, table, descriptor, true, parameterTypes);
      compiled.set(descriptor.name, {
        ...first,
        paging: {
          sql: next.sql,
          bindings: next.bindings,
          ordering,
          limit: Math.min(descriptor.limit ?? PHIS_ADDON_QUERY_MAX_LIMIT, PHIS_ADDON_QUERY_MAX_LIMIT),
        },
      });
    } else if (descriptor.kind === "insert") {
      compiled.set(descriptor.name, compileInsert(schemaName, table, descriptor, parameterTypes));
    } else if (table.primaryKey.length === 1) {
      compiled.set(
        descriptor.name,
        compileByIdMutation(schemaName, table, descriptor, parameterTypes),
      );
    }
  }
  return compiled;
}
