import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

import { Client } from "pg";

import { quotePhiIdentifier } from "../lib/addons/schema-ddl.ts";

/**
 * Creating the database an installation is applied to, and the two roles that own parts of it.
 *
 * Everything else in this CLI assumes a database that already exists. `schema apply` creates the Core
 * schema and grants the migration role what Add-on migrations need, but it connects as the serving role and
 * cannot bring either role into being -- so until now the first four statements of an installation were run
 * by hand from `docs/INSTALL.md`, and the Debian package said outright that it creates neither. That is the
 * one step where a typo costs an afternoon: a database owned by the wrong role, or a migration role that was
 * never made, surfaces much later as a migration that cannot run.
 *
 * Two roles rather than one, because ownership is split and the split is the point: the serving role owns
 * the Core schema `phis`, the migration role owns the schemas of server Add-ons, and neither can drop what
 * the other made. `phis-host` does a narrower version of this for the Debian path and produces only the
 * serving role, which is why an installation bootstrapped from there has no migration role and finds out at
 * its first Add-on.
 *
 * The administrative connection is asked for and never assumed: either `--admin-uri`, or `--local`, which
 * says outright that PostgreSQL runs on this host and its `postgres` account administers it over the local
 * socket (peer authentication, the Debian default). `--local` runs the statements through `psql` as
 * `postgres` -- `runuser` when the CLI runs as root -- so no temporary administrative role with a password
 * has to be created and dropped again. The connection strings it writes name `127.0.0.1` and the cluster's
 * port, which the serving and migration roles reach with their passwords.
 */

