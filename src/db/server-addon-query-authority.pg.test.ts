import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhisAddonSchema, dropPhisAddonSchema } from "./server-addon-schema.mts";
import { getPhisConfigSync } from "@/lib/config";
import { buildPhisAddonCapabilities } from "@/lib/addons/capabilities";
import { validatePhisAddonManifest } from "@/lib/addons/manifest";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhisAddonManifestV1 } from "@/lib/addons/contract";

/**
 * A query declaring the Add-on's own authority, run by callers who have none of their own.
 *
 * The case between the caller's authority and a job's: a guest, or a customer holding no role, takes a
 * seat from a capacity the Add-on keeps. Nobody owns the count and no role names it, so on the caller's
 * authority the write is refused to both -- and the declaration is what lets them make it, in exactly
 * this query and nowhere else.
 *
 * What is shown beside that is what does not move. Ten takers at once against five seats get exactly
 * five, because the guard and the write are one statement. The other queries of the same request, in
 * the same transaction, keep the caller's authority. On an owned table the query reaches any row of the
 * Site, as a job does, and still no row of another Site. And a request nobody authenticated still writes
 * nothing.
 */

const SCHEMA = "phis_addon_pgtest_authority";
const ADDON = "@pgtest/authority";
const CANCELLED = 1;

const schema = {
  descriptorVersion: 1 as const,
  version: 1,
  tables: [
    {
      // Nobody owns a capacity: it is the Add-on's.
      name: "offer",
      siteScoped: true,
      columns: [
        { name: "id", type: "identity" as const },
        { name: "capacity", type: "integer" as const },
        { name: "taken", type: "bigInteger" as const, default: { kind: "literal" as const, value: 0 } },
        { name: "label", type: "string" as const, maxLength: 64 },
      ],
      primaryKey: ["id"],
      constraints: [
        { kind: "range" as const, name: "offer_capacity_range", column: "capacity", min: 0 },
      ],
    },
    {
      // Owned: a booking is the booker's, and the ladder says who else may touch it.
      name: "booking",
      siteScoped: true,
      ownerScoped: true,
      columns: [
        { name: "id", type: "identity" as const },
        { name: "seats", type: "integer" as const },
        { name: "flags", type: "integer" as const, default: { kind: "literal" as const, value: 0 } },
      ],
      primaryKey: ["id"],
    },
  ],
};

const seatGuard = {
  set: [
    { column: "capacity", add: { kind: "parameter", name: "taken" } },
    { column: "taken", add: { kind: "parameter", name: "quantity" } },
  ],
  idParameter: "id",
  where: {
    kind: "compare", column: "capacity", operator: ">=", value: { kind: "parameter", name: "quantity" },
  },
};

const cancelOnce = {
  set: [{ column: "flags", add: { kind: "literal", value: CANCELLED } }],
  idParameter: "id",
  where: { kind: "flags", column: "flags", mask: { kind: "literal", value: CANCELLED }, match: "none" },
};

const seatParameters = [
  { name: "id", type: "bigInteger" },
  { name: "quantity", type: "integer" },
  { name: "taken", type: "integer" },
];

const manifest = {
  manifestVersion: 1,
  addonId: ADDON,
  packageName: ADDON,
  packageVersion: "0.1.0",
  serverAbi: "^1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: ["@phis/server/data:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  roles: [{ name: "clerk", grantableBy: { siteAccess: "site-admin" } }],
  schema,
  queries: {
    parameters: {
      open_offer: [{ name: "capacity", type: "integer" }, { name: "label", type: "text" }],
      claim_seat: seatParameters,
      claim_seat_as_caller: seatParameters,
      relabel_offer: [{ name: "id", type: "bigInteger" }, { name: "label", type: "text" }],
      book: [{ name: "seats", type: "integer" }],
      book_as_addon: [{ name: "seats", type: "integer" }],
      cancel_booking: [{ name: "id", type: "bigInteger" }],
      cancel_any_booking: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      {
        kind: "insert",
        name: "open_offer",
        table: "offer",
        requiresRole: "clerk",
        values: [
          { column: "capacity", value: { kind: "parameter", name: "capacity" } },
          { column: "label", value: { kind: "parameter", name: "label" } },
        ],
      },
      // The point of it: a seat taken on the Add-on's authority, guarded so the last one goes once.
      { kind: "update", name: "claim_seat", table: "offer", authority: "addon", ...seatGuard },
      // The same statement on the caller's authority, which on a table nobody owns must name a role.
      { kind: "update", name: "claim_seat_as_caller", table: "offer", requiresRole: "clerk", ...seatGuard },
      {
        kind: "update",
        name: "relabel_offer",
        table: "offer",
        requiresRole: "clerk",
        set: [{ column: "label", value: { kind: "parameter", name: "label" } }],
        idParameter: "id",
      },
      {
        kind: "insert",
        name: "book",
        table: "booking",
        values: [{ column: "seats", value: { kind: "parameter", name: "seats" } }],
      },
      {
        kind: "insert",
        name: "book_as_addon",
        table: "booking",
        authority: "addon",
        values: [{ column: "seats", value: { kind: "parameter", name: "seats" } }],
      },
      { kind: "update", name: "cancel_booking", table: "booking", ...cancelOnce },
      { kind: "update", name: "cancel_any_booking", table: "booking", authority: "addon", ...cancelOnce },
    ],
  },
  migrationVersion: 1,
} as unknown as PhisAddonManifestV1;

