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
  PHI_SERVER_ADDON_GROUP_COLUMN,
  PHI_SERVER_ADDON_OWNER_COLUMN,
  PHI_SERVER_ADDON_SITE_COLUMN,
} from "./schema-descriptor.ts";
import {
  composePhiServerAddonAssetTableName,
  composePhiServerAddonObjectName,
} from "./schema-name.ts";

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
  [PHI_SERVER_ADDON_CORE_REFERENCES.group]: {
    table: "phis.site_groups",
    column: "id",
    type: "INTEGER",
  },
};

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
export function phiServerAddonCoreReferenceTables() {
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
  column: PhiServerAddonColumnDescriptor,
): column is PhiServerAddonReferenceColumnDescriptor {
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
function groupForeignKey(schemaName: string, tableName: string, columnName: string) {
  const target = CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.group];
  return (
    `ALTER TABLE ${qualify(schemaName, tableName)} ADD CONSTRAINT ` +
    `${quotePhiIdentifier(composePhiServerAddonObjectName(tableName, columnName, "fk"))} ` +
    `FOREIGN KEY (${quotePhiIdentifier(columnName)}, ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}) ` +
    `REFERENCES ${target.table}(${target.column}, ${PHI_SERVER_ADDON_SITE_COLUMN}) ON DELETE CASCADE`
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
    `${quotePhiIdentifier(composePhiServerAddonObjectName(tableName, columnName, "fk"))} ` +
    `FOREIGN KEY (${quotePhiIdentifier(columnName)}, ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}) ` +
    `REFERENCES ${qualify(schemaName, targetTable)}` +
    `(${quotePhiIdentifier(targetKey)}, ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}) ON DELETE CASCADE`
  );
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
  column: PhiServerAddonColumnDescriptor,
  tablesByName: Map<string, PhiServerAddonTableDescriptor>,
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
/**
 * The columns of the table Core keeps beside a table that declares assets.
 *
 * Every one of them is Core's. An Add-on names a slot and hands over bytes; what the object is called,
 * how big it turned out, and whether it ever arrived are answers Core writes and the Add-on reads.
 *
 * `status` is why the table can be trusted. A row is written before the transfer starts, as `pending`
 * with an `expires_at`, and becomes `ready` only once the bytes are complete. So the state that would
 * otherwise be undetectable -- a row naming an object that is not there -- is instead the most visible
 * thing in the table, findable with a `WHERE` rather than by listing a bucket.
 */
export const PHI_SERVER_ADDON_ASSET_STATUS = { pending: 1, ready: 2 } as const;

/** The longest an object key can be, matching what `media_assets` allows for the same thing. */
const ASSET_STORAGE_KEY_LENGTH = 512;

function assetTableStatements(
  schemaName: string,
  table: PhiServerAddonTableDescriptor,
): PhiServerAddonSchemaStatement[] {
  const slots = table.assets ?? [];
  const name = composePhiServerAddonAssetTableName(table.name);
  const key = table.columns.find((column) => column.name === table.primaryKey[0]);
  // The parent's key type, not a guess at it: an `identity` key is `BIGINT` on the referring side, and a
  // `uuid` key is a `UUID`. Naming a width here would compile and then refuse every insert.
  const ownerType = key && !isReferenceColumn(key) ? REFERENCED_KEY_TYPE_SQL[key.type]! : "BIGINT";
  const site = CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.site];
  const constraint = (part: string, suffix: "idx" | "check" | "fk" | "uq") =>
    quotePhiIdentifier(composePhiServerAddonObjectName(name, part, suffix));

  const statements: PhiServerAddonSchemaStatement[] = [{
    summary: `create table ${name}`,
    sql:
      `CREATE TABLE ${qualify(schemaName, name)} (\n  ` +
      [
        `${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} ${site.type} NOT NULL`,
        `"id" BIGINT GENERATED ALWAYS AS IDENTITY`,
        `"owner_id" ${ownerType} NOT NULL`,
        `"slot" VARCHAR(64) NOT NULL`,
        `"status" SMALLINT NOT NULL`,
        `"storage_key" VARCHAR(${ASSET_STORAGE_KEY_LENGTH}) NOT NULL`,
        `"byte_size" BIGINT NOT NULL`,
        `"content_type" VARCHAR(128) NOT NULL`,
        `"checksum_sha256" CHAR(64) NULL`,
        /*
         * What the reservation is redeemed with, and only while it is one.
         *
         * It is the authority on the transfer itself: it is high-entropy, single-use, expires, and
         * names exactly one object key at exactly one size. That is precisely what a presigned PUT
         * grants, and holding the Core-hosted plan to a stricter rule would make the same reservation
         * safe against S3 and unsafe against local storage.
         *
         * Nulled once the row is finished, so the unique key holds only over live reservations.
         */
        `"upload_token" VARCHAR(128) NULL`,
        // Only a pending row has one. It is what makes an abandoned upload collectable without asking
        // the storage anything.
        `"expires_at" TIMESTAMPTZ NULL`,
        `"created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        `"updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
        `PRIMARY KEY ("id")`,
        // The slot vocabulary, in the database rather than only in the descriptor: a manifest can be
        // replaced, and rows written under a slot that no longer exists would be invisible to every
        // query and still counted against the quota.
        `CONSTRAINT ${constraint("slot", "check")} CHECK ("slot" IN (${
          slots.map((slot) => quoteLiteral(slot.name)).join(", ")
        }))`,
        `CONSTRAINT ${constraint("status", "check")} CHECK ("status" IN (${
          Object.values(PHI_SERVER_ADDON_ASSET_STATUS).join(", ")
        }))`,
        `CONSTRAINT ${constraint("size", "check")} CHECK ("byte_size" >= 0)`,
        // One row per object. Two rows naming one object would make the first deletion take the second
        // one's bytes, and nothing about either row would show why.
        `CONSTRAINT ${constraint("storage_key", "uq")} UNIQUE ("storage_key")`,
        `CONSTRAINT ${constraint("upload_token", "uq")} UNIQUE ("upload_token")`,
        // The parent, within its Site. The cascade is the point of the whole table: removing a row takes
        // the rows describing its files, and the objects they named become collectable.
        `CONSTRAINT ${constraint("owner_id", "fk")} FOREIGN KEY ("owner_id", ${
          quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)
        }) REFERENCES ${qualify(schemaName, table.name)}(${
          quotePhiIdentifier(table.primaryKey[0]!)
        }, ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}) ON DELETE CASCADE`,
        `CONSTRAINT ${constraint(PHI_SERVER_ADDON_SITE_COLUMN, "fk")} FOREIGN KEY (${
          quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)
        }) REFERENCES ${site.table}(${site.column}) ON DELETE CASCADE`,
      ].join(",\n  ") +
      `\n)`,
  }];

  // "The files of this row", which is every read this table serves.
  statements.push({
    summary: `index ${name} by owner`,
    sql:
      `CREATE INDEX ${constraint("owner", "idx")} ON ${qualify(schemaName, name)} ` +
      `(${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}, "owner_id", "slot")`,
  });

  const single = slots.filter((slot) => slot.cardinality === "one");
  if (single.length > 0) {
    /*
     * One finished file per single-valued slot, and the partial index is what makes that survivable.
     *
     * A plain unique key would count the pending row too, and so would refuse the upload meant to
     * replace the current file -- leaving replacement possible only by deleting first, which is exactly
     * the window where a failed transfer loses the file it was replacing.
     */
    statements.push({
      summary: `hold ${name} to one finished file per slot`,
      sql:
        `CREATE UNIQUE INDEX ${constraint("one", "idx")} ON ${qualify(schemaName, name)} ` +
        `(${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}, "owner_id", "slot") ` +
        `WHERE "status" = ${PHI_SERVER_ADDON_ASSET_STATUS.ready} AND "slot" IN (${
          single.map((slot) => quoteLiteral(slot.name)).join(", ")
        })`,
    });
  }

  // What the sweep asks: which reservations were never completed and have run out of time.
  statements.push({
    summary: `index ${name} by expiry`,
    sql:
      `CREATE INDEX ${constraint("pending", "idx")} ON ${qualify(schemaName, name)} ` +
      `("expires_at") WHERE "status" = ${PHI_SERVER_ADDON_ASSET_STATUS.pending}`,
  });

  return statements;
}