/** What the bootstrap runs its statements through: a `pg` client, or `psql` as `postgres` for `--local`. */
type PhiAdminConnection = {
  query<T>(sql: string, params?: readonly string[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

/** `CREATE DATABASE` cannot run inside a transaction, so nothing here pretends to be atomic. */
export type PhiDatabaseBootstrapResult = {
  databaseName: string;
  servingRole: string;
  migrationRole: string;
  /** What was found rather than made, so a second run can say it changed nothing. */
  existing: { database: boolean; servingRole: boolean; migrationRole: boolean };
  /**
   * The connection strings the runtime configuration needs, passwords included.
   *
   * Returned rather than printed: these are secrets, and the caller writes them into
   * `config/phis-runtime.json`. A password is only ever known here -- an existing role's is not readable,
   * which is why taking one over means setting it.
   */
  uri: string;
  migrationUri: string;
};

/**
 * A name PostgreSQL will take unquoted, and that a human reading the two URIs can still tell apart.
 *
 * Derived rather than free-form so that the three names of one installation stay recognisably related, the
 * way `docs/INSTALL.md` and `debian/README.Debian` already spell them: `phis_prod`, `phis_prod_user`,
 * `phis_prod_migrator`.
 */
export function resolvePhiDatabaseNames(input: {
  name?: string | null;
  database?: string | null;
  servingRole?: string | null;
  migrationRole?: string | null;
}) {
  const suffix = normalizeIdentifier(input.name ?? "");
  const base = suffix ? `phis_${suffix}` : "phis";
  /*
   * Only the derived name is folded. A name given outright is taken as it was typed and then held to the
   * rule below, because it is an answer to a different question: `--name` asks what to call this
   * installation, and folding "Staging Site" into `phis_staging_site` is the service being offered, while
   * `--database` names something that may already exist -- and quietly bootstrapping `my_db` for somebody
   * who asked for `my db` hands back a configuration pointing at neither.
   */
  return {
    databaseName: (input.database ?? "").trim() || base,
    servingRole: (input.servingRole ?? "").trim() || `${base}_user`,
    migrationRole: (input.migrationRole ?? "").trim() || `${base}_migrator`,
  };
}

function normalizeIdentifier(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
}

/**
 * Checked rather than trusted, because DDL takes no parameters.
 *
 * The same rule `schema apply` holds the migration role to, and for the same reason: every name here ends
 * up inside a statement, and one of them arrives from a flag.
 */
function assertUsableIdentifier(kind: string, value: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error(`"${value}" is not a usable ${kind} name.`);
  }
  if (value.length > 63) {
    // PostgreSQL truncates silently at NAMEDATALEN, which would hand back a URI naming something else.
    throw new Error(`The ${kind} name "${value}" is longer than the 63 bytes PostgreSQL keeps.`);
  }
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Hex rather than base64: it travels through a URI, a shell and a JSON file without being escaped once. */
function generatePassword() {
  return randomBytes(24).toString("hex");
}

export async function bootstrapPhiDatabase(input: {
  /** The administrative connection; empty with `local`. */
  adminUri: string;
  /** Administer the local cluster as `postgres` over its socket instead of `adminUri`. */
  local?: boolean;
  name?: string | null;
  database?: string | null;
  servingRole?: string | null;
  migrationRole?: string | null;
  /** Given only where an operator has to match a password that already exists elsewhere. */
  password?: string | null;
  migrationPassword?: string | null;
}): Promise<PhiDatabaseBootstrapResult> {
  if (input.local && input.adminUri.trim()) {
    throw new Error("Give either --admin-uri or --local, not both.");
  }
  if (!input.local && !input.adminUri.trim()) {
    throw new Error("Missing --admin-uri, the connection this bootstrap runs as (or --local on the database host).");
  }
  /*
   * Refused here, before anything is created, because the alternative is worse than the restriction.
   *
   * A local socket connection is written `postgresql:///postgres?host=/var/run/postgresql` and has no host
   * in it. `libpq` would accept credentials beside an empty host, but the URL form does not, and the rest of
   * this CLI parses these strings with `URL` -- `readPhiMigrationRoleName` reads the migration role out of
   * `database.migrationUri` that way, and answers `null` on anything it cannot parse. The grants that role
   * needs would then simply not happen, silently, at the next `schema apply`. So a bootstrap that cannot
   * produce a parsable connection string says so instead of creating a database and writing one that will
   * quietly do the wrong thing later.
   *
   * It costs little: the server connects with a password in any case, since it does not run as either of
   * these roles, so peer authentication over a socket was never going to serve it.
   */
  const adminHost = input.local ? "local" : safeUriHost(input.adminUri);
  if (!adminHost) {
    throw new Error(
      "--admin-uri must name a host, as postgres://user@host:5432/postgres. A socket connection carries no "
        + "host, and the connection strings written from it have to be ones this CLI can parse back.",
    );
  }

  const names = resolvePhiDatabaseNames(input);
  assertUsableIdentifier("database", names.databaseName);
  assertUsableIdentifier("role", names.servingRole);
  assertUsableIdentifier("role", names.migrationRole);
  if (names.servingRole === names.migrationRole) {
    throw new Error(
      "The serving and migration roles must differ: the whole point of the second is that it cannot "
        + "drop what the first owns.",
    );
  }

  const servingPassword = input.password?.trim() || generatePassword();
  const migrationPassword = input.migrationPassword?.trim() || generatePassword();

  const client: PhiAdminConnection = input.local ? createLocalPsqlConnection() : await connectAdminClient(input.adminUri);
  try {
    /*
     * What the written connection strings are built on: the given one, or for the local cluster loopback TCP
     * on the cluster's own port, where the two roles authenticate with the passwords set here.
     */
    const baseUri = input.local ? `postgresql://127.0.0.1:${await readClusterPort(client)}/postgres` : input.adminUri;
    const existing = {
      database: await databaseExists(client, names.databaseName),
      servingRole: await roleExists(client, names.servingRole),
      migrationRole: await roleExists(client, names.migrationRole),
    };

    await ensureRole(client, names.servingRole, servingPassword);
    await ensureRole(client, names.migrationRole, migrationPassword);

    if (!existing.database) {
      await allowCurrentUserToAssume(client, names.servingRole);
      await client.query(
        `CREATE DATABASE ${quotePhiIdentifier(names.databaseName)} `
          + `OWNER ${quotePhiIdentifier(names.servingRole)}`,
      );
    }

    /*
     * Granted every run, including when the database was already there.
     *
     * Add-on migrations create a schema of their own, which is a privilege on the database rather than on
     * anything inside it -- and it is the grant most likely to be missing on an installation bootstrapped
     * before the migration role existed. Re-granting costs nothing and is the only repair available from
     * here.
     */
    await client.query(
      `GRANT CREATE ON DATABASE ${quotePhiIdentifier(names.databaseName)} `
        + `TO ${quotePhiIdentifier(names.migrationRole)}`,
    );

    return {
      ...names,
      existing,
      uri: buildDatabaseUri(baseUri, names.databaseName, names.servingRole, servingPassword),
      migrationUri: buildDatabaseUri(
        baseUri,
        names.databaseName,
        names.migrationRole,
        migrationPassword,
      ),
    };
  } finally {
    await client.end();
  }
}

/**
 * Making the administrative connection able to create a database *for* the serving role.
 *
 * `CREATE DATABASE ... OWNER x` requires being able to `SET ROLE x`, and PostgreSQL 16 separated
 * administering a role from assuming it: a `CREATEROLE` connection that has just created the role holds
 * `ADMIN OPTION` over it and nothing more, so the statement is refused with `must be able to SET ROLE`. That
 * is not an exotic configuration -- it is what a managed database hands an operator, where there is no
 * superuser to be had.
 *
 * A superuser needs none of this and is left alone, so that the ordinary local bootstrap does not quietly
 * acquire a membership it never needed. Where the grant is made it stays: the connection that administers
 * these roles is the one that will be used to administer them again.
 */
async function allowCurrentUserToAssume(client: PhiAdminConnection, role: string) {
  const { rows } = await client.query<{ superuser: boolean; version: string }>(
    `SELECT rolsuper AS superuser, current_setting('server_version_num') AS version
       FROM pg_roles WHERE rolname = CURRENT_USER`,
  );
  if (rows[0]?.superuser) {
    return;
  }
  // Before 16 the membership carried the right to assume the role, and the option did not exist to be named.
  const withSet = Number(rows[0]?.version ?? 0) >= 160000 ? " WITH SET TRUE" : "";
  await client.query(`GRANT ${quotePhiIdentifier(role)} TO CURRENT_USER${withSet}`);
}

async function roleExists(client: PhiAdminConnection, role: string) {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role],
  );
  return rows[0]?.exists === true;
}

async function databaseExists(client: PhiAdminConnection, databaseName: string) {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [databaseName],
  );
  return rows[0]?.exists === true;
}

