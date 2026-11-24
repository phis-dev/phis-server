import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Taking a Site package's proposed products against the development database: once per Site and proposal,
 * a product the Site has already found and left alone, a picture that has to be imported first, the
 * supplier off or refusing without a row, and a taken proposal never asked again whatever became of the
 * product. `@phis/products` is not loaded: its command is the one thing stood in for, and what it is
 * handed is asserted instead.
 */

const commands = vi.hoisted(() => {
  class PhisAddonCommandError extends Error {}
  return { run: vi.fn(), PhisAddonCommandError };
});
vi.mock("@/lib/addons/commands", () => ({
  runPhisAddonCommand: commands.run,
  PhisAddonCommandError: commands.PhisAddonCommandError,
}));
// Which Modules the Site runs is the published Area selections' answer; stood in for, as the command is.
const active = vi.hoisted(() => ({ moduleIds: [] as string[] }));
vi.mock("@/db/site-active-modules", () => ({
  listPhiSiteActiveModuleIdsWithDb: async () => active.moduleIds,
}));

import {
  closePhiTestPool,
  createPhiTestAsset,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  applyModuleProductProposal,
  recordModuleProductProposals,
  takeModuleProductProposalsOnActivation,
} from "@/lib/module-products-apply";
import { PhisSiteModuleProductFlag } from "@/lib/module-products";
import { listSiteModuleProductProposals, listSiteModuleProducts } from "./site-module-products.mts";

const PKG = "@pgtest/site";

