/**
 * The only place an Add-on's tables turn into SQL.
 *
 * The Add-on ships none, so this file is what section 15 means by "Core derives the statements". It is
 * PostgreSQL-specific by design: the descriptor is the portable half, and a second database system
 * would get a second generator rather than a second descriptor.
 *
 * Nothing here consults a request, a database, or an Add-on's code. Given a schema name and a
 * descriptor, the output is fixed -- which is what lets `phis-cli` show an operator exactly what it is
 * about to run.
 */

import {
  PHI_SERVER_ADDON_CORE_REFERENCES,
  type PhiServerAddonColumnDescriptor,
  type PhiServerAddonReferenceColumnDescriptor,
  type PhiServerAddonSchemaDescriptor,
  type PhiServerAddonTableConstraintDescriptor,
  type PhiServerAddonTableDescriptor,
} from "./contract.ts";
import {
  PHI_SERVER_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import { composePhiServerAddonObjectName } from "./schema-name.ts";

/**
 * What a symbolic Core reference actually points at.
 *
 * This map is the reason an Add-on never writes `phis.sites(id)`: the physical table can be renamed
 * here without an installed Add-on noticing, and `user_accounts` is a name no Add-on author would have
 * guessed from "the user".
 */
const CORE_REFERENCE_TARGETS: Record<string, { table: string; column: string; type: string }> = {
  [PHI_SERVER_ADDON_CORE_REFERENCES.site]: {
    table: "phis.sites",
    column: "id",
    type: "SMALLINT",
  },
  [PHI_SERVER_ADDON_CORE_REFERENCES.user]: {
    table: "phis.user_accounts",
    column: "id",
    type: "INTEGER",
  },
};

const COLUMN_TYPE_SQL: Record<string, string> = {
  identity: "BIGINT GENERATED ALWAYS AS IDENTITY",
  smallInteger: "SMALLINT",
  integer: "INTEGER",
  bigInteger: "BIGINT",
  text: "TEXT",
  boolean: "BOOLEAN",
  instant: "TIMESTAMPTZ",
  json: "JSONB",
  uuid: "UUID",
  binary: "BYTEA",
};

/** The physical type a reference column takes when it points at another table of the same Add-on. */
const REFERENCED_KEY_TYPE_SQL: Record<string, string> = {
  identity: "BIGINT",
  smallInteger: "SMALLINT",
  integer: "INTEGER",
  bigInteger: "BIGINT",
  text: "TEXT",
  boolean: "BOOLEAN",
  instant: "TIMESTAMPTZ",
  json: "JSONB",
  uuid: "UUID",
  binary: "BYTEA",
};

export function quotePhiIdentifier(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string | number | boolean) {
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function isReferenceColumn(
  column: PhiServerAddonColumnDescriptor,
): column is PhiServerAddonReferenceColumnDescriptor {
  return "references" in column;
}

function qualify(schemaName: string, table: string) {
  return `${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}`;
}

function referenceColumnType(
  column: PhiServerAddonReferenceColumnDescriptor,
  tablesByName: Map<string, PhiServerAddonTableDescriptor>,
): string {
  if (typeof column.references === "string") {
    return CORE_REFERENCE_TARGETS[column.references].type;
  }
  const target = tablesByName.get(column.references.table)!;
  const keyColumn = target.columns.find((entry) => entry.name === target.primaryKey[0])!;
  return isReferenceColumn(keyColumn)
    ? referenceColumnType(keyColumn, tablesByName)
    : REFERENCED_KEY_TYPE_SQL[keyColumn.type];
}

function columnDefinition(
  column: PhiServerAddonColumnDescriptor,
  tablesByName: Map<string, PhiServerAddonTableDescriptor>,
) {
  const parts = [quotePhiIdentifier(column.name)];
  if (isReferenceColumn(column)) {
    parts.push(referenceColumnType(column, tablesByName));
  } else if (column.type === "string") {
    parts.push(`VARCHAR(${column.maxLength})`);
  } else {
    parts.push(COLUMN_TYPE_SQL[column.type]);
  }
  parts.push(column.nullable ? "NULL" : "NOT NULL");
  if (column.unique) {
    parts.push("UNIQUE");
  }
  if (!isReferenceColumn(column) && column.default) {
    parts.push(`DEFAULT ${column.default.kind === "now" ? "NOW()" : quoteLiteral(column.default.value)}`);
  }
  return parts.join(" ");
}

function constraintExpression(constraint: PhiServerAddonTableConstraintDescriptor) {
  switch (constraint.kind) {
    case "range": {
      const bounds: string[] = [];
      const column = quotePhiIdentifier(constraint.column);
      if (constraint.min !== undefined) {
        bounds.push(`${column} ${constraint.exclusiveMin ? ">" : ">="} ${constraint.min}`);
      }
      if (constraint.max !== undefined) {
        bounds.push(`${column} ${constraint.exclusiveMax ? "<" : "<="} ${constraint.max}`);
      }
      return bounds.join(" AND ");
    }
    case "enumeration": {
      const values = constraint.values.map((value) => quoteLiteral(value)).join(", ");
      return `${quotePhiIdentifier(constraint.column)} IN (${values})`;
    }
    case "notEmpty": {
      return `length(trim(${quotePhiIdentifier(constraint.column)})) > 0`;
    }
    case "columnComparison": {
      return `${quotePhiIdentifier(constraint.left)} ${constraint.operator} ${quotePhiIdentifier(constraint.right)}`;
    }
    case "nullCardinality": {
      const terms = constraint.columns
        .map((column) => `(${quotePhiIdentifier(column)} IS NOT NULL)::int`)
        .join(" + ");
      return `(${terms}) = ${constraint.nonNullCount}`;
    }
  }
}

export type PhiServerAddonSchemaStatement = {
  /** What this statement is for, so `phis-cli` can show an operator a plan rather than a wall of SQL. */
  summary: string;
  sql: string;
};

/**
 * Everything needed to build an Add-on's schema, in the order it must run.
 *
 * Foreign keys come after every table rather than inline, so a descriptor may declare its tables in any
 * order and two tables may point at each other. The schema itself is not created here: that belongs with
 * the grants, which are the migration runner's business and not the descriptor's.
 */
export function buildPhiServerAddonSchemaStatements(
  schemaName: string,
  descriptor: PhiServerAddonSchemaDescriptor,
): PhiServerAddonSchemaStatement[] {
  const tablesByName = new Map(descriptor.tables.map((table) => [table.name, table]));
  const statements: PhiServerAddonSchemaStatement[] = [];

  for (const table of descriptor.tables) {
    const definitions = table.columns.map((column) => columnDefinition(column, tablesByName));
    if (table.siteScoped) {
      definitions.unshift(
        `${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} ${CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.site].type} NOT NULL`,
      );
    }
    definitions.push(
      `PRIMARY KEY (${table.primaryKey.map((column) => quotePhiIdentifier(column)).join(", ")})`,
    );
    for (const constraint of table.constraints ?? []) {
      definitions.push(
        `CONSTRAINT ${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, constraint.name, "check"))} ` +
        `CHECK (${constraintExpression(constraint)})`,
      );
    }
    statements.push({
      summary: `create table ${table.name}`,
      sql: `CREATE TABLE ${qualify(schemaName, table.name)} (\n  ${definitions.join(",\n  ")}\n)`,
    });
  }

  for (const table of descriptor.tables) {
    if (table.siteScoped) {
      const target = CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.site];
      statements.push({
        summary: `bind ${table.name} to its Site`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_SITE_COLUMN, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}) ` +
          `REFERENCES ${target.table}(${target.column}) ON DELETE CASCADE`,
      });
      statements.push({
        summary: `index ${table.name} by Site`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_SITE_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)})`,
      });
    }
    for (const column of table.columns) {
      if (!isReferenceColumn(column)) {
        continue;
      }
      const target = typeof column.references === "string"
        ? CORE_REFERENCE_TARGETS[column.references]
        : {
            table: qualify(schemaName, column.references.table),
            column: tablesByName.get(column.references.table)!.primaryKey[0],
          };
      statements.push({
        summary: `point ${table.name}.${column.name} at ${
          typeof column.references === "string" ? column.references : column.references.table
        }`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, column.name, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(column.name)}) ` +
          `REFERENCES ${target.table}(${quotePhiIdentifier(target.column)}) ` +
          `ON DELETE ${column.onDelete === "cascade" ? "CASCADE" : "SET NULL"}`,
      });
    }
  }

  for (const table of descriptor.tables) {
    for (const index of table.indexes ?? []) {
      statements.push({
        summary: `index ${table.name} by ${index.columns.join(", ")}`,
        sql:
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ` +
          `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, index.name, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} ` +
          `(${index.columns.map((column) => quotePhiIdentifier(column)).join(", ")})`,
      });
    }
  }

  return statements;
}