export function buildPhiServerAddonSchemaStatements(
  schemaName: string,
  descriptor: PhiServerAddonSchemaDescriptor,
): PhiServerAddonSchemaStatement[] {
  const tablesByName = new Map(descriptor.tables.map((table) => [table.name, table]));
  const statements: PhiServerAddonSchemaStatement[] = [];
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
        ? `${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)} ${CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.site].type} NOT NULL`
        : null,
      table.groupScoped
        ? `${quotePhiIdentifier(PHI_SERVER_ADDON_GROUP_COLUMN)} ${CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.group].type} NOT NULL`
        : null,
      table.ownerScoped
        ? `${quotePhiIdentifier(PHI_SERVER_ADDON_OWNER_COLUMN)} ${CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.user].type} NULL`
        : null,
    ].filter((definition): definition is string => definition !== null));
    definitions.push(
      `PRIMARY KEY (${table.primaryKey.map((column) => quotePhiIdentifier(column)).join(", ")})`,
    );
    if (table.siteScoped) {
      for (const column of table.columns.filter((entry) => entry.unique)) {
        definitions.push(
          `CONSTRAINT ${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, column.name, "uq"))} ` +
          `UNIQUE (${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)}, ${quotePhiIdentifier(column.name)})`,
        );
      }
    }
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
        `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_SITE_COLUMN, "uq"))} ` +
        `UNIQUE (${quotePhiIdentifier(table.primaryKey[0]!)}, ${quotePhiIdentifier(PHI_SERVER_ADDON_SITE_COLUMN)})`,
    });
  }

  // After that key and not before it: the asset table names it in a foreign key written inline, so it
  // has to already be there.
  for (const table of descriptor.tables.filter((entry) => (entry.assets ?? []).length > 0)) {
    statements.push(...assetTableStatements(schemaName, table));
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
    if (table.groupScoped) {
      statements.push({
        summary: `bind ${table.name} to its group`,
        sql: groupForeignKey(schemaName, table.name, PHI_SERVER_ADDON_GROUP_COLUMN),
      });
      statements.push({
        summary: `index ${table.name} by group`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_GROUP_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHI_SERVER_ADDON_GROUP_COLUMN)})`,
      });
    }
    if (table.ownerScoped) {
      const target = CORE_REFERENCE_TARGETS[PHI_SERVER_ADDON_CORE_REFERENCES.user];
      statements.push({
        summary: `bind ${table.name} to its owner`,
        sql:
          `ALTER TABLE ${qualify(schemaName, table.name)} ADD CONSTRAINT ` +
          `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_OWNER_COLUMN, "fk"))} ` +
          `FOREIGN KEY (${quotePhiIdentifier(PHI_SERVER_ADDON_OWNER_COLUMN)}) ` +
          `REFERENCES ${target.table}(${target.column}) ON DELETE SET NULL`,
      });
      statements.push({
        summary: `index ${table.name} by owner`,
        sql:
          `CREATE INDEX ${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, PHI_SERVER_ADDON_OWNER_COLUMN, "idx"))} ` +
          `ON ${qualify(schemaName, table.name)} (${quotePhiIdentifier(PHI_SERVER_ADDON_OWNER_COLUMN)})`,
      });
    }
    for (const column of table.columns) {
      if (!isReferenceColumn(column)) {
        continue;
      }
      if (column.references === PHI_SERVER_ADDON_CORE_REFERENCES.group) {
        statements.push({
          summary: `point ${table.name}.${column.name} at ${column.references}`,
          sql: groupForeignKey(schemaName, table.name, column.name),
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
          `${quotePhiIdentifier(composePhiServerAddonObjectName(table.name, column.name, "fk"))} ` +
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
        composePhiServerAddonObjectName(table.name, index.name, "idx"),
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
          ? [PHI_SERVER_ADDON_SITE_COLUMN, ...index.columns]
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