describe("taking proposed products against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let actor: number;

  const ref = (s: PhiTestSite) => ({ id: s.id, key: s.key, publicBaseUrl: `https://${s.key}.test`, timeZone: "UTC" });
  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const pool = await requirePhiTestDatabase();
    return (await pool.query(text, params)).rows as T[];
  }
  const rows = async (s = site) => listSiteModuleProducts(await requirePhiTestDatabase(), s.id);

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("modproducts");
    other = await createPhiTestSite("modproducts-other");
    actor = await createPhiTestUser(site);
  });
  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });
  beforeEach(() => {
    commands.run.mockReset();
    commands.run.mockResolvedValue({ ok: true, runId: "r", result: {} });
  });

  it("makes the product through product.add once, as the member named, and never asks again", async () => {
    const proposal = { key: "pro", title: "Pro", kind: "app", state: "active" as const, flags: 2 };
    const first = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    expect(first).toEqual({ packageName: PKG, key: "pro", productKey: "pgtest.site.pro", status: "created" });
    expect(commands.run).toHaveBeenCalledTimes(1);
    expect(commands.run).toHaveBeenCalledWith({
      addonId: "@phis/products",
      commandId: "product.add",
      site: ref(site),
      actorUserId: actor,
      input: { key: "pgtest.site.pro", title: "Pro", kind: "app", state: "active", counted: false, accountRequired: true },
    });
    expect(await rows()).toEqual([expect.objectContaining({ packageName: PKG, key: "pro", productKey: "pgtest.site.pro", flags: 0 })]);

    // The Site removed or changed the product since: nothing is made again, nothing is asked.
    const again = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal: { ...proposal, title: "Pro 2" }, actorUserId: actor });
    expect(again.status).toBe("taken");
    expect(commands.run).toHaveBeenCalledTimes(1);
    // Another Site is its own.
    expect(await rows(other)).toEqual([]);
  });

  it("leaves a product the Site has under the key already, and records it as found", async () => {
    await sql(
      `INSERT INTO phis.products (site_id, supplier_addon_id, key, type, title, summary)
       VALUES ($1, '@phis/products', 'pgtest.site.basic', 'product', 'Made by hand', '')`,
      [site.id],
    );
    const result = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal: { key: "basic", title: "Basic" }, actorUserId: actor });
    expect(result.status).toBe("found");
    expect(commands.run).not.toHaveBeenCalled();
    expect((await rows()).find((row) => row.key === "basic")?.flags).toBe(PhisSiteModuleProductFlag.Found);
    expect((await sql<{ title: string }>(`SELECT title FROM phis.products WHERE site_id = $1 AND key = 'pgtest.site.basic'`, [site.id]))[0]?.title)
      .toBe("Made by hand");
  });

  it("waits for a picture the Site's library does not hold yet, then hands its Asset id over", async () => {
    const proposal = { key: "pictured", title: "Pictured", picture: "app-icon" };
    const waiting = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    expect(waiting).toMatchObject({ status: "waiting", reason: "media_missing" });
    expect(commands.run).not.toHaveBeenCalled();

    const assetId = await createPhiTestAsset(site, `pgtest/modproducts/${Date.now()}`);
    await sql(
      `INSERT INTO phis.site_module_media (site_id, package_name, key, asset_id, source_checksum, flags) VALUES ($1, $2, 'app-icon', $3, NULL, 0)`,
      [site.id, PKG, assetId],
    );
    const created = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    expect(created.status).toBe("created");
    expect(commands.run.mock.calls[0]?.[0].input).toEqual({ key: "pgtest.site.pictured", title: "Pictured", counted: false, accountRequired: false, picture: assetId });
  });

  it("waits until every picture of the gallery is in the library, then hands their Asset ids over in order", async () => {
    const proposal = { key: "galleried", title: "Galleried", description: "## Long", gallery: ["shot-b", "shot-a"] };
    const asset = async (key: string) => {
      const assetId = await createPhiTestAsset(site, `pgtest/modproducts/${key}/${Date.now()}`);
      await sql(
        `INSERT INTO phis.site_module_media (site_id, package_name, key, asset_id, source_checksum, flags) VALUES ($1, $2, $3, $4, NULL, 0)`,
        [site.id, PKG, key, assetId],
      );
      return assetId;
    };
    const a = await asset("shot-a");
    const waiting = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    expect(waiting).toMatchObject({ status: "waiting", reason: "media_missing", detail: expect.stringContaining('gallery picture "shot-b"') });
    expect(commands.run).not.toHaveBeenCalled();
    const b = await asset("shot-b");
    expect((await applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor })).status).toBe("created");
    expect(commands.run.mock.calls[0]?.[0].input).toEqual({
      key: "pgtest.site.galleried", title: "Galleried", description: "## Long", counted: false, accountRequired: false, gallery: [b, a],
    });
  });

  it("keeps what a package proposes as handed over, and takes it on the Builder's activation as the person who activated it", async () => {
    const pool = await requirePhiTestDatabase();
    const site2 = await createPhiTestSite("modproducts-activation");
    const admin = await createPhiTestUser(site2);
    const pkg = "@pgtest/shell";
    const stored = async () => (await listSiteModuleProductProposals(pool, site2.id)).map((row) => `${row.key}:${row.waitingReason ?? "-"}`);

    // Handed over: kept, waiting for the activation; a later hand-over is the whole list and drops what it no longer names.
    const handed = await recordModuleProductProposals(ref(site2), { packageName: pkg, proposals: [{ key: "one", title: "One" }, { key: "two", title: "Two" }] });
    expect(handed.map((item) => `${item.key}:${item.status}:${item.reason}`)).toEqual(["one:waiting:activation", "two:waiting:activation"]);
    await recordModuleProductProposals(ref(site2), { packageName: pkg, proposals: [{ key: "one", title: "One" }, { key: "three", title: "Three" }] });
    expect(await stored()).toEqual(["one:-", "three:-"]);

    // Nothing is taken while none of the package's Modules runs.
    active.moduleIds = ["@pgtest/other/modules/site"];
    expect(await takeModuleProductProposalsOnActivation(ref(site2), { actorUserId: admin })).toEqual([]);
    expect(commands.run).not.toHaveBeenCalled();

    // Activated: taken as that person; one the person may not take keeps waiting and says why, and fails nothing.
    active.moduleIds = [`${pkg}/modules/site`];
    commands.run.mockResolvedValueOnce({ ok: true, runId: "r", result: {} });
    commands.run.mockResolvedValueOnce({ ok: false, runId: "r", error: "This needs the editor role." });
    const taken = await takeModuleProductProposalsOnActivation(ref(site2), { actorUserId: admin });
    expect(taken.map((item) => `${item.key}:${item.status}`)).toEqual(["one:created", "three:refused"]);
    expect(commands.run.mock.calls.every((call) => call[0].actorUserId === admin)).toBe(true);
    expect(await stored()).toEqual(["one:-", "three:supplier_refused"]);
    expect((await listSiteModuleProductProposals(pool, site2.id))[1]!.waitingDetail).toBe("This needs the editor role.");

    // The next activation asks only for what is not taken; once taken, the reason goes.
    commands.run.mockClear();
    const again = await takeModuleProductProposalsOnActivation(ref(site2), { actorUserId: admin });
    expect(again.map((item) => `${item.key}:${item.status}`)).toEqual(["three:created"]);
    expect(commands.run).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual(["one:-", "three:-"]);
    expect((await recordModuleProductProposals(ref(site2), { packageName: pkg, proposals: [{ key: "one", title: "One" }] }))[0]!.status).toBe("taken");
    active.moduleIds = [];
  });

  it("records nothing while the supplier is off or refuses, so the next sync asks again", async () => {
    commands.run.mockRejectedValueOnce(new commands.PhisAddonCommandError("@phis/products is not enabled for x."));
    const off = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal: { key: "later", title: "Later" }, actorUserId: actor });
    expect(off).toMatchObject({ status: "waiting", reason: "supplier_unavailable", detail: "@phis/products is not enabled for x." });

    commands.run.mockResolvedValueOnce({ ok: false, runId: "r", error: "This needs the editor role." });
    const refused = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal: { key: "later", title: "Later" }, actorUserId: actor });
    expect(refused).toMatchObject({ status: "refused", reason: "supplier_refused", detail: "This needs the editor role." });
    expect((await rows()).some((row) => row.key === "later")).toBe(false);

    const taken = await applyModuleProductProposal(ref(site), { packageName: PKG, proposal: { key: "later", title: "Later" }, actorUserId: actor });
    expect(taken.status).toBe("created");
  });

  it("takes a proposal once when two syncs ask at the same moment", async () => {
    let release!: () => void;
    commands.run.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ ok: true, runId: "r", result: {} }); }));
    const proposal = { key: "raced", title: "Raced" };
    const first = applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    await vi.waitFor(() => expect(commands.run).toHaveBeenCalledTimes(1));
    const second = applyModuleProductProposal(ref(site), { packageName: PKG, proposal, actorUserId: actor });
    release();
    expect([(await first).status, (await second).status]).toEqual(["created", "taken"]);
    expect(commands.run).toHaveBeenCalledTimes(1);
  });
});
