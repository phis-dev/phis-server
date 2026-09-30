import { randomBytes } from "node:crypto";

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
 * The administrative connection is asked for and never assumed. A bootstrap that reached for local peer
 * authentication would work on exactly one kind of host -- the one where PostgreSQL runs beside the server
 * and the operator is root -- and would quietly be the wrong tool everywhere else, which is most places.
 */

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
  adminUri: string;
  name?: string | null;
  database?: string | null;
  servingRole?: string | null;
  migrationRole?: string | null;
  /** Given only where an operator has to match a password that already exists elsewhere. */
  password?: string | null;
  migrationPassword?: string | null;
}): Promise<PhiDatabaseBootstrapResult> {
  if (!input.adminUri.trim()) {
    throw new Error("Missing --admin-uri, the connection this bootstrap runs as.");
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
  const adminHost = safeUriHost(input.adminUri);
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

  const client = new Client({ connectionString: input.adminUri });
  await client.connect();
  try {
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
      uri: buildDatabaseUri(input.adminUri, names.databaseName, names.servingRole, servingPassword),
      migrationUri: buildDatabaseUri(
        input.adminUri,
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
async function allowCurrentUserToAssume(client: Client, role: string) {
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

async function roleExists(client: Client, role: string) {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role],
  );
  return rows[0]?.exists === true;
}

async function databaseExists(client: Client, databaseName: string) {
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
async function ensureRole(client: Client, role: string, password: string) {
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
