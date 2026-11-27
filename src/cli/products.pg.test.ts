import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { PhisProductFlag, type PhisProductId } from "@phis/contracts/products";

const installed = vi.hoisted(() => ({
  addons: [] as { addonId: string; flags: number; manifest: Record<string, unknown> }[],
}));
vi.mock("./addons.mts", () => ({ readAddonDesiredState: () => ({ formatVersion: 1, addons: installed.addons }) }));

import {
  activatePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { registerProduct, setProductState } from "../db/products.mts";
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";
import { runPhisEntitlementCommand } from "./entitlements.mts";
import { reconcileProductSupplyAfterChange, syncAddonProductsAtSite } from "./product-sync.mts";
import { runPhisProductCommand } from "./products.mts";

const configured = process.env.PHIS_PG_TEST === "1";

const SUPPLIER = "@pgtest/cli-supplier";
const SHOP = "@pgtest/cli-shop";
const LISTENER = "@pgtest/cli-listener";
const id = (key: string) => `${SUPPLIER}:${key}` as PhisProductId;
const flags = (entries: Record<string, string | true>) => new Map<string, string | boolean>(Object.entries(entries));

/** The operator's commands over products and over who may write entitlements. */
describe.skipIf(!configured)("phis product and phis entitlement", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let userId: number;

  const product = (words: string[], entries: Record<string, string | true> = {}) =>
    runPhisProductCommand("/unused", pool, words, flags({ site: site.key, ...entries }));
  const entitlement = (words: string[], entries: Record<string, string | true> = {}) =>
    runPhisEntitlementCommand("/unused", pool, words, flags({ site: site.key, ...entries }));

  async function make(key: string, rest: { publisher?: string; active?: boolean; counted?: boolean } = {}) {
    await registerProduct(pool, {
      siteId: site.id, supplier: SUPPLIER, listeners: [],
      draft: normalizePhisProductDraft({ key, type: "licence", title: `Title ${key}`, summary: "S", publisher: rest.publisher, flags: rest.counted ? PhisProductFlag.Counted : 0 }),
    });
    if (rest.active) await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key, state: "active", listeners: [] });
  }

  async function outbox(event: string) {
    const { rows } = await pool.query<{ addon_id: string; payload: Record<string, string> }>(
      `SELECT addon_id, payload FROM phis.addon_event_outbox WHERE site_id = $1 AND event = $2 ORDER BY id`, [site.id, event],
    );
    return rows;
  }

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("cli-products");
    userId = await createPhiTestUser(site);
    await enablePhiTestAddonForSite(site, LISTENER);
    await activatePhiTestAddonForSite(site, SUPPLIER);
    installed.addons = [
      { addonId: SUPPLIER, flags: 1, manifest: {} },
      { addonId: SHOP, flags: 1, manifest: {} },
      { addonId: LISTENER, flags: 1, manifest: { eventHandlers: [{ event: "product.changed" }, { event: "entitlement.changed" }] } },
    ];
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("lists the Site's products with their state, filters them, and says when none match", async () => {
    expect((await product(["list"])).lines).toEqual([`No product matches at ${site.key}.`]);
    await make("a", { active: true });
    await make("b", { publisher: "acme" });
    await make("c", { publisher: "acme", active: false });

    const all = await product(["list"]);
    expect(all.lines).toHaveLength(3);
    expect(all.lines[0]).toContain(`${id("a")}  active  licence  "Title a"  publisher -  released`);
    expect(all.lines[1]).toContain("publisher acme  not released");
    expect((all.data.products as unknown[]).length).toBe(3);

    expect((await product(["list"], { state: "active" })).lines).toHaveLength(1);
    expect((await product(["list"], { publisher: "acme" })).lines).toHaveLength(2);
    expect((await product(["list"], { unreleased: true })).lines).toHaveLength(2);
    expect((await product(["list"], { supplier: "@pgtest/else" })).lines).toEqual([`No product matches at ${site.key}.`]);
    await expect(product(["list"], { state: "gone" })).rejects.toThrow(/--state/);
    await expect(product(["list"], { supplier: "nope" })).rejects.toThrow(/--supplier/);
  });

  it("shows one product, and refuses an unknown one or a wrong id", async () => {
    const shown = await product(["show"], { product: id("a") });
    expect(shown.lines[0]).toBe(`${id("a")}  active  version 2`);
    // The supplier of these products is not switched on for the Site, which the product says.
    expect(shown.lines.join("\n")).toContain("switched off");
    await expect(product(["show"], { product: id("nothing") })).rejects.toThrow(/has no product/);
    await expect(product(["show"], { product: "nonsense" })).rejects.toThrow(/--product must be a product id/);
    await expect(product(["show"])).rejects.toThrow(/Missing --product/);
    await expect(product(["list"], { site: "pgtest-no-such-site" })).rejects.toThrow(/does not exist/);
  });

  it("releases a publisher's product and its pending terms, and refuses the Site's own", async () => {
    const released = await product(["release"], { product: id("b") });
    expect(released.lines).toEqual([`Released ${id("b")}.`]);
    expect(released.data.outcome).toBe("released");
    expect((await product(["release"], { product: id("b") })).lines[0]).toMatch(/^No change/);
    await expect(product(["release"], { product: id("a") })).rejects.toThrow(/needs no release/);
    expect((await product(["list"], { unreleased: true })).lines).toHaveLength(1);

    await registerProduct(pool, {
      siteId: site.id, supplier: SUPPLIER, listeners: [],
      draft: normalizePhisProductDraft({ key: "b", type: "licence", title: "Title b", summary: "S", publisher: "acme", flags: PhisProductFlag.Free }),
    });
    expect((await product(["show"], { product: id("b") })).lines.join("\n")).toContain("pending    sale own, free");
    expect((await product(["release"], { product: id("b") })).data.outcome).toBe("applied");
  });

  it("locks and unlocks a product, the second into withdrawn, and owes the event", async () => {
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);
    const locked = await product(["lock"], { product: id("a") });
    expect(locked.lines[0]).toMatch(/^Locked /);
    expect((await product(["lock"], { product: id("a") })).lines[0]).toMatch(/already locked/);
    expect((await product(["show"], { product: id("a") })).lines[0]).toContain("locked");
    const unlocked = await product(["unlock"], { product: id("a") });
    expect(unlocked.lines[0]).toMatch(/it is withdrawn now/);
    expect((await product(["unlock"], { product: id("a") })).lines[0]).toMatch(/not locked \(withdrawn\)/);
    expect((await outbox("product.changed")).map((row) => row.addon_id)).toEqual([LISTENER, LISTENER]);
  });

  it("withdraws one product, or all of a supplier or publisher, and wants exactly one selector", async () => {
    await make("d", { active: true });
    await make("e", { publisher: "pub-e" });
    await product(["release"], { product: id("e") });
    await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key: "e", state: "active", listeners: [] });

    const one = await product(["withdraw"], { product: id("d") });
    expect(one.lines[0]).toBe(`Withdrew ${id("d")} (was active).`);
    const byPublisher = await product(["withdraw"], { publisher: "pub-e" });
    expect(byPublisher.lines.at(-1)).toBe(`1 product(s) withdrawn at ${site.key}; holders keep what they have.`);
    expect((await product(["withdraw"], { supplier: SUPPLIER })).lines).toEqual(["No change: nothing was active to withdraw."]);
    await expect(product(["withdraw"])).rejects.toThrow(/exactly one/);
    await expect(product(["withdraw"], { product: id("d"), supplier: SUPPLIER })).rejects.toThrow(/exactly one/);
    await product(["lock"], { product: id("d") });
    await expect(product(["withdraw"], { product: id("d") })).rejects.toThrow(/locked/);
    await expect(product(["withdraw"], { product: id("nothing") })).rejects.toThrow(/has no product/);
    await expect(product(["frobnicate"])).rejects.toThrow(/Use product list/);
  });

  it("allows a source for every product or for named suppliers, lists and denies it", async () => {
    expect((await entitlement(["source", "list"])).lines).toEqual([`No source is allowed to write entitlements at ${site.key}.`]);
    const named = await entitlement(["source", "allow"], { source: SHOP, suppliers: `${SUPPLIER}, @pgtest/cli-other` });
    expect(named.lines[0]).toContain(`the products of ${SUPPLIER}, @pgtest/cli-other`);
    expect((await entitlement(["source", "allow"], { source: SHOP, suppliers: `${SUPPLIER},@pgtest/cli-other` })).lines[0]).toMatch(/^No change/);
    expect((await entitlement(["source", "list"])).lines[0]).toContain(`${SHOP}  products of @pgtest/cli-other, ${SUPPLIER}  by the operator`);

    expect((await entitlement(["source", "allow"], { source: SHOP, "all-products": true })).data).toMatchObject({ allProducts: true, suppliers: [], changed: true });
    expect((await entitlement(["source", "list"])).lines[0]).toContain(`${SHOP}  all products`);

    await expect(entitlement(["source", "allow"], { source: SHOP })).rejects.toThrow(/--all-products, or --suppliers/);
    await expect(entitlement(["source", "allow"], { source: SHOP, "all-products": true, suppliers: SUPPLIER })).rejects.toThrow(/--all-products, or --suppliers/);
    await expect(entitlement(["source", "allow"], { source: "@pgtest/not-installed", "all-products": true })).rejects.toThrow(/not an installed Add-on id/);
    await expect(entitlement(["source", "allow"], { source: SHOP, suppliers: "nope" })).rejects.toThrow(/--suppliers/);

    expect((await entitlement(["source", "deny"], { source: SHOP })).lines[0]).toMatch(/^Withdrew the leave/);
    expect((await entitlement(["source", "deny"], { source: SHOP })).lines[0]).toMatch(/^No change/);
  });

  it("grants, lists and revokes by hand on a product, and points to the product list for the catalogue", async () => {
    await make("seats", { active: true, counted: true });
    await make("pass", { active: true });
    await make("old", { active: false });
    const pass = await entitlement(["grant"], { user: String(userId), product: id("pass"), reference: "case-1" });
    expect(pass.lines[0]).toContain(`Granted: ${id("pass")}  @phis/server  case-1`);
    // Granting the same reference again answers the first entry.
    expect((await entitlement(["grant"], { user: String(userId), product: id("pass"), reference: "case-1" })).lines[0]).toContain("case-1");
    await expect(entitlement(["grant"], { user: String(userId), product: id("pass"), reference: "case-2", quantity: "2" })).rejects.toThrow(/does not count/);
    await expect(entitlement(["grant"], { user: String(userId), product: id("seats"), reference: "case-3" })).rejects.toThrow(/counts; --quantity/);
    expect((await entitlement(["grant"], { user: String(userId), product: id("seats"), reference: "case-3", quantity: "3" })).lines[0]).toContain("quantity 3");
    await expect(entitlement(["grant"], { user: String(userId), product: id("old"), reference: "case-4" })).rejects.toThrow(/a new entry needs an active product/);
    await expect(entitlement(["grant"], { user: String(userId), product: id("nothing"), reference: "case-5" })).rejects.toThrow(/has no product/);
    await expect(entitlement(["grant"], { user: String(userId), product: "@x/y:z", reference: "case-5" })).rejects.toThrow(/has no product/);
    await expect(entitlement(["grant"], { user: String(userId), kind: id("pass"), reference: "case-6" })).rejects.toThrow(/Missing --product/);

    expect((await entitlement(["list"], { user: String(userId) })).lines).toHaveLength(2);
    expect((await entitlement(["list"], { user: String(userId), product: id("seats") })).lines).toHaveLength(1);
    expect((await outbox("entitlement.changed")).every((row) => row.addon_id === LISTENER && typeof row.payload.product === "string")).toBe(true);

    expect((await entitlement(["revoke"], { product: id("pass"), reference: "case-1" })).lines[0]).toBe(`Revoked ${id("pass")} case-1 at ${site.key}.`);
    expect((await entitlement(["revoke"], { product: id("pass"), reference: "case-1" })).lines[0]).toMatch(/^Revoked|^No entry/);
    await expect(entitlement(["kinds"])).rejects.toThrow(/phis product list/);
  });

  it("names a user nobody holds instead of surfacing the foreign key, for list and grant", async () => {
    await make("known-pass", { active: true });
    const nobody = "2000000000";
    await expect(entitlement(["list"], { user: nobody })).rejects.toThrow("No such user at " + site.key + ".");
    await expect(entitlement(["grant"], { user: nobody, product: id("known-pass"), reference: "ghost" })).rejects.toThrow("No such user at " + site.key + ".");
    // Neither left a subject behind for the user nobody holds.
    const { rows } = await pool.query(`SELECT 1 FROM phis.entitlement_subjects WHERE user_id = $1`, [Number(nobody)]);
    expect(rows).toHaveLength(0);
  });

  it("shows the subscription an entry follows, and the operator's grant takes none", async () => {
    await make("subbed", { active: true });
    const subscriptionId = "5f0c0000-0000-4000-8000-0000000000aa";
    await pool.query(`INSERT INTO phis.server_addons (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [SHOP]);
    await pool.query(`INSERT INTO phis.payment_profiles (site_id, key, provider_addon_id, draft) VALUES ($1, 'sub', $2, '{}'::jsonb)`, [site.id, SHOP]);
    await pool.query(`INSERT INTO phis.payment_subscriptions (id, site_id, consumer_addon_id, profile_key, idempotency_key, request, record)
      VALUES ($1::uuid, $2, $3, 'sub', 'k', '{}'::jsonb, $4::jsonb)`, [subscriptionId, site.id, SHOP, JSON.stringify({ id: subscriptionId, status: "active", period: null, endedAt: null })]);
    const subject = await pool.query<{ id: number }>(`SELECT s.id FROM phis.entitlement_subjects s WHERE s.site_id = $1 AND s.user_id = $2`, [site.id, userId]);
    await pool.query(`INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference, subscription_id) VALUES ($1, $2, $3, $4, 'bound', $5::uuid)`,
      [site.id, subject.rows[0]!.id, id("subbed"), SHOP, subscriptionId]);
    const listed = await entitlement(["list"], { user: String(userId), product: id("subbed") });
    expect(listed.lines[0]).toContain(`subscription ${subscriptionId}`);
    expect(listed.lines[0]).toContain("not valid");
    // The hand grant has no flag for it (the argument parser refuses one), and the entries it writes are not bound.
    expect((await entitlement(["grant"], { user: String(userId), product: id("subbed"), reference: "h" })).lines[0]).not.toContain("subscription");
    await pool.query(`DELETE FROM phis.entitlements WHERE site_id = $1`, [site.id]);
    await pool.query(`DELETE FROM phis.payment_subscriptions WHERE site_id = $1`, [site.id]);
    await pool.query(`DELETE FROM phis.payment_profiles WHERE site_id = $1`, [site.id]);
  });

  it("registers the declared products where an Add-on is switched on, and follows its supplier", async () => {
    const supplier = "@pgtest/cli-declared";
    await enablePhiTestAddonForSite(site, supplier);
    await pool.query(`UPDATE phis.server_addons SET flags = 1 WHERE addon_id = $1`, [supplier]);
    const entries = Object.fromEntries(installed.addons.map((a) => [a.addonId, { flags: a.flags, manifest: a.manifest as never }]));
    entries[supplier] = { flags: 1, manifest: {} as never };

    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);
    const first = await syncAddonProductsAtSite(pool, {
      addonId: supplier, siteId: site.id, entries, sourceLocale: "en", configRoot: process.cwd(),
      declared: [{ key: "pass", type: "addon", title: "Pass", summary: "S" }, { key: "plan", type: "plan", title: "Plan", summary: "S", flags: PhisProductFlag.Free }],
    });
    expect(first.map((a) => a.action)).toEqual(["created", "created"]);
    expect((await outbox("product.changed")).map((row) => row.addon_id)).toEqual([LISTENER, LISTENER]);
    const listed = await product(["list"], { supplier });
    expect(listed.lines.every((line) => line.includes("  active  "))).toBe(true);

    // Switched off: withdrawn; switched on: back, and nothing else is registered twice.
    await pool.query(`UPDATE phis.site_server_addons SET flags = 0 WHERE site_id = $1 AND addon_id = $2`, [site.id, supplier]);
    const lost = await reconcileProductSupplyAfterChange(pool, entries, site.id);
    // The Site-wide run also catches the other test supplier, which is off.
    expect(lost.filter((change) => change.id.startsWith(`${supplier}:`)).map((change) => change.to)).toEqual(["withdrawn", "withdrawn"]);
    expect((await product(["list"], { supplier, state: "withdrawn" })).lines.every((line) => line.includes("supplier off"))).toBe(true);
    await pool.query(`UPDATE phis.site_server_addons SET flags = 1 WHERE site_id = $1 AND addon_id = $2`, [site.id, supplier]);
    const again = await syncAddonProductsAtSite(pool, { addonId: supplier, siteId: site.id, entries, sourceLocale: "en", configRoot: process.cwd(), declared: [{ key: "pass", type: "addon", title: "Pass", summary: "S" }] });
    expect(Object.fromEntries(again.map((a) => [a.key, a.action]))).toEqual({ pass: "unchanged", plan: "withdrawn" });
    const back = await reconcileProductSupplyAfterChange(pool, entries, site.id);
    expect(back.filter((change) => change.id.startsWith(`${supplier}:`))).toEqual([{ siteId: site.id, id: `${supplier}:pass`, to: "active" }]);
  });
});
