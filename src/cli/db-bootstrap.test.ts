import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** Every statement in the order it was sent, which is the half of this that a database cannot verify. */
  statements: [] as { sql: string; params?: unknown[] }[],
  existingRoles: new Set<string>(),
  existingDatabases: new Set<string>(),
  connected: 0,
  ended: 0,
  failOn: null as string | null,
  /** What the administrative connection is, which decides whether a grant is needed at all. */
  superuser: false,
  serverVersion: "170011",
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(public readonly config: { connectionString: string }) {}
    async connect() {
      state.connected += 1;
    }
    async end() {
      state.ended += 1;
    }
    async query(sql: string, params?: unknown[]) {
      state.statements.push({ sql, params });
      if (state.failOn && sql.includes(state.failOn)) {
        throw new Error(`refused: ${state.failOn}`);
      }
      if (sql.includes("rolsuper")) {
        return { rows: [{ superuser: state.superuser, version: state.serverVersion }] };
      }
      if (sql.includes("FROM pg_roles WHERE rolname = $1")) {
        return { rows: [{ exists: state.existingRoles.has(String(params?.[0])) }] };
      }
      if (sql.includes("FROM pg_database WHERE datname = $1")) {
        return { rows: [{ exists: state.existingDatabases.has(String(params?.[0])) }] };
      }
      return { rows: [] };
    }
  },
}));

import { bootstrapPhiDatabase, resolvePhiDatabaseNames } from "./db-bootstrap.mts";

/**
 * The four statements an operator used to run by hand, and the ways they must not go wrong.
 *
 * Two of the guards here are the only thing standing between a flag and a statement: every name this command
 * is given ends up inside DDL, which takes no parameters. The rest is about ownership -- the serving role owns
 * the Core schema, the migration role owns the Add-on schemas, and a bootstrap that collapsed them into one
 * would hand back a configuration that looks right and defeats the split it exists for.
 */

const ADMIN = "postgres://admin:secret@db.invalid:5432/postgres";

function sqlSent() {
  return state.statements.map((entry) => entry.sql);
}

beforeEach(() => {
  state.statements.length = 0;
  state.existingRoles.clear();
  state.existingDatabases.clear();
  state.connected = 0;
  state.ended = 0;
  state.failOn = null;
  state.superuser = false;
  state.serverVersion = "170011";
});

/*
 * Creating a database *for* another role means being able to assume it, and PostgreSQL 16 separated
 * administering a role from assuming it. A `CREATEROLE` connection that has just created the role is refused
 * with `must be able to SET ROLE` -- which is exactly what a managed database hands an operator, there being
 * no superuser to be had. Found by running the command against a non-superuser, not by reading.
 */
describe("being allowed to create a database for another role", () => {
  it("takes the right to assume the serving role, before creating the database", async () => {
    await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    const sent = sqlSent();
    const grant = sent.findIndex((sql) => sql.includes('GRANT "phis_prod_user" TO CURRENT_USER'));
    expect(grant).toBeGreaterThanOrEqual(0);
    expect(sent[grant]).toContain("WITH SET TRUE");
    expect(grant).toBeLessThan(sent.findIndex((sql) => sql.includes("CREATE DATABASE")));
  });

  it("names no option on a server that has none, where membership already carried it", async () => {
    state.serverVersion = "150008";
    await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    const grant = sqlSent().find((sql) => sql.includes("TO CURRENT_USER"));
    expect(grant).toBeDefined();
    expect(grant).not.toContain("WITH SET");
  });

  /** A superuser needs none of it, and should not quietly acquire a membership it never needed. */
  it("grants a superuser nothing", async () => {
    state.superuser = true;
    await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    expect(sqlSent().some((sql) => sql.includes("TO CURRENT_USER"))).toBe(false);
    expect(sqlSent().some((sql) => sql.includes("CREATE DATABASE"))).toBe(true);
  });

  it("asks for nothing where the database is already there to be owned", async () => {
    state.existingDatabases.add("phis_prod");
    await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    expect(sqlSent().some((sql) => sql.includes("TO CURRENT_USER"))).toBe(false);
  });
});

