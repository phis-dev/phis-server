import type { PoolClient } from "pg";

import type { PhisAddonSchemaDescriptor } from "../lib/addons/contract.ts";
import {
  buildPhisAddonSchemaStatements,
  describePhisAddonExpectedTables,
  quotePhiIdentifier,
  type PhisAddonSchemaStatement,
} from "../lib/addons/schema-ddl.ts";
import {
  PHIS_ADDON_CREATED_BY_COLUMN,
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "../lib/addons/schema-descriptor.ts";
import { composePhisAddonAssetTableName, composePhisAddonObjectName } from "../lib/addons/schema-name.ts";

/**
 * Creating, checking, and removing the schema an Add-on's tables live in.
 *
 * The statements come from the descriptor and nowhere else; what this file adds is the part a
 * descriptor cannot describe -- the schema itself, the grants that let the serving role read what was
 * just created, and the check afterwards.
 *
 * That check now has a different addressee than section 15 first gave it. An Add-on ships no SQL, so it
 * is not what we are guarding against; this reads back what Core's own generator produced, at the point
 * where a generator bug is still cheap.
 */

/** PostgreSQL's `confdeltype`, of which an Add-on may produce exactly two. */
const PERMITTED_DELETE_RULES = new Map([
  ["c", "cascade"],
  ["n", "set null"],
]);

export type PhisAddonSchemaTarget = {
  schemaName: string;
  descriptor: PhisAddonSchemaDescriptor;
};

/**
 * Prepares the schema and the grants, before any table exists.
 *
 * `ALTER DEFAULT PRIVILEGES` has to run first: it applies to objects created afterwards, so issuing it
 * later would leave exactly the tables this migration is about to create outside the grant. A migration
 * that succeeds while leaving the serving role unable to read the result is a failure that would
 * otherwise surface as a bug in the Add-on.
 */
async function prepareSchema(client: PoolClient, schemaName: string, servingRole: string) {
  const schema = quotePhiIdentifier(schemaName);
  const role = quotePhiIdentifier(servingRole);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  );
}

async function grantExistingObjects(client: PoolClient, schemaName: string, servingRole: string) {
  const schema = quotePhiIdentifier(schemaName);
  const role = quotePhiIdentifier(servingRole);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
}

export async function applyPhisAddonSchema(
  client: PoolClient,
  target: PhisAddonSchemaTarget,
  servingRole: string,
) {
  await prepareSchema(client, target.schemaName, servingRole);
  const statements = buildPhisAddonSchemaStatements(target.schemaName, target.descriptor);
  for (const statement of statements) {
    await client.query(statement.sql);
  }
  await grantExistingObjects(client, target.schemaName, servingRole);
  return statements;
}

export type PhisAddonSchemaExtensionPlan = {
  /** What is missing and can be added to tables that hold rows, in the order it has to run. */
  statements: PhisAddonSchemaStatement[];
  /** What differs in a way adding cannot reach: each would lose or rewrite something that exists. */
  refusals: string[];
};

/**
 * What it takes to bring a schema that exists to the shape its descriptor now declares, by adding.
 *
 * The comparison is with the database, not with the descriptor that was applied before: Core keeps only
 * that descriptor's checksum, and the catalog is the one record of what is actually there. What may be
 * added is what loses nothing and needs no value from anybody -- a table, a column that may be null or
 * has a default, an index, a foreign key -- and the generator's own statements are the ones that add it,
 * so an extended schema is the schema a fresh migration of the same descriptor would have built.
 *
 * Everything else is a refusal: a table, a column or a rule that is in the database and no longer
 * declared; a column whose type or nullability changed; a new rule over rows that exist (a CHECK, a
 * required column without a default, a uniqueness rule on a new column, a changed key); a change to the
 * scope columns or the asset slots, which carry authority and files. Defaults and the expressions of
 * existing CHECK constraints are not compared -- the catalog spells them its own way -- so a changed one
 * stays as the database has it.
 */
