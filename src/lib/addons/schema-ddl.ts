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
  PHIS_ADDON_CORE_REFERENCES,
  type PhisAddonColumnDescriptor,
  type PhisAddonReferenceColumnDescriptor,
  type PhisAddonSchemaDescriptor,
  type PhisAddonTableConstraintDescriptor,
  type PhisAddonTableDescriptor,
} from "./contract.ts";
import {
  PHIS_ADDON_CREATED_BY_COLUMN,
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import {
  composePhisAddonAssetTableName,
  composePhisAddonObjectName,
} from "./schema-name.ts";

/**
 * What a symbolic Core reference actually points at.
 *
 * This map is the reason an Add-on never writes `phis.sites(id)`: the physical table can be renamed
 * here without an installed Add-on noticing, and `user_accounts` is a name no Add-on author would have
 * guessed from "the user".
 */
const CORE_REFERENCE_TARGETS: Record<string, { table: string; column: string; type: string }> = {
  [PHIS_ADDON_CORE_REFERENCES.site]: {
    table: "phis.sites",
    column: "id",
    type: "SMALLINT",
  },
  [PHIS_ADDON_CORE_REFERENCES.user]: {
    table: "phis.user_accounts",
    column: "id",
    type: "INTEGER",
  },
  [PHIS_ADDON_CORE_REFERENCES.group]: {
    table: "phis.site_groups",
    column: "id",
    type: "INTEGER",
  },
  [PHIS_ADDON_CORE_REFERENCES.mediaAsset]: {
    table: "phis.media_assets",
    column: "id",
    type: "INTEGER",
  },
};

/** The Core references Core binds together with the Site, because their targets live inside one. */
const SITE_BOUND_CORE_REFERENCES = new Set<string>([
  PHIS_ADDON_CORE_REFERENCES.group,
  PHIS_ADDON_CORE_REFERENCES.mediaAsset,
]);

/**
 * The physical Core tables an Add-on's schema may point at.
 *
 * Read by the bootstrap, which grants `REFERENCES` on exactly these to the migration role. PostgreSQL
 * treats "may point at me" as the target owner's to give, and the Core tables belong to the serving
 * role while Add-on schemas are built by the migration role -- so the contract's symbolic list and the
 * database's grants are the same decision, and deriving the second from the first is what stops them
 * from drifting apart. Adding a symbolic reference brings its grant along; a hand-written list would
 * not have, and the omission would only surface when someone installed an Add-on that used it.
 */
export function phisAddonCoreReferenceTables() {
  return [...new Set(Object.values(CORE_REFERENCE_TARGETS).map((target) => target.table))];
}

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
  column: PhisAddonColumnDescriptor,
): column is PhisAddonReferenceColumnDescriptor {
  return "references" in column;
}

function qualify(schemaName: string, table: string) {
  return `${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table)}`;
}

/**
 * A group is always bound together with its Site, never by id alone.
 *
 * Core references `site_groups (id, site_id)` everywhere it points at a group, against the unique key
 * the table carries for exactly this purpose. The id alone would let a row name a group of another
 * Site, and no Add-on would see that it had done so.
 */
function coreSiteBoundForeignKey(
  schemaName: string,
  tableName: string,
  columnName: string,
  reference: string,
) {
  const target = CORE_REFERENCE_TARGETS[reference]!;
  return (
    `ALTER TABLE ${qualify(schemaName, tableName)} ADD CONSTRAINT ` +
    `${quotePhiIdentifier(composePhisAddonObjectName(tableName, columnName, "fk"))} ` +
    `FOREIGN KEY (${quotePhiIdentifier(columnName)}, ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}) ` +
    `REFERENCES ${target.table}(${target.column}, ${PHIS_ADDON_SITE_COLUMN}) ON DELETE CASCADE`
  );
}

/**
 * One of the Add-on's own Site-scoped tables, referenced the same way a group is.
 *
 * The reasoning is the group's, applied a second time: an id alone would let a row of one Site name a
 * row of another, and no Add-on would see that it had done so. Here it is worse than a stray reference,
 * because the two rows are the Add-on's own and a query would happily read across the boundary Core
 * puts into every statement.
 *
 * `ON DELETE CASCADE` and no choice, as with the group: the constraint covers the Site column, and
 * `SET NULL` would clear that one too.
 */
