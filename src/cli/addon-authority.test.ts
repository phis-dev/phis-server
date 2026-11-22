import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkAddons, installAddon, upgradeAddon } from "./addons.mts";

/**
 * What the operator is told about queries that run with an Add-on's own authority.
 *
 * `authority: "addon"` lets whoever reaches a route run the query, and Core asks nothing of them. That
 * is a decision the operator installing the Add-on is agreeing to, so it is said where they already
 * look -- at install, at upgrade and at `phis addon check` -- and in the JSON form a deployment script
 * reads, not only in the text a person does. A delete is named twice: once as a bypass, and once as a
 * warning, because there the Add-on alone decides which row of the Site a request removes.
 */

const ADDON = "@acme/tickets";

function manifest(packageVersion: string, queries: unknown[]) {
  return {
    manifestVersion: 1,
    addonId: ADDON,
    packageName: ADDON,
    packageVersion,
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: ["@phis/server/data:v1"],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    roles: [{ name: "clerk", grantableBy: { siteAccess: "site-admin" } }],
    schema: {
      descriptorVersion: 1,
      version: 1,
      tables: [{
        name: "offer",
        siteScoped: true,
        columns: [
          { name: "id", type: "identity" },
          { name: "capacity", type: "integer" },
        ],
        primaryKey: ["id"],
      }],
    },
    queries: {
      parameters: {
        claim: [{ name: "id", type: "bigInteger" }, { name: "quantity", type: "integer" }, { name: "taken", type: "integer" }],
        refill: [{ name: "id", type: "bigInteger" }, { name: "by", type: "integer" }],
        retire: [{ name: "id", type: "bigInteger" }],
      },
      queries,
    },
    migrationVersion: 1,
  };
}

const claim = {
  kind: "update",
  name: "claim",
  table: "offer",
  authority: "addon",
  set: [{ column: "capacity", add: { kind: "parameter", name: "taken" } }],
  idParameter: "id",
  where: { kind: "compare", column: "capacity", operator: ">=", value: { kind: "parameter", name: "quantity" } },
};
const refill = {
  kind: "update",
  name: "refill",
  table: "offer",
  requiresRole: "clerk",
  set: [{ column: "capacity", add: { kind: "parameter", name: "by" } }],
  idParameter: "id",
};
const retire = { kind: "delete", name: "retire", table: "offer", authority: "addon", idParameter: "id" };

describe("queries that run with the Add-on's own authority, as the operator is told", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function phiRoot() {
    const root = await mkdtemp(path.join(tmpdir(), "phis-addon-authority-"));
    roots.push(root);
    await mkdir(path.join(root, "config"), { recursive: true });
    return root;
  }

  /** An artifact is one module exporting `phisAddon`; its manifest is all these commands read. */
  async function artifact(root: string, value: unknown) {
    const directory = await mkdtemp(path.join(root, "artifact-"));
    const file = path.join(directory, "addon.mjs");
    await writeFile(file, `export const phisAddon = { manifest: ${JSON.stringify(value)} };\n`);
    return file;
  }

  it("lists each one at install, with its kind and table, and warns about the delete", async () => {
    const root = await phiRoot();
    const result = await installAddon(
      root,
      new Map([["artifact", await artifact(root, manifest("1.0.0", [claim, refill, retire]))]]),
    );
    expect(result.addonAuthorityQueries).toEqual([
      { addonId: ADDON, query: "claim", kind: "update", table: "offer" },
      { addonId: ADDON, query: "retire", kind: "delete", table: "offer" },
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ addonId: ADDON, query: "retire", kind: "delete", table: "offer" }),
    ]);
    expect(result.warnings[0]!.message).toMatch(/deletes from offer with the Add-on's own authority/);
  });

  it("lists them again at check, for every installed Add-on, in the JSON a script reads", async () => {
    const root = await phiRoot();
    await installAddon(
      root,
      new Map([["artifact", await artifact(root, manifest("1.0.0", [claim, refill, retire]))]]),
    );
    const result = await checkAddons(root);
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(parsed.addonAuthorityQueries).toEqual([
      { addonId: ADDON, query: "claim", kind: "update", table: "offer" },
      { addonId: ADDON, query: "retire", kind: "delete", table: "offer" },
    ]);
    expect(parsed.warnings?.map((warning) => warning.query)).toEqual(["retire"]);
  });

  it("says the whole list for the new build at upgrade, and nothing where there is nothing", async () => {
    const root = await phiRoot();
    await installAddon(root, new Map([["artifact", await artifact(root, manifest("1.0.0", [refill]))]]));
    expect((await checkAddons(root)).addonAuthorityQueries).toEqual([]);

    const upgraded = await upgradeAddon(root, new Map([
      ["addon", ADDON],
      ["artifact", await artifact(root, manifest("1.1.0", [claim, refill]))],
    ]));
    expect(upgraded.addonAuthorityQueries).toEqual([
      { addonId: ADDON, query: "claim", kind: "update", table: "offer" },
    ]);
    expect(upgraded.warnings).toEqual([]);
  });

  it("refuses to install a build that states a role beside the Add-on's authority", async () => {
    const root = await phiRoot();
    const contradictory = { ...claim, requiresRole: "clerk" };
    await expect(installAddon(
      root,
      new Map([["artifact", await artifact(root, manifest("1.0.0", [contradictory]))]]),
    )).rejects.toThrow(/states both authority "addon" and requiresRole/);
  });
});