let migrationPool: Pool;

describe("a query that runs with the Add-on's own authority", () => {
  let site: PhiTestSite;
  let elsewhere: PhiTestSite;
  /** A Site user who holds none of the Add-on's roles: the customer. */
  let customer: number;
  let stranger: number;
  let visitor: number;

  /** A guest on a public route: an internal caller with no user behind it, identified, not anonymous. */
  function asGuest(on: PhiTestSite = site) {
    return buildPhisAddonCapabilities({
      manifest, manifestDigest: "pgtest-authority", siteId: on.id, siteKey: on.key, actorUserId: null,
    }).data!;
  }

  function asUser(actorUserId: number, on: PhiTestSite = site) {
    return buildPhisAddonCapabilities({
      manifest, manifestDigest: "pgtest-authority", siteId: on.id, siteKey: on.key, actorUserId,
    }).data!;
  }

  /** A hook nothing verified. */
  function asNobody() {
    return buildPhisAddonCapabilities({
      manifest, manifestDigest: "pgtest-authority", siteId: site.id, siteKey: site.key, actorUserId: null,
      unauthenticated: true,
    }).data!;
  }

  /** The Add-on in a job, which is how the offers are put there. */
  function asJob(on: PhiTestSite = site) {
    return buildPhisAddonCapabilities({
      manifest, manifestDigest: "pgtest-authority", siteId: on.id, siteKey: on.key, actorUserId: null,
      systemAuthority: true,
    }).data!;
  }

  async function openOffer(capacity: number) {
    const row = await asJob().insert("open_offer", { capacity, label: "Workshop" });
    return String(row!.id);
  }

  async function offer(id: string) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ capacity: number; taken: string; label: string }>(
      `SELECT capacity, taken, label FROM ${SCHEMA}.offer WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  async function booking(id: unknown) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ flags: number; owner_user_id: number | null }>(
      `SELECT flags, owner_user_id FROM ${SCHEMA}.booking WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  const one = { quantity: 1, taken: -1 };

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-authority");
    elsewhere = await createPhiTestSite("addon-authority-other");
    customer = await createPhiTestUser(site);
    stranger = await createPhiTestUser(site);
    visitor = await createPhiTestUser(elsewhere);

    const config = getPhisConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhisAddonSchema(client, SCHEMA);
      await applyPhisAddonSchema(client, { schemaName: SCHEMA, descriptor: schema }, servingRole);
    } finally {
      client.release();
    }
    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhisAddonSchema(client, SCHEMA);
      } finally {
        client.release();
      }
      await migrationPool.end();
    }
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("is a manifest Core admits, and would not admit with neither the authority nor a role", () => {
    expect(validatePhisAddonManifest(manifest).issues).toEqual([]);
    const stripped = {
      ...manifest,
      queries: {
        ...manifest.queries!,
        queries: manifest.queries!.queries.map((query) => {
          if (query.name !== "claim_seat") {
            return query;
          }
          const { authority: _authority, ...rest } = query;
          return rest;
        }),
      },
    };
    expect(validatePhisAddonManifest(stripped).issues.join("\n"))
      .toMatch(/changes rows of "offer".*must state requiresRole/);
  });

  it("lets a guest take a seat while there is one, and answers null when there is not", async () => {
    const id = await openOffer(2);
    expect(await asGuest().update("claim_seat", { id, ...one })).toMatchObject({ capacity: 1, taken: "1" });
    expect(await asGuest().update("claim_seat", { id, quantity: 2, taken: -2 })).toBeNull();
    expect(await offer(id)).toMatchObject({ capacity: 1, taken: "1" });
  });

  it("lets a customer holding no role take one the same way", async () => {
    const id = await openOffer(1);
    expect(await asUser(customer).update("claim_seat", { id, ...one })).toMatchObject({ capacity: 0 });
    expect(await asUser(customer).update("claim_seat", { id, ...one })).toBeNull();
  });

  it("gives exactly the seats there are to ten takers at once", async () => {
    const id = await openOffer(5);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? asGuest() : asUser(customer)).update("claim_seat", { id, ...one })
      ),
    );
    expect(answers.filter((answer) => answer !== null)).toHaveLength(5);
    expect(await offer(id)).toMatchObject({ capacity: 0, taken: "5" });
  });

  it("refuses the same statement on the caller's authority to both, and writes nothing", async () => {
    const id = await openOffer(3);
    await expect(asGuest().update("claim_seat_as_caller", { id, ...one }))
      .rejects.toThrow(/requires the role "clerk"/);
    await expect(asUser(customer).update("claim_seat_as_caller", { id, ...one }))
      .rejects.toThrow(/requires the role "clerk"/);
    expect(await offer(id)).toMatchObject({ capacity: 3, taken: "0" });
  });

  it("keeps the caller's authority for the other queries of a transaction, and rolls back with them", async () => {
    const id = await openOffer(3);
    await expect(asGuest().transaction(async (tx) => {
      expect(await tx.update("claim_seat", { id, ...one })).toMatchObject({ capacity: 2 });
      // The next query is the caller's again, and the guest holds no clerk role.
      await tx.update("relabel_offer", { id, label: "Taken over" });
    })).rejects.toThrow(/requires the role "clerk"/);
    // Thrown out of the body, so the seat went back with the rest of the unit of work.
    expect(await offer(id)).toMatchObject({ capacity: 3, taken: "0", label: "Workshop" });
  });

  it("keeps the ladder on an owned table for the caller's queries in the same transaction", async () => {
    const id = await openOffer(2);
    const own = await asUser(customer).insert("book", { seats: 1 });
    const theirs = await asUser(stranger).insert("book", { seats: 1 });

    const answers = await asUser(customer).transaction(async (tx) => ({
      seat: await tx.update("claim_seat", { id, ...one }),
      theirs: await tx.update("cancel_booking", { id: String(theirs!.id) }),
      own: await tx.update("cancel_booking", { id: String(own!.id) }),
    }));
    expect(answers.seat).toMatchObject({ capacity: 1 });
    // The ladder answered for the customer: not their booking, so the silent null.
    expect(answers.theirs).toBeNull();
    expect(answers.own).toMatchObject({ flags: CANCELLED });
    expect(await booking(theirs!.id)).toMatchObject({ flags: 0 });
    expect(await offer(id)).toMatchObject({ capacity: 1, taken: "1" });
  });

  it("reaches any row of the Site on an owned table, as a job does, and no row of another Site", async () => {
    const theirs = await asUser(stranger).insert("book", { seats: 2 });
    expect(await asGuest().update("cancel_booking", { id: String(theirs!.id) })).toBeNull();
    expect(await asGuest().update("cancel_any_booking", { id: String(theirs!.id) }))
      .toMatchObject({ flags: CANCELLED, owner_user_id: stranger });

    const abroad = await asUser(visitor, elsewhere).insert("book", { seats: 1 });
    expect(await asGuest().update("cancel_any_booking", { id: String(abroad!.id) })).toBeNull();
    expect(await booking(abroad!.id)).toMatchObject({ flags: 0 });
  });

  it("still writes the caller as owner on insert, and nobody for a guest", async () => {
    expect(await asUser(customer).insert("book_as_addon", { seats: 1 }))
      .toMatchObject({ owner_user_id: customer, created_by_user_id: customer });
    expect(await asGuest().insert("book_as_addon", { seats: 1 }))
      .toMatchObject({ owner_user_id: null, created_by_user_id: null });
  });

  it("still lets a request nobody authenticated write nothing", async () => {
    const id = await openOffer(1);
    await expect(asNobody().update("claim_seat", { id, ...one }))
      .rejects.toThrow(/has no actor behind it/);
    expect(await offer(id)).toMatchObject({ capacity: 1, taken: "0" });
  });
});