/**
 * Created or given the password this run generated, in one statement that does either.
 *
 * Taking over a role that exists is not a courtesy -- an existing role's password cannot be read back, so
 * the URI this command returns would otherwise name a role with a password nobody has. `ALTER` is therefore
 * the deliberate half of the behaviour, and it is why `--force` guards the whole command at the caller: a
 * bootstrap run twice by accident must not change the password a running server is using.
 */
async function ensureRole(client: PhiAdminConnection, role: string, password: string) {
  await client.query(
    `DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN
    ALTER ROLE ${quotePhiIdentifier(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)};
  ELSE
    CREATE ROLE ${quotePhiIdentifier(role)} WITH LOGIN PASSWORD ${quoteLiteral(password)};
  END IF;
END $$;`,
  );
}

/**
 * The administrative connection with a different role, password and database on it.
 *
 * Everything else about it is kept -- host, port, and whatever query parameters carry the TLS mode or name a
 * socket directory -- because those are properties of reaching this server, and the operator just proved they
 * are right.
 *
 * Assembled rather than assigned through `URL`, whose credential setters do nothing on a URL without a host.
 * The host is known to be there -- a bootstrap refuses an administrative connection lacking one -- so this is
 * about being explicit rather than about working around the setters.
 */
function buildDatabaseUri(adminUri: string, databaseName: string, role: string, password: string) {
  const url = new URL(adminUri.trim());
  const credentials = `${encodeURIComponent(role)}:${encodeURIComponent(password)}`;
  return `${url.protocol}//${credentials}@${url.host}/${databaseName}${url.search}`;
}

/** The host of something that may not be a URL at all: a bad `--admin-uri` is an error, not a crash. */
function safeUriHost(value: string) {
  try {
    return new URL(value.trim()).host;
  } catch {
    throw new Error(`"${value.trim()}" is not a usable PostgreSQL connection URI.`);
  }
}

async function connectAdminClient(adminUri: string): Promise<PhiAdminConnection> {
  const client = new Client({ connectionString: adminUri });
  await client.connect();
  return {
    query: async <T,>(sql: string, params?: readonly string[]) => {
      const result = await client.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as T[] };
    },
    end: () => client.end(),
  };
}

async function readClusterPort(client: PhiAdminConnection) {
  const { rows } = await client.query<{ port: string }>("SELECT current_setting('port') AS port");
  const port = Number(rows[0]?.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Could not read the local cluster's port.");
  }
  return port;
}

/**
 * `psql` as `postgres` over the local socket, one statement per call.
 *
 * Parameters are written into the statement as quoted literals: every value here is a name this module
 * checked or a password it generated, and `psql -c` takes no bind parameters. Rows come back as CSV with a
 * header; `t` and `f` are read as booleans, the only other type these queries return being text.
 */