function siteBoundForeignKey(
  schemaName: string,
  tableName: string,
  columnName: string,
  targetTable: string,
  targetKey: string,
) {
  return (
    `ALTER TABLE ${qualify(schemaName, tableName)} ADD CONSTRAINT ` +
    `${quotePhiIdentifier(composePhisAddonObjectName(tableName, columnName, "fk"))} ` +
    `FOREIGN KEY (${quotePhiIdentifier(columnName)}, ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}) ` +
    `REFERENCES ${qualify(schemaName, targetTable)}` +
    `(${quotePhiIdentifier(targetKey)}, ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}) ON DELETE CASCADE`
  );
}

function referenceColumnType(
  column: PhisAddonReferenceColumnDescriptor,
  tablesByName: Map<string, PhisAddonTableDescriptor>,
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

/**
 * In a Site-scoped table, unique means unique *within the Site*.
 *
 * An Add-on cannot say so itself: it may not declare `site_id`, so it can neither name it in an index
 * nor write the pair. Left as plain SQL uniqueness, `unique` would silently reach across every tenant on
 * the instance -- the second Site to install the Add-on would collide with the first over a value
 * neither of them can see, and the failure would arrive as a constraint violation on somebody else's
 * row. So Core prepends the Site column instead of the Add-on asking for it, exactly as it does for the
 * Site filter in every query.
 *
 * Instance-wide uniqueness is not expressible, and deliberately so. An Add-on holding rows for several
 * Sites has no business enforcing a rule across them, and one that genuinely needs a globally unique
 * value has an unscoped table for it.
 */
function columnDefinition(
  column: PhisAddonColumnDescriptor,
  tablesByName: Map<string, PhisAddonTableDescriptor>,
  siteScoped: boolean,
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
  if (column.unique && !siteScoped) {
    parts.push("UNIQUE");
  }
  if (!isReferenceColumn(column) && column.default) {
    parts.push(`DEFAULT ${column.default.kind === "now" ? "NOW()" : quoteLiteral(column.default.value)}`);
  }
  return parts.join(" ");
}

function constraintExpression(constraint: PhisAddonTableConstraintDescriptor) {
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

export type PhisAddonSchemaStatement = {
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
/**
 * The table Core keeps beside a table that declares assets.
 *
 * It holds a link and nothing else. Where the object is, how big it turned out, what type it is and
 * which digest it carries are facts Core already keeps in `media_assets` for every upload it has ever
 * handled -- copying them here would be a second record of one thing, and two records of one thing
 * eventually disagree.
 *
 * So a row is: which Site, which parent row, which slot, which file. Three of those five columns are
 * Core's scope columns; `slot` is the only fact that belongs to the Add-on.
 *
 * The link is bound to the Site and cascades. Bound, because an id alone would let a row of one Site
 * name a file of another and nothing in the declaration would show it. Cascading, because a file
 * removed in the Media view has to be able to go: the parent row survives and simply has nothing to
 * deliver, which is what makes deleting one a usable answer to somebody uploading rubbish.
 */
function assetTableStatements(
  schemaName: string,
  table: PhisAddonTableDescriptor,
): PhisAddonSchemaStatement[] {
  const slots = table.assets ?? [];
  const name = composePhisAddonAssetTableName(table.name);
  const key = table.columns.find((column) => column.name === table.primaryKey[0]);
  // The parent's key type, not a guess at it: an `identity` key is `BIGINT` on the side that points at
  // it, and a `uuid` key is a `UUID`. Naming a width here would compile and then refuse every insert.
  const ownerType = key && !isReferenceColumn(key) ? REFERENCED_KEY_TYPE_SQL[key.type]! : "BIGINT";
  const site = CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.site];
  const asset = CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.mediaAsset];
  const constraint = (part: string, suffix: "idx" | "check" | "fk" | "uq") =>
    quotePhiIdentifier(composePhisAddonObjectName(name, part, suffix));

  const statements: PhisAddonSchemaStatement[] = [{
    summary: `create table ${name}`,
    sql:
      `CREATE TABLE ${qualify(schemaName, name)} (\n  ` +
      [
        `${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} ${site.type} NOT NULL`,
        `"id" BIGINT GENERATED ALWAYS AS IDENTITY`,
        `"owner_id" ${ownerType} NOT NULL`,
        `"slot" VARCHAR(64) NOT NULL`,
        `"media_asset_id" ${asset.type} NOT NULL`,
        `"created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        `PRIMARY KEY ("id")`,
        // The slot vocabulary, in the database rather than only in the descriptor: a manifest can be
        // replaced, and rows written under a slot that no longer exists would be invisible to every
        // query and still hold a file.
        `CONSTRAINT ${constraint("slot", "check")} CHECK ("slot" IN (${
          slots.map((slot) => quoteLiteral(slot.name)).join(", ")
        }))`,
        // One row per file. Two rows on one file would make the first removal take the second one's
        // subject away, and nothing about either row would show why.
        `CONSTRAINT ${constraint("media_asset_id", "uq")} UNIQUE ("media_asset_id")`,
        `CONSTRAINT ${constraint("owner_id", "fk")} FOREIGN KEY ("owner_id", ${
          quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)
        }) REFERENCES ${qualify(schemaName, table.name)}(${
          quotePhiIdentifier(table.primaryKey[0]!)
        }, ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}) ON DELETE CASCADE`,
        `CONSTRAINT ${constraint("media_asset_id", "fk")} FOREIGN KEY ("media_asset_id", ${
          quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)
        }) REFERENCES ${asset.table}(${asset.column}, ${PHIS_ADDON_SITE_COLUMN}) ON DELETE CASCADE`,
        `CONSTRAINT ${constraint(PHIS_ADDON_SITE_COLUMN, "fk")} FOREIGN KEY (${
          quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)
        }) REFERENCES ${site.table}(${site.column}) ON DELETE CASCADE`,
      ].join(",\n  ") +
      `\n)`,
  }];

  // "The files of this row", which is every read this table serves.
  statements.push({
    summary: `index ${name} by owner`,
    sql:
      `CREATE INDEX ${constraint("owner", "idx")} ON ${qualify(schemaName, name)} ` +
      `(${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}, "owner_id", "slot")`,
  });

  const single = slots.filter((slot) => slot.cardinality === "one");
  if (single.length > 0) {
    /*
     * One file per single-valued slot, plainly, because every row in this table is a finished file.
     *
     * It was a partial index while an upload in progress lived here too: counting that row would have
     * refused the transfer meant to replace the current file. The reservation now lives in Core's
     * upload session instead, so nothing here is provisional and the rule can say what it means.
     */
    statements.push({
      summary: `hold ${name} to one file per slot`,
      sql:
        `CREATE UNIQUE INDEX ${constraint("one", "idx")} ON ${qualify(schemaName, name)} ` +
        `(${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}, "owner_id", "slot") ` +
        `WHERE "slot" IN (${single.map((slot) => quoteLiteral(slot.name)).join(", ")})`,
    });
  }

  return statements;
}

export function buildPhisAddonSchemaStatements(
  schemaName: string,
  descriptor: PhisAddonSchemaDescriptor,
): PhisAddonSchemaStatement[] {
  const tablesByName = new Map(descriptor.tables.map((table) => [table.name, table]));
  const statements: PhisAddonSchemaStatement[] = [];
  const siteBoundTargets = new Set([
    ...descriptor.tables.flatMap((table) =>
      table.columns
        .filter(isReferenceColumn)
        .map((column) => column.references)
        .filter((reference) => typeof reference !== "string")
        .map((reference) => reference.table)
        .filter((name) => tablesByName.get(name)?.siteScoped === true),
    ),
    // A table with assets is pointed at by the asset table Core adds beside it, and so needs the same
    // key -- even where nothing the Add-on declared points at it.
    ...descriptor.tables.filter((table) => (table.assets ?? []).length > 0).map((table) => table.name),
  ]);

  for (const table of descriptor.tables) {
    const definitions = table.columns.map((column) =>
      columnDefinition(column, tablesByName, table.siteScoped === true),
    );
    // The scope columns come first and in this order, so a `\d` on any Add-on table reads the same way:
    // where the row lives, whose group it is, and who owns it. Only the owner may be absent -- a deleted
    // user leaves the row behind rather than taking it along.
    definitions.unshift(...[
      table.siteScoped
        ? `${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)} ${CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.site].type} NOT NULL`
        : null,
      table.groupScoped
        ? `${quotePhiIdentifier(PHIS_ADDON_GROUP_COLUMN)} ${CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.group].type} NOT NULL`
        : null,
      table.ownerScoped
        ? `${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)} ${CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.user].type} NULL`
        : null,
      table.ownerScoped
        ? `${quotePhiIdentifier(PHIS_ADDON_CREATED_BY_COLUMN)} ${CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.user].type} NULL`
        : null,
    ].filter((definition): definition is string => definition !== null));
    /*
     * Where Core keeps a one-valued slot's delivery path, beside the Add-on's own columns.
     *
     * Nullable and unconstrained: it holds a path Core wrote and nothing else may write, and an empty
     * one means the slot is empty. Long enough for the address of a Media Asset, which is the only
     * shape it ever holds.
     */
    for (const slot of table.assets ?? []) {
      if (slot.mirrorColumn) {
        definitions.push(`${quotePhiIdentifier(slot.mirrorColumn)} VARCHAR(512) NULL`);
      }
    }
    definitions.push(
      `PRIMARY KEY (${table.primaryKey.map((column) => quotePhiIdentifier(column)).join(", ")})`,
    );
    if (table.siteScoped) {
      for (const column of table.columns.filter((entry) => entry.unique)) {
        definitions.push(
          `CONSTRAINT ${quotePhiIdentifier(composePhisAddonObjectName(table.name, column.name, "uq"))} ` +
          `UNIQUE (${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}, ${quotePhiIdentifier(column.name)})`,
        );
      }
    }
    for (const constraint of table.constraints ?? []) {
      definitions.push(
        `CONSTRAINT ${quotePhiIdentifier(composePhisAddonObjectName(table.name, constraint.name, "check"))} ` +
        `CHECK (${constraintExpression(constraint)})`,
      );
    }
    statements.push({
      summary: `create table ${table.name}`,
      sql: `CREATE TABLE ${qualify(schemaName, table.name)} (\n  ${definitions.join(",\n  ")}\n)`,
    });
  }

  /*
   * The key a Site-bound reference points at, laid down before any of them are added.
   *
   * PostgreSQL will only accept `(column, site_id)` against a unique key covering exactly those, and the
   * primary key alone is not it. This runs as its own pass because a table may be referenced by one
   * declared before it -- the descriptor is a shape, not a sequence.
   *
   * Only where something actually points: an unreferenced table would carry an index nothing reads.
   */
  for (const table of descriptor.tables.filter((entry) => siteBoundTargets.has(entry.name))) {
    statements.push({
      summary: `key ${table.name} by Site for references`,
      sql:
        `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
        `${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_SITE_COLUMN, "uq"))} ` +
        `UNIQUE (${quotePhiIdentifier(table.primaryKey[0]!)}, ${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)})`,
    });
  }

  // After that key and not before it: the asset table names it in a foreign key written inline, so it
  // has to already be there.
  for (const table of descriptor.tables.filter((entry) => (entry.assets ?? []).length > 0)) {
    statements.push(...assetTableStatements(schemaName, table));
  }

  for (const table of descriptor.tables) {
    if (table.siteScoped) {
      const target = CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.site];
      statements.push({
        summary: `bind ${table.name} to its Site`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_SITE_COLUMN, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)}) ` +
          `REFERENCES ${target.table}(${target.column}) ON DELETE CASCADE`,
      });
      statements.push({
        summary: `index ${table.name} by Site`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_SITE_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHIS_ADDON_SITE_COLUMN)})`,
      });
    }
    if (table.groupScoped) {
      statements.push({
        summary: `bind ${table.name} to its group`,
        sql: coreSiteBoundForeignKey(
          schemaName, table.name, PHIS_ADDON_GROUP_COLUMN,
          PHIS_ADDON_CORE_REFERENCES.group,
        ),
      });
      statements.push({
        summary: `index ${table.name} by group`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_GROUP_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHIS_ADDON_GROUP_COLUMN)})`,
      });
    }
    if (table.ownerScoped) {
      const target = CORE_REFERENCE_TARGETS[PHIS_ADDON_CORE_REFERENCES.user];
      statements.push({
        summary: `bind ${table.name} to its owner`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_OWNER_COLUMN, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)}) ` +
          `REFERENCES ${target.table}(${target.column}) ON DELETE SET NULL`,
      });
      statements.push({
        summary: `keep ${table.name} attributable to its author`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_CREATED_BY_COLUMN, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(PHIS_ADDON_CREATED_BY_COLUMN)}) ` +
          `REFERENCES ${target.table}(${target.column}) ON DELETE SET NULL`,
      });
      // No index: nothing filters on the author. It is read off a row that was found some other way.
      statements.push({
        summary: `index ${table.name} by owner`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhisAddonObjectName(table.name, PHIS_ADDON_OWNER_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHIS_ADDON_OWNER_COLUMN)})`,
      });
    }
    for (const column of table.columns) {
      if (!isReferenceColumn(column)) {
        continue;
      }
      if (SITE_BOUND_CORE_REFERENCES.has(column.references as string)) {
        statements.push({
          summary: `point ${table.name}.${column.name} at ${column.references} within its Site`,
          sql: coreSiteBoundForeignKey(
            schemaName, table.name, column.name, column.references as string,
          ),
        });
        continue;
      }
      if (typeof column.references !== "string" && tablesByName.get(column.references.table)!.siteScoped) {
        statements.push({
          summary: `point ${table.name}.${column.name} at ${column.references.table} within its Site`,
          sql: siteBoundForeignKey(
            schemaName,
            table.name,
            column.name,
            column.references.table,
            tablesByName.get(column.references.table)!.primaryKey[0]!,
          ),
        });
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
          `${quotePhiIdentifier(composePhisAddonObjectName(table.name, column.name, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(column.name)}) ` +
          `REFERENCES ${target.table}(${quotePhiIdentifier(target.column)}) ` +
          `ON DELETE ${column.onDelete === "cascade" ? "CASCADE" : "SET NULL"}`,
      });
    }
  }

  for (const table of descriptor.tables) {
    for (const index of table.indexes ?? []) {
      // A unique index is a uniqueness rule and follows the same reading as `unique` on a column: in a
      // Site-scoped table it holds within the Site. A non-unique index is only an access path and is
      // left as the Add-on wrote it -- the Site filter Core puts into every query is what makes it
      // useful, and prepending the column there would be a guess about which order helps.
      const name = quotePhiIdentifier(
        composePhisAddonObjectName(table.name, index.name, "idx"),
      );
      if (index.kind === "text") {
        /*
         * A trigram index, which is what makes `contains` a lookup instead of a scan.
         *
         * The Site column is not prepended here as it is on a unique index. This one is not a rule about
         * values, it is an access path, and the Site filter Core puts into every statement narrows the
         * candidate set the index produced. Putting `site_id` in front would need `btree_gin` and buy
         * nothing an installation with one busy Site would notice.
         */
        statements.push({
          summary: `index ${table.name} for text search on ${index.columns[0]}`,
          sql:
            `CREATE INDEX ${name} ON ${qualify(schemaName, table.name)} ` +
            `USING gin (${quotePhiIdentifier(index.columns[0]!)} gin_trgm_ops)`,
        });
        continue;
      }
      const columns =
        index.unique && table.siteScoped
          ? [PHIS_ADDON_SITE_COLUMN, ...index.columns]
          : index.columns;
      statements.push({
        summary: `index ${table.name} by ${columns.join(", ")}`,
        sql:
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${name} ` +
          `ON ${qualify(schemaName, table.name)} ` +
          `(${columns.map((column) => quotePhiIdentifier(column)).join(", ")})`,
      });
    }
  }

  return statements;
}