describe("deriving the names of one installation", () => {
  it("names the three after the installation, so two URIs can be told apart by eye", () => {
    expect(resolvePhiDatabaseNames({ name: "prod" })).toEqual({
      databaseName: "phis_prod",
      servingRole: "phis_prod_user",
      migrationRole: "phis_prod_migrator",
    });
  });

  /** The names `docs/INSTALL.md` and `debian/README.Debian` already tell an operator to use. */
  it("falls back to the bare package name where no installation name is given", () => {
    expect(resolvePhiDatabaseNames({})).toEqual({
      databaseName: "phis",
      servingRole: "phis_user",
      migrationRole: "phis_migrator",
    });
  });

  it("folds what a person types into what PostgreSQL takes unquoted", () => {
    expect(resolvePhiDatabaseNames({ name: "  Staging Site!  " }).databaseName).toBe("phis_staging_site");
  });

  it("lets each of the three be named outright", () => {
    expect(resolvePhiDatabaseNames({
      name: "prod",
      database: "phis_main",
      servingRole: "serves",
      migrationRole: "migrates",
    })).toEqual({ databaseName: "phis_main", servingRole: "serves", migrationRole: "migrates" });
  });
});

describe("bootstrapping a database", () => {
  it("creates both roles, the database owned by the serving role, and the migrator's CREATE", async () => {
    const result = await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    const sent = sqlSent();
    expect(sent.some((sql) => sql.includes('CREATE ROLE "phis_prod_user"'))).toBe(true);
    expect(sent.some((sql) => sql.includes('CREATE ROLE "phis_prod_migrator"'))).toBe(true);
    expect(sent.some((sql) =>
      sql.includes('CREATE DATABASE "phis_prod"') && sql.includes('OWNER "phis_prod_user"')
    )).toBe(true);
    // The privilege an Add-on migration needs is on the database, not on anything inside it.
    expect(sent.some((sql) =>
      sql.includes('GRANT CREATE ON DATABASE "phis_prod"') && sql.includes('TO "phis_prod_migrator"')
    )).toBe(true);
    expect(result.existing).toEqual({ database: false, servingRole: false, migrationRole: false });
  });

  /*
   * The database has to exist before a role can be granted anything on it, and the roles before the database
   * can be owned by one. Ordering is the kind of thing that works by accident until somebody reorders it.
   */
  it("sends the statements in an order each one's prerequisites survive", async () => {
    await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });
    const sent = sqlSent();
    const roles = sent.findIndex((sql) => sql.includes('CREATE ROLE "phis_prod_user"'));
    const database = sent.findIndex((sql) => sql.includes("CREATE DATABASE"));
    const grant = sent.findIndex((sql) => sql.includes("GRANT CREATE ON DATABASE"));

    expect(roles).toBeLessThan(database);
    expect(database).toBeLessThan(grant);
  });

  it("hands back two URIs that keep the host and differ in role, password and database", async () => {
    const result = await bootstrapPhiDatabase({
      adminUri: "postgres://admin:secret@db.invalid:5432/postgres?sslmode=require",
      name: "prod",
    });

    for (const uri of [result.uri, result.migrationUri]) {
      const parsed = new URL(uri);
      expect(parsed.host).toBe("db.invalid:5432");
      // A property of reaching this server, which the operator just proved is right.
      expect(parsed.searchParams.get("sslmode")).toBe("require");
      expect(parsed.pathname).toBe("/phis_prod");
      expect(parsed.password).not.toBe("secret");
    }
    expect(new URL(result.uri).username).toBe("phis_prod_user");
    expect(new URL(result.migrationUri).username).toBe("phis_prod_migrator");
    expect(new URL(result.uri).password).not.toBe(new URL(result.migrationUri).password);
  });

  /*
   * The case a host in every other test URI hid, and the reason the restriction exists.
   *
   * A local socket connection is `postgresql:///postgres?host=/var/run/postgresql` and has no host. `URL`
   * refuses both credential setters on such a URL, so the first version of this created the database and the
   * roles correctly and then wrote two connection strings naming no role and no password -- silently. It is
   * refused rather than worked around because the rest of the CLI reads these strings back with `URL`:
   * `readPhiMigrationRoleName` answers `null` for anything it cannot parse, and the grants that role needs
   * would then not happen at the next `schema apply`.
   */
  it("refuses a socket connection, whose connection strings could not be parsed back", async () => {
    await expect(bootstrapPhiDatabase({
      adminUri: "postgresql:///postgres?host=/var/run/postgresql",
      name: "prod",
    })).rejects.toThrow(/must name a host/);
    // Before anything was created, which is the point of checking it where it is checked.
    expect(state.connected).toBe(0);
    expect(state.statements).toHaveLength(0);
  });

  it("says so when the administrative connection is not a URI at all", async () => {
    await expect(bootstrapPhiDatabase({ adminUri: "host=localhost user=postgres" }))
      .rejects.toThrow(/not a usable PostgreSQL connection URI/);
  });

  /** A parsable string carries both, and everything about reaching the server is kept as it arrived. */
  it("keeps the port and the query while replacing role, password and database", async () => {
    const result = await bootstrapPhiDatabase({
      adminUri: "postgres://admin:secret@db.invalid:6543/postgres?sslmode=verify-full",
      name: "prod",
    });
    const parsed = new URL(result.migrationUri);
    expect(parsed.host).toBe("db.invalid:6543");
    expect(parsed.username).toBe("phis_prod_migrator");
    expect(parsed.password).not.toBe("");
    expect(parsed.searchParams.get("sslmode")).toBe("verify-full");
  });

  it("uses a password it was given, for a role whose password is already known elsewhere", async () => {
    const result = await bootstrapPhiDatabase({
      adminUri: ADMIN,
      name: "prod",
      password: "serving-pw",
      migrationPassword: "migration-pw",
    });
    expect(new URL(result.uri).password).toBe("serving-pw");
    expect(new URL(result.migrationUri).password).toBe("migration-pw");
  });

  /*
   * A role that exists cannot have its password read back, so taking one over means setting it. Reported as
   * `existing` because that is what the caller's `--force` guard is about: nothing here should silently
   * change the password a running server is using.
   */
  it("reports what it found rather than made, and does not create the database twice", async () => {
    state.existingRoles.add("phis_prod_user");
    state.existingDatabases.add("phis_prod");

    const result = await bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" });

    expect(result.existing).toEqual({ database: true, servingRole: true, migrationRole: false });
    expect(sqlSent().some((sql) => sql.includes("CREATE DATABASE"))).toBe(false);
    // Still granted: it is the privilege most likely to be missing on an installation bootstrapped before
    // the migration role existed, and re-granting is the only repair available from here.
    expect(sqlSent().some((sql) => sql.includes("GRANT CREATE ON DATABASE"))).toBe(true);
  });

  it("refuses one role doing both jobs, which would defeat the split it is for", async () => {
    await expect(bootstrapPhiDatabase({
      adminUri: ADMIN,
      servingRole: "phis_one",
      migrationRole: "phis_one",
    })).rejects.toThrow(/must differ/);
  });

  /** Every name reaches a statement that takes no parameters, so a name that is not one is refused. */
  it("refuses a name that would have to be trusted inside DDL", async () => {
    await expect(bootstrapPhiDatabase({ adminUri: ADMIN, database: '"; DROP SCHEMA phis; --' }))
      .rejects.toThrow(/not a usable database name/);
  });

  it("refuses a name PostgreSQL would silently shorten", async () => {
    await expect(bootstrapPhiDatabase({ adminUri: ADMIN, database: `d${"x".repeat(63)}` }))
      .rejects.toThrow(/63 bytes/);
  });

  it("says what is missing when no administrative connection was given", async () => {
    await expect(bootstrapPhiDatabase({ adminUri: "   " })).rejects.toThrow(/--admin-uri/);
    expect(state.connected).toBe(0);
  });

  it("closes the connection even where a statement was refused", async () => {
    state.failOn = "CREATE DATABASE";
    await expect(bootstrapPhiDatabase({ adminUri: ADMIN, name: "prod" })).rejects.toThrow(/refused/);
    expect(state.ended).toBe(state.connected);
  });
});
