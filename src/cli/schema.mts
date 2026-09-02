import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";

import { phiServerAddonCoreReferenceTables } from "../lib/addons/schema-ddl.ts";

/**
 * Bringing an existing installation's Core schema up to the release it is running.
 *
 * `001_create_phis.pgsql` is idempotent and has always been, but until now nothing applied it after the
 * first bootstrap. A release that adds a Core table therefore reached a running installation as a missing
 * relation, and the way out was somebody with a database client -- which is how tables end up owned by
 * whoever happened to have one, instead of by the serving role.
 *
 * It runs as the serving role for the same reason bootstrap does: Core's tables are the serving role's,
 * and a table created by anyone else is one it cannot later alter.
 */

const SCHEMA_FILE = ["scripts", "sql", "001_create_phis.pgsql"];

function readSchemaSql(appRoot: string) {
  return readFileSync(path.join(appRoot, ...SCHEMA_FILE), "utf8");
}

/** The tables the script would create, read off its own `CREATE TABLE` lines. */
function declaredTables(sql: string) {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS phis\.([a-z0-9_]+)/gi)].map((match) =>
    match[1]!
  );
}

async function presentTables(client: Client) {
  const { rows } = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'phis'`,
  );
  return new Set(rows.map((row) => row.tablename));
}

/** The extensions the script creates, read from the script rather than kept in a second list here. */
async function missingExtensions(client: Client, sql: string) {
  const declared = [...sql.matchAll(/CREATE EXTENSION IF NOT EXISTS ([a-z_]+)/gi)]
    .map((match) => match[1]!);
  if (declared.length === 0) {
    return [];
  }
  const { rows } = await client.query<{ extname: string }>(
    "SELECT extname FROM pg_extension WHERE extname = ANY($1)",
    [declared],
  );
  const present = new Set(rows.map((row) => row.extname));
  return declared.filter((name) => !present.has(name));
}

export type PhiSchemaApplyResult = {
  declared: number;
  missing: string[];
  created: string[];
  grantedTo: string | null;
  /**
   * Extensions the script asks for that the database does not have.
   *
   * Reported beside the tables because it fails differently: a missing table stops everything at once,
   * while a missing `pg_trgm` costs nothing until an Add-on with a text index is installed, and then it
   * is a failed migration rather than a slow query. Worth saying before that, and worth saying
   * separately -- an installation whose provider forbids the extension has a decision to make, not a
   * repair to run.
   */
  missingExtensions: string[];
};

/**
 * Reports what the script would add, without touching anything.
 *
 * Worth having on its own: on a running installation the interesting question before a deployment is
 * whether this release needs the schema moved at all.
 */
export async function checkPhiCoreSchema(input: {
  appRoot: string;
  uri: string;
}): Promise<PhiSchemaApplyResult> {
  const sql = readSchemaSql(input.appRoot);
  const client = new Client({ connectionString: input.uri });
  await client.connect();
  try {
    const present = await presentTables(client);
    const declared = declaredTables(sql);
    return {
      declared: declared.length,
      missing: declared.filter((table) => !present.has(table)),
      created: [],
      grantedTo: null,
      missingExtensions: await missingExtensions(client, sql),
    };
  } finally {
    await client.end();
  }
}

export async function applyPhiCoreSchema(input: {
  appRoot: string;
  uri: string;
  migrationRole: string | null;
}): Promise<PhiSchemaApplyResult> {
  const sql = readSchemaSql(input.appRoot);
  const client = new Client({ connectionString: input.uri });
  await client.connect();
  try {
    const before = await presentTables(client);
    await client.query(sql);
    const after = await presentTables(client);
    const created = [...after].filter((table) => !before.has(table)).sort();

    let grantedTo: string | null = null;
    if (input.migrationRole) {
      const role = input.migrationRole.trim();
      // From configuration, so quoted rather than interpolated raw, and DDL takes no parameters.
      if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(role)) {
        throw new Error(`"${input.migrationRole}" is not a usable role name.`);
      }
      /*
       * Reaching the schema at all, which every grant below silently assumed.
       *
       * `REFERENCES` on a table is useless to a role that may not enter the schema holding it, and for
       * a long time nobody noticed: the privilege came from however the database was first set up and
       * survived every `CREATE TABLE IF NOT EXISTS`. It does not survive the schema being rebuilt, and
       * a rebuild is exactly what this command is for.
       */
      await client.query(`GRANT USAGE ON SCHEMA phis TO "${role}"`);

      // Re-granted every time: a Core table added by this release may be one an Add-on may reference,
      // and the grant is per table rather than per schema.
      for (const table of phiServerAddonCoreReferenceTables()) {
        await client.query(`GRANT REFERENCES ON ${table} TO "${role}"`);
      }

      /*
       * The catalogue the migration runner keeps, which is its own bookkeeping rather than an Add-on's.
       *
       * Installing an Add-on records what was installed and what it may do; those rows are written by
       * the migration connection, so read-only access to them would stop a migration at its first
       * statement. Named one by one rather than granted across the schema: the migrator's business is
       * Add-ons, and Site content is not it.
       */
      for (const table of [
        "phis.server_addons",
        "phis.server_addon_migrations",
        "phis.server_capabilities",
        "phis.site_server_addons",
        "phis.server_secrets",
      ]) {
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO "${role}"`);
      }
      /*
       * Groups an Add-on brought with it, which uninstalling has to retire.
       *
       * Update rather than delete, and only ever the rows whose `provider_id` names the Add-on -- a
       * group an administrator made is not the migrator's to touch. The privilege is wider than that
       * rule, which is why the rule lives in the statement and is stated there.
       */
      await client.query(`GRANT SELECT, UPDATE ON phis.site_groups TO "${role}"`);
      // Identity columns need their sequence, and a grant on the table does not carry it.
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA phis TO "${role}"`);

      grantedTo = role;
    }

    return {
      declared: declaredTables(sql).length,
      missing: [],
      created,
      grantedTo,
      // After running the script, so this reports what the database refused rather than what it lacked.
      missingExtensions: await missingExtensions(client, sql),
    };
  } finally {
    await client.end();
  }
}

/** The role name a migration URI carries, without exposing the rest of it. */
export function readPhiMigrationRoleName(migrationUri: string | undefined) {
  if (!migrationUri?.trim()) {
    return null;
  }
  try {
    const username = new URL(migrationUri.trim()).username;
    return username ? decodeURIComponent(username) : null;
  } catch {
    return null;
  }
}

export type PhiSchemaDropPlan = {
  addonSchemas: { addonId: string; schemaName: string }[];
  coreSchema: string;
  dropped: boolean;
};

/**
 * Removing everything this installation's schema holds, Add-on tables included.
 *
 * `DROP SCHEMA phis CASCADE` on its own is not a reset: an Add-on's tables live in a schema of their
 * own, which hangs off nothing and therefore survives. What is left behind then has no catalogue row
 * describing it -- a schema nobody claims, which the next install neither finds nor can replace.
 *
 * Two connections, because ownership is split and `DROP SCHEMA` is an owner's privilege: the migration
 * role owns what it created for Add-ons, the serving role owns `phis`. Add-on schemas go first, since
 * their foreign keys point into Core and not the other way around.
 */
export async function dropPhiCoreSchema(input: {
  uri: string;
  migrationUri: string;
  confirmed: boolean;
}): Promise<PhiSchemaDropPlan> {
  const serving = new Client({ connectionString: input.uri });
  await serving.connect();

  let addonSchemas: { addonId: string; schemaName: string }[] = [];
  try {
    const present = await serving.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'phis') AS exists`,
    );
    if (present.rows[0]?.exists) {
      const { rows } = await serving.query<{ addon_id: string; schema_name: string }>(
        `SELECT addon_id, schema_name
         FROM phis.server_addons
         WHERE schema_name IS NOT NULL
         ORDER BY addon_id`,
      );
      addonSchemas = rows.map((row) => ({ addonId: row.addon_id, schemaName: row.schema_name }));
    }

    if (!input.confirmed) {
      return { addonSchemas, coreSchema: "phis", dropped: false };
    }

    const migration = new Client({ connectionString: input.migrationUri });
    await migration.connect();
    try {
      for (const entry of addonSchemas) {
        // Derived by Core and stored under a unique index, never given by an Add-on -- but this is DDL
        // with no parameters, so it is checked here rather than trusted.
        if (!/^[a-z_][a-z0-9_]*$/u.test(entry.schemaName)) {
          throw new Error(`"${entry.schemaName}" is not a usable schema name.`);
        }
        await migration.query(`DROP SCHEMA IF EXISTS "${entry.schemaName}" CASCADE`);
      }
    } finally {
      await migration.end();
    }

    await serving.query("DROP SCHEMA IF EXISTS phis CASCADE");
    return { addonSchemas, coreSchema: "phis", dropped: true };
  } finally {
    await serving.end();
  }
}
