import "server-only";

import { readFileSync } from "node:fs";

import { Client } from "pg";

import { resolvePhiAppPath } from "@/lib/app-paths";
import { phisAddonCoreReferenceTables } from "@/lib/addons/schema-ddl";
import { insertPhiSite, type PhiSiteInsertInput } from "@/db/cli-sites.mts";

export async function verifyPhiDatabaseWriteAccess(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE phis_bootstrap_db_check (id integer) ON COMMIT DROP",
    );
    await client.query("INSERT INTO phis_bootstrap_db_check (id) VALUES (1)");
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

export async function applyPhiBootstrapSchema(connectionString: string) {
  const sqlPath = resolvePhiAppPath("scripts", "sql", "001_create_phis.pgsql");
  const sql = readFileSync(sqlPath, "utf-8");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/**
 * Lets the migration role point an Add-on's tables at the Core tables the contract allows.
 *
 * A foreign key needs `REFERENCES` on its target, which is a privilege of its own and not implied by
 * `SELECT`: the key constrains the target's owner, who can no longer delete those rows freely. Core's
 * tables belong to the serving role -- the DDL above runs as it -- while Add-on schemas are built by
 * the migration role, so without this the very first Add-on that references a Site fails at migration
 * time with a permission error nobody would connect to a missing grant.
 *
 * The list comes from the contract rather than from a second copy here, so a newly referenceable Core
 * table cannot arrive without its grant. Repeating the call is harmless and is how an installation
 * that predates a new reference catches up.
 */
export async function grantPhiAddonCoreReferences(
  connectionString: string,
  migrationRole: string,
) {
  const role = migrationRole.trim();
  // The role name arrives from configuration, so it is quoted rather than interpolated raw, and a
  // parameter is not available in DDL.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(role)) {
    throw new Error(`"${migrationRole}" is not a usable role name.`);
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const table of phisAddonCoreReferenceTables()) {
      await client.query(`GRANT REFERENCES ON ${table} TO "${role}"`);
    }
  } finally {
    await client.end();
  }
}

export async function createPhiBootstrapSites(
  connectionString: string,
  sites: PhiSiteInsertInput[],
) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const site of sites) {
      await insertPhiSite(client, site);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    await client.end();
  }
}

/*
 * What the setup screens read, beside what they write above.
 *
 * Same reason for the connection of their own: during setup the operator is typing a connection string
 * nothing has accepted yet, the schema may be absent, and the pool the application would hand out is
 * built from configuration still being written. The queries sit here rather than in the panels because
 * the boundary in AGENTS.md has no setup exception -- a component asks a typed function.
 */

export type PhiBootstrapSchemaStatus = {
  schemaExists: boolean;
  tableCount: number;
};

export type PhiBootstrapSite = {
  key: string;
  name: string;
  hostname: string;
  publicBaseUrl: string;
};

/** A caller that has no connection string yet gets no answer, not an error. */
function readableConnectionString(connectionString: string | undefined) {
  return connectionString?.trim() ? connectionString : null;
}

async function withPhiBootstrapClient<T>(
  connectionString: string,
  read: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await read(client);
  } finally {
    await client.end();
  }
}

/**
 * Whether the `phis` schema is there, and how much of it.
 *
 * The table count is what tells a half-applied schema from a complete one, which is the state the
 * setup step after this one has to decide about.
 */
export async function readPhiBootstrapSchemaStatus(
  connectionString: string | undefined,
): Promise<PhiBootstrapSchemaStatus | null> {
  const uri = readableConnectionString(connectionString);
  if (!uri) return null;

  return withPhiBootstrapClient(uri, async (client) => {
    const schemaResult = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'phis') AS exists",
    );
    if (schemaResult.rows[0]?.exists !== true) {
      return { schemaExists: false, tableCount: 0 };
    }

    const tableResult = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'phis'",
    );
    return {
      schemaExists: true,
      tableCount: Number.parseInt(tableResult.rows[0]?.count ?? "0", 10) || 0,
    };
  });
}

/**
 * The Sites the setup screens list, in creation order.
 *
 * One shape for both panels that ask: the later one shows a hostname and the last one does not, and a
 * second query differing by one column would be two things to keep in step for nothing.
 */
export async function readPhiBootstrapSites(
  connectionString: string | undefined,
): Promise<PhiBootstrapSite[]> {
  const uri = readableConnectionString(connectionString);
  if (!uri) return [];

  return withPhiBootstrapClient(uri, async (client) => {
    const { rows } = await client.query<{
      key: string;
      name: string;
      hostname: string;
      public_base_url: string;
    }>(
      `SELECT key, name, hostname, public_base_url
       FROM phis.sites
       ORDER BY id`,
    );
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      hostname: row.hostname,
      publicBaseUrl: row.public_base_url,
    }));
  });
}
