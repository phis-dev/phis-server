import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyPhiServerAddonSchema, dropPhiServerAddonSchema } from "./server-addon-schema.mts";
import { grantPhiServerAddonUserRole, revokePhiServerAddonUserRole } from "./server-addon-roles.mts";
import { getPhiServerConfigSync } from "@/lib/config";
import { quotePhiIdentifier } from "@/lib/addons/schema-ddl";
import { buildPhiServerAddonCapabilities } from "@/lib/addons/capabilities";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import type { PhiServerAddonManifestV1 } from "@/lib/addons/contract";

/**
 * A query guarded by a role, running against a real database.
 *
 * Two things are being shown, and the second is the reason the first exists.
 *
 * That the guard holds: a caller without the role is refused, and refused loudly rather than with the
 * silent zero the ladder gives -- there is nothing to withhold here, and an Add-on that offered the
 * action to the wrong person wants to hear so.
 *
 * And that it makes a table nobody owns writable at all. Without an owner and without a group Core has
 * no row to judge and answers no to every update and delete, which is right for a row that should
 * belong to somebody and wrong for a catalogue, a rate table or a moderation note. The role is the
 * missing authority, and it is in the descriptor rather than at the top of a handler because a check
 * that has to be remembered is one that eventually is not.
 */

const SCHEMA = "phis_addon_pgtest_queryroles";
const ADDON = "@pgtest/queryroles";
const DECLARED_ROLES = [
  { name: "curator", grantableBy: { siteAccess: "site-admin" as const } },
  { name: "vendor", grantableBy: { role: "curator" } },
];

const target = {
  schemaName: SCHEMA,
  descriptor: {
    descriptorVersion: 1 as const,
    version: 1,
    tables: [
      {
        // No owner and no group: the rows belong to the Add-on, not to a person.
        name: "category",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "label", type: "string" as const, maxLength: 64 },
        ],
        primaryKey: ["id"],
      },
      {
        // Owned and not grouped: the row is the writer's, and no membership level reaches over it.
        name: "review",
        siteScoped: true,
        ownerScoped: true,
        columns: [
          { name: "id", type: "identity" as const },
          { name: "body", type: "string" as const, maxLength: 200 },
        ],
        primaryKey: ["id"],
      },
    ],
  },
};

const manifest = {
  manifestVersion: 1,
  addonId: ADDON,
  packageName: ADDON,
  packageVersion: "0.1.0",
  serverAbi: "1",
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: ["@phis/server/data:v1"],
  apiRoutes: [],
  hooks: [],
  jobs: [],
  settings: [],
  roles: DECLARED_ROLES,
  schema: target.descriptor,
  queries: {
    parameters: {
      all: [],
      add: [{ name: "label", type: "text" }],
      rename: [{ name: "id", type: "bigInteger" }, { name: "label", type: "text" }],
      write_review: [{ name: "body", type: "text" }],
      all_reviews: [],
      drop_review: [{ name: "id", type: "bigInteger" }],
    },
    queries: [
      { kind: "select", name: "all", table: "category", limit: 25 },
      {
        kind: "insert",
        name: "add",
        table: "category",
        requiresRole: "vendor",
        values: [{ column: "label", value: { kind: "parameter", name: "label" } }],
      },
      {
        kind: "update",
        name: "rename",
        table: "category",
        requiresRole: "curator",
        set: [{ column: "label", value: { kind: "parameter", name: "label" } }],
        idParameter: "id",
      },
      {
        kind: "insert",
        name: "write_review",
        table: "review",
        values: [{ column: "body", value: { kind: "parameter", name: "body" } }],
      },
      { kind: "select", name: "all_reviews", table: "review", limit: 25 },
      {
        // The other direction to `requiresRole`: the row is judged first, and a caller the ladder turned
        // down is let through on the role. The writer keeps reaching their own without holding any.
        kind: "delete",
        name: "drop_review",
        table: "review",
        alsoAllowedByRole: "curator",
        idParameter: "id",
      },
    ],
  },
  migrationVersion: 1,
} as unknown as PhiServerAddonManifestV1;

let migrationPool: Pool;