export async function planPhisAddonSchemaExtension(
  client: PoolClient,
  target: PhisAddonSchemaTarget,
): Promise<PhisAddonSchemaExtensionPlan> {
  const { schemaName, descriptor } = target;
  // One after the other: a client runs one query at a time, and pg@9 refuses a second one in flight.
  const [tableRows, columnRows, constraintRows, indexRows, keyRows] = [
    await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schemaName],
    ),
    await client.query<{ table_name: string; column_name: string; catalog_type: string; not_null: boolean }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS catalog_type, a.attnotnull AS not_null
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
      [schemaName],
    ),
    await client.query<{ table_name: string; name: string; type: string; definition: string }>(
      `SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1`,
      [schemaName],
    ),
    await client.query<{ name: string }>(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1`, [schemaName]),
    await client.query<{ table_name: string; column_name: string; position: number }>(
      `SELECT c.relname AS table_name, a.attname AS column_name, k.ord AS position
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = $1 AND i.indisprimary
        ORDER BY c.relname, k.ord`,
      [schemaName],
    ),
  ];

  const present = new Set(tableRows.rows.map((row) => row.table_name));
  const columnsOf = new Map<string, Map<string, { catalogType: string; nullable: boolean }>>();
  for (const row of columnRows.rows) {
    const columns = columnsOf.get(row.table_name) ?? new Map();
    columns.set(row.column_name, { catalogType: row.catalog_type, nullable: !row.not_null });
    columnsOf.set(row.table_name, columns);
  }
  const constraints = new Set(constraintRows.rows.map((row) => `${row.table_name}.${row.name}`));
  const indexes = new Set(indexRows.rows.map((row) => row.name));
  const keyOf = new Map<string, string[]>();
  for (const row of keyRows.rows) keyOf.set(row.table_name, [...(keyOf.get(row.table_name) ?? []), row.column_name]);

  const refusals: string[] = [];
  const additions: PhisAddonSchemaStatement[] = [];
  const declared = new Set(descriptor.tables.flatMap((table) => (
    (table.assets ?? []).length > 0 ? [table.name, composePhisAddonAssetTableName(table.name)] : [table.name]
  )));
  for (const name of present) {
    if (!declared.has(name)) refusals.push(`Table "${name}" is in ${schemaName} and no longer declared.`);
  }

  for (const table of describePhisAddonExpectedTables(descriptor)) {
    if (!present.has(table.name)) continue;
    const existing = columnsOf.get(table.name) ?? new Map();
    const expected = new Set(table.columns.map((column) => column.name));
    for (const name of existing.keys()) {
      if (!expected.has(name)) refusals.push(`Column "${table.name}.${name}" is in the database and no longer declared.`);
    }
    for (const column of table.columns) {
      const found = existing.get(column.name);
      if (found) {
        if (found.catalogType !== column.catalogType) {
          refusals.push(`Column "${table.name}.${column.name}" is ${found.catalogType} and declared ${column.catalogType}.`);
        }
        if (found.nullable !== column.nullable) {
          refusals.push(`Column "${table.name}.${column.name}" is declared ${column.nullable ? "nullable" : "required"} and is not.`);
        }
      } else if (column.addition === null) {
        refusals.push(
          `Column "${table.name}.${column.name}" is new and cannot be added to rows that exist: ` +
          "only a column that may be null or has a default, outside the key and without a uniqueness rule, can.",
        );
      } else {
        additions.push({
          summary: `add column ${table.name}.${column.name}`,
          creates: { kind: "table", table: table.name, name: `${table.name}.${column.name}` },
          sql: `ALTER TABLE ${quotePhiIdentifier(schemaName)}.${quotePhiIdentifier(table.name)} ADD COLUMN ${column.addition}`,
        });
      }
    }
    if ((keyOf.get(table.name) ?? []).join(",") !== table.primaryKey.join(",")) {
      refusals.push(`The key of "${table.name}" changed.`);
    }
    const checks = new Set(table.checks);
    for (const name of checks) {
      if (!constraints.has(`${table.name}.${name}`)) refusals.push(`Constraint "${name}" is new and would judge rows that exist.`);
    }
    for (const row of constraintRows.rows) {
      if (row.table_name === table.name && row.type === "c" && !checks.has(row.name)) {
        refusals.push(`Constraint "${row.name}" is in the database and no longer declared.`);
      }
    }
  }

  // The slots an asset table admits, which is its CHECK on `slot`: a slot taken away would strand files.
  for (const table of descriptor.tables) {
    const slots = (table.assets ?? []).map((slot) => slot.name).sort();
    const assetTable = composePhisAddonAssetTableName(table.name);
    if (slots.length === 0 || !present.has(assetTable)) continue;
    const check = constraintRows.rows.find((row) => (
      row.table_name === assetTable && row.name === composePhisAddonObjectName(assetTable, "slot", "check")
    ));
    const admitted = [...(check?.definition ?? "").matchAll(/'((?:[^']|'')*)'/gu)].map((match) => match[1]!.replaceAll("''", "'")).sort();
    if (admitted.join("\u0000") !== slots.join("\u0000")) {
      refusals.push(`The asset slots of "${table.name}" changed from ${admitted.join(", ") || "none"} to ${slots.join(", ")}.`);
    }
  }

  /*
   * A uniqueness rule or a foreign key that is no longer declared. Removing one would lose nothing, but
   * an extension only adds, and a rule left behind would go on refusing writes the Add-on now means to
   * make. Core's own asset tables are left out: their constraints are Core's shape.
   */
  const generated = buildPhisAddonSchemaStatements(schemaName, descriptor);
  const expectedRules = new Set(generated
    .filter((statement) => statement.creates.kind === "constraint")
    .map((statement) => `${statement.creates.table}.${statement.creates.name}`));
  for (const table of descriptor.tables) {
    for (const column of table.columns.filter((entry) => entry.unique)) {
      expectedRules.add(table.siteScoped
        ? `${table.name}.${composePhisAddonObjectName(table.name, column.name, "uq")}`
        : `${table.name}.${table.name}_${column.name}_key`);
    }
  }
  const declaredTables = new Set(descriptor.tables.map((table) => table.name));
  for (const row of constraintRows.rows) {
    if ((row.type === "u" || row.type === "f") && declaredTables.has(row.table_name)
      && !expectedRules.has(`${row.table_name}.${row.name}`)) {
      refusals.push(`Constraint "${row.name}" on "${row.table_name}" is in the database and no longer declared.`);
    }
  }

  const exists = (statement: PhisAddonSchemaStatement) => {
    const { kind, table, name } = statement.creates;
    return kind === "table" ? present.has(name) : kind === "index" ? indexes.has(name) : constraints.has(`${table}.${name}`);
  };
  // A new column goes in after the new tables are made and before anything points at it.
  const firstNonTable = generated.findIndex((statement) => statement.creates.kind !== "table");
  const ordered = firstNonTable < 0
    ? [...generated, ...additions]
    : [...generated.slice(0, firstNonTable), ...additions, ...generated.slice(firstNonTable)];
  return {
    statements: ordered.filter((statement) => additions.includes(statement) || !exists(statement)),
    refusals,
  };
}

/** Runs an extension plan into a schema that exists, with the grants the new objects need. */
export async function extendPhisAddonSchema(
  client: PoolClient,
  target: PhisAddonSchemaTarget,
  statements: readonly PhisAddonSchemaStatement[],
  servingRole: string,
) {
  // The default privileges were laid down when the schema was made; stating them again costs nothing
  // and keeps a schema made before they existed from creating tables nobody may read.
  await prepareSchema(client, target.schemaName, servingRole);
  for (const statement of statements) {
    await client.query(statement.sql);
  }
  await grantExistingObjects(client, target.schemaName, servingRole);
}

/**
 * Reads back what was produced and reports what section 15 forbids.
 *
 * Returns the complaints rather than throwing, so a caller can roll back with all of them in hand
 * instead of one at a time.
 */
export async function verifyPhisAddonSchema(
  client: PoolClient,
  target: PhisAddonSchemaTarget,
) {
  const issues: string[] = [];
  /*
   * The tables the descriptor names, and the ones Core adds beside them.
   *
   * A table that declares asset slots gets a link table Core generates and no descriptor mentions. It
   * belongs here for the reason this check exists at all: what is read back is Core's own output, and a
   * table Core wrote itself is not a stray one. Left out, no Add-on with slots could ever be migrated --
   * the very first thing the runner does after applying is complain about the table it just made.
   */
  const declared = new Set(target.descriptor.tables.flatMap((table) => (
    (table.assets ?? []).length > 0
      ? [table.name, composePhisAddonAssetTableName(table.name)]
      : [table.name]
  )));

  const { rows: tableRows } = await client.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [target.schemaName],
  );
  const present = new Set(tableRows.map((row) => row.table_name));
  for (const name of declared) {
    if (!present.has(name)) {
      issues.push(`Table "${name}" is declared but absent from ${target.schemaName}.`);
    }
  }
  for (const name of present) {
    if (!declared.has(name)) {
      issues.push(`Table "${name}" sits in ${target.schemaName} without being declared.`);
    }
  }

  const { rows: keyRows } = await client.query<{
    conname: string;
    source_schema: string;
    source_table: string;
    /** The first constrained column, which is the one the scope checks below are about. */
    source_column: string | null;
    target_schema: string;
    target_table: string;
    confdeltype: string;
  }>(
    `SELECT con.conname,
            src_ns.nspname AS source_schema,
            src.relname    AS source_table,
            (SELECT a.attname FROM pg_attribute a
              WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS source_column,
            tgt_ns.nspname AS target_schema,
            tgt.relname    AS target_table,
            con.confdeltype
       FROM pg_constraint con
       JOIN pg_class src        ON src.oid = con.conrelid
       JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
       JOIN pg_class tgt        ON tgt.oid = con.confrelid
       JOIN pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
      WHERE con.contype = 'f'
        AND $1 IN (src_ns.nspname, tgt_ns.nspname)`,
    [target.schemaName],
  );
  for (const row of keyRows) {
    if (row.target_schema === target.schemaName && row.source_schema !== target.schemaName) {
      issues.push(
        `${row.source_schema}.${row.source_table} references ${target.schemaName}.${row.target_table}. ` +
        "Core never depends on something an operator may uninstall.",
      );
      continue;
    }
    if (!PERMITTED_DELETE_RULES.has(row.confdeltype)) {
      issues.push(
        `Foreign key "${row.conname}" on ${row.source_table} uses a delete rule that lets an Add-on ` +
        "refuse a Core deletion.",
      );
    }
  }

  const siteScoped = target.descriptor.tables.filter((table) => table.siteScoped);
  if (siteScoped.length > 0) {
    const { rows: siteRows } = await client.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = $2`,
      [target.schemaName, PHIS_ADDON_SITE_COLUMN],
    );
    const boundTables = new Map(siteRows.map((row) => [row.table_name, row.is_nullable]));
    const siteKeys = new Set(
      keyRows
        .filter(
          (row) =>
            row.source_schema === target.schemaName &&
            row.target_table === "sites" &&
            row.confdeltype === "c",
        )
        .map((row) => row.source_table),
    );
    for (const table of siteScoped) {
      if (!boundTables.has(table.name)) {
        issues.push(`Site-scoped table "${table.name}" has no ${PHIS_ADDON_SITE_COLUMN}.`);
        continue;
      }
      if (boundTables.get(table.name) !== "NO") {
        issues.push(`Site-scoped table "${table.name}" allows a null Site.`);
      }
      if (!siteKeys.has(table.name)) {
        issues.push(
          `Site-scoped table "${table.name}" is not bound to phis.sites with a cascading delete.`,
        );
      }
    }
  }

  // The two scopes that carry authority. A missing column here does not fail loudly the way a missing
  // Site column does -- it silently means nobody owns the row and no level reaches it -- so the check
  // after the fact is the only thing that would notice.
  for (const [scope, column, targetTable] of [
    ["Owner-scoped", PHIS_ADDON_OWNER_COLUMN, "user_accounts"],
    // The author is checked with the owner because it is created with the owner, and because the two
    // point at the same table: a check that asked only "is this table bound to user_accounts" would be
    // satisfied by either of them and would notice neither going missing.
    ["Owner-scoped", PHIS_ADDON_CREATED_BY_COLUMN, "user_accounts"],
    ["Group-scoped", PHIS_ADDON_GROUP_COLUMN, "site_groups"],
  ] as const) {
    const scoped = target.descriptor.tables.filter(
      (table) => (scope === "Owner-scoped" ? table.ownerScoped : table.groupScoped),
    );
    if (scoped.length === 0) {
      continue;
    }
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = $2`,
      [target.schemaName, column],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const bound = new Set(
      keyRows
        .filter((row) => (
          row.source_schema === target.schemaName
          && row.target_table === targetTable
          && row.source_column === column
        ))
        .map((row) => row.source_table),
    );
    for (const table of scoped) {
      if (!present.has(table.name)) {
        issues.push(`${scope} table "${table.name}" has no ${column}.`);
        continue;
      }
      if (!bound.has(table.name)) {
        issues.push(
          `${scope} table "${table.name}" is not bound to phis.${targetTable} by ${column}.`,
        );
      }
    }
  }

  return issues;
}

/**
 * Removes an Add-on's data.
 *
 * This is the destructive half of section 15's two-step removal, and the only operation that touches
 * rows. Disabling an Add-on and uninstalling its package reach neither.
 */
export async function dropPhisAddonSchema(client: PoolClient, schemaName: string) {
  await client.query(`DROP SCHEMA IF EXISTS ${quotePhiIdentifier(schemaName)} CASCADE`);
}
