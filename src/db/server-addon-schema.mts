import type { PoolClient } from "pg";

import type { PhisAddonSchemaDescriptor } from "../lib/addons/contract.ts";
import {
  buildPhisAddonSchemaStatements,
  quotePhiIdentifier,
} from "../lib/addons/schema-ddl.ts";
import {
  PHIS_ADDON_CREATED_BY_COLUMN,
  PHIS_ADDON_GROUP_COLUMN,
  PHIS_ADDON_OWNER_COLUMN,
  PHIS_ADDON_SITE_COLUMN,
} from "../lib/addons/schema-descriptor.ts";
import { composePhisAddonAssetTableName } from "../lib/addons/schema-name.ts";

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