describe("a query that requires a role", () => {
  let site: PhiTestSite;
  let vendor: number;
  let curator: number;
  let nobody: number;

  function data(actorUserId: number | null) {
    return buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-queryroles",
      siteId: site.id,
      actorUserId,
    }).data!;
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("addon-query-roles");
    vendor = await createPhiTestUser(site);
    curator = await createPhiTestUser(site);
    nobody = await createPhiTestUser(site);

    await pool.query(
      `INSERT INTO phis.server_addons
         (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
       VALUES ($1, $1, '0.1.0', '1', repeat('0', 64), 'pgtest')
       ON CONFLICT (addon_id) DO NOTHING`,
      [ADDON],
    );
    await grantPhiServerAddonUserRole(pool, {
      addonId: ADDON,
      siteId: site.id,
      userId: vendor,
      role: "vendor",
      grantedByUserId: null,
    });
    await grantPhiServerAddonUserRole(pool, {
      addonId: ADDON,
      siteId: site.id,
      userId: curator,
      role: "curator",
      grantedByUserId: null,
    });

    const config = getPhiServerConfigSync().database;
    if (!config?.migrationUri || !config.uri) {
      throw new Error("These tests need database.migrationUri and database.uri.");
    }
    const servingRole = decodeURIComponent(new URL(config.uri).username);
    migrationPool = new Pool({ connectionString: config.migrationUri });
    const client = await migrationPool.connect();
    try {
      await dropPhiServerAddonSchema(client, SCHEMA);
      await applyPhiServerAddonSchema(client, target, servingRole);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    if (migrationPool) {
      const client = await migrationPool.connect();
      try {
        await dropPhiServerAddonSchema(client, SCHEMA);
      } finally {
        client.release();
      }
      await migrationPool.end();
    }
    await pool.query(`DELETE FROM phis.site_addon_user_roles WHERE addon_id = $1`, [ADDON]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON]);
    await closePhiTestPool();
  });

  it("refuses the insert to somebody who holds no role, and says why", async () => {
    await expect(data(nobody).insert("add", { label: "crm" }))
      .rejects.toThrow(/requires the role "vendor"/);
  });

  it("lets the holder through", async () => {
    const row = await data(vendor).insert("add", { label: "crm" });
    expect(row).toMatchObject({ label: "crm" });
  });

  it("does not accept the wrong role, even a more powerful one", async () => {
    // Roles are names, not a hierarchy. Core compares one string and knows nothing about seniority --
    // if a curator should also be able to add, the manifest says so by granting both.
    await expect(data(curator).insert("add", { label: "fonts" }))
      .rejects.toThrow(/requires the role "vendor"/);
  });

  it("writes a row nobody owns, which without a role nobody could change", async () => {
    const added = await data(vendor).insert("add", { label: "before" });
    const id = String(added!.id);

    // The ladder alone answers no here: there is no owner and no group, so there is no row to judge.
    await expect(data(vendor).update("rename", { id, label: "after" }))
      .rejects.toThrow(/requires the role "curator"/);

    expect(await data(curator).update("rename", { id, label: "after" })).toBe(1);
    const rows = (await data(curator).select("all")).rows;
    expect(rows.some((row) => row.label === "after")).toBe(true);
  });

  it("lets the writer reach their own row without holding any role", async () => {
    const written = await data(nobody).insert("write_review", { body: "mine" });
    // The row comes back, which is the only moment its columns can still be read.
    expect(await data(nobody).delete("drop_review", { id: String(written!.id) }))
      .toMatchObject({ body: "mine" });
  });

  it("lets a role stand in where the ladder said no", async () => {
    const written = await data(nobody).insert("write_review", { body: "moderated" });
    const id = String(written!.id);

    // Owned and not grouped, so there is no membership level to climb: a stranger is simply refused, and
    // refused the ladder's way -- an empty answer, because saying more would tell them the row exists.
    expect(await data(vendor).delete("drop_review", { id })).toBeNull();
    expect((await data(nobody).select("all_reviews")).rows.some((row) => row.body === "moderated"))
      .toBe(true);

    expect(await data(curator).delete("drop_review", { id })).toMatchObject({ body: "moderated" });
  });

  it("stops the moment the role is taken away", async () => {
    await revokePhiServerAddonUserRole(await requirePhiTestDatabase(), {
      addonId: ADDON,
      siteId: site.id,
      userId: vendor,
      role: "vendor",
    });
    await expect(data(vendor).insert("add", { label: "too late" }))
      .rejects.toThrow(/requires the role "vendor"/);
  });

  it("refuses a caller with no actor at all before it looks at roles", async () => {
    const anonymous = buildPhiServerAddonCapabilities({
      manifest,
      manifestDigest: "pgtest-queryroles",
      siteId: site.id,
      actorUserId: null,
      unauthenticated: true,
    }).data!;
    await expect(anonymous.insert("add", { label: "hook" }))
      .rejects.toThrow(/no actor behind it/);
  });
});