function createLocalPsqlConnection(): PhiAdminConnection {
  const asRoot = process.getuid?.() === 0;
  const isPostgres = !asRoot && (process.env.USER === "postgres" || process.env.LOGNAME === "postgres");
  if (!asRoot && !isPostgres) {
    throw new Error("--local runs psql as the postgres account: run it as root or as postgres.");
  }
  return {
    query: async <T,>(sql: string, params?: readonly string[]) => {
      const statement = (params ?? []).reduceRight(
        (text, value, index) => text.replaceAll(`$${index + 1}`, quoteLiteral(value)),
        sql,
      );
      const psql = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv", "-d", "postgres", "-c", statement];
      const result = asRoot
        ? spawnSync("runuser", ["-u", "postgres", "--", ...psql], { encoding: "utf8", cwd: "/" })
        : spawnSync(psql[0]!, psql.slice(1), { encoding: "utf8", cwd: "/" });
      if (result.error) {
        throw new Error(`psql could not be started: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`psql as postgres failed: ${(result.stderr || result.stdout).trim()}`);
      }
      return { rows: parsePsqlCsv(result.stdout) as T[] };
    },
    end: async () => undefined,
  };
}

/** psql's `--csv` output: a header line, then one line per row; quoted fields may hold commas. */
export function parsePsqlCsv(output: string): Record<string, string | boolean>[] {
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const split = (line: string) => {
    const fields: string[] = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]!;
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else current += char;
      } else if (char === '"') quoted = true;
      else if (char === ",") { fields.push(current); current = ""; }
      else current += char;
    }
    fields.push(current);
    return fields;
  };
  const header = split(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = split(line);
    return Object.fromEntries(header.map((name, index) => {
      const value = values[index] ?? "";
      return [name, value === "t" ? true : value === "f" ? false : value];
    }));
  });
}

/**
 * The names a stage's two connection strings point at: the database and both roles.
 *
 * Read from `database.uri` and `database.migrationUri` so that `db drop` removes what this stage uses and
 * not what its `--name` would have derived -- a bootstrap with `--database` or `--role` given outright
 * names something no derivation finds. `null` where a string is missing or cannot be parsed.
 */
export function readPhiDatabaseNamesFromUris(uri: string | null | undefined, migrationUri: string | null | undefined) {
  const read = (value: string | null | undefined) => {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value.trim());
      return {
        database: decodeURIComponent(url.pathname.replace(/^\/+/u, "")) || null,
        role: decodeURIComponent(url.username) || null,
      };
    } catch {
      return null;
    }
  };
  const serving = read(uri);
  const migration = read(migrationUri);
  return {
    databaseName: serving?.database ?? migration?.database ?? null,
    servingRole: serving?.role ?? null,
    migrationRole: migration?.role ?? null,
  };
}

export type PhiDatabaseDropResult = {
  databaseName: string;
  roles: string[];
  /** What was there to drop; on a dry run, what would be. */
  found: { database: boolean; roles: string[] };
  dropped: boolean;
};

/**
 * The counterpart of `bootstrapPhiDatabase`: the database and the roles that owned it, gone.
 *
 * `DROP DATABASE ... WITH (FORCE)` ends the connections still open on it, which is why the stage's service
 * is stopped first by `stage remove` and why a running server here only loses its pool. The schemas inside,
 * Core's and every Add-on's, go with the database, so no `schema drop` has to come first. The roles are
 * dropped after it; one that still owns something in another database is refused by PostgreSQL, which is
 * the right answer for a role somebody else also uses.
 *
 * Without `confirmed` it only reads and reports what it would drop.
 */
export async function dropPhiDatabase(input: {
  adminUri: string;
  local?: boolean;
  databaseName: string;
  roles: readonly string[];
  confirmed: boolean;
}): Promise<PhiDatabaseDropResult> {
  if (input.local && input.adminUri.trim()) {
    throw new Error("Give either --admin-uri or --local, not both.");
  }
  if (!input.local && !input.adminUri.trim()) {
    throw new Error("Missing --admin-uri, the connection this drop runs as (or --local on the database host).");
  }
  assertUsableIdentifier("database", input.databaseName);
  const roles = [...new Set(input.roles)];
  for (const role of roles) assertUsableIdentifier("role", role);

  const client: PhiAdminConnection = input.local ? createLocalPsqlConnection() : await connectAdminClient(input.adminUri);
  try {
    const { rows } = await client.query<{ name: string }>("SELECT CURRENT_USER AS name");
    const admin = rows[0]?.name;
    if (admin && roles.includes(admin)) {
      throw new Error(`The administrative connection runs as ${admin}, one of the roles to drop; use another.`);
    }
    const found = {
      database: await databaseExists(client, input.databaseName),
      roles: (await Promise.all(roles.map(async (role) => (await roleExists(client, role)) ? role : null)))
        .filter((role): role is string => role !== null),
    };
    if (!input.confirmed) {
      return { databaseName: input.databaseName, roles, found, dropped: false };
    }
    if (found.database) {
      await client.query(`DROP DATABASE ${quotePhiIdentifier(input.databaseName)} WITH (FORCE)`);
    }
    for (const role of found.roles) {
      await client.query(`DROP ROLE ${quotePhiIdentifier(role)}`);
    }
    return { databaseName: input.databaseName, roles, found, dropped: true };
  } finally {
    await client.end();
  }
}
