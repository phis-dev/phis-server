import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import type { PhisProductDraft, PhisProductId } from "@phis/contracts/products";

import {
  activatePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestAddonSpace,
  createPhiTestAsset,
  createPhiTestSite,
  createPhiTestUser,
  createPhiTestUserSpace,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";
import { ensureEntitlementSubject, findEntitlementSubject, grantEntitlement } from "./entitlements.mts";
import {
  annotateProduct,
  listProductDirectory,
  listProductIdsWithImage,
  listProducts,
  moveProductsAsOperator,
  readProduct,
  readProductDirectoryEntry,
  reconcileProductSupply,
  registerProduct,
  releaseProduct,
  removeProduct,
  setProductState,
  syncManifestProducts,
} from "./products.mts";

const configured = process.env.PHIS_PG_TEST === "1";

const SUPPLIER = "@pgtest/prod-supplier";
const OTHER = "@pgtest/prod-other";
const SHOP = "@pgtest/prod-shop";
const READY = "@pgtest/prod-listener";
const NOT_READY = "@pgtest/prod-idle";
const id = (supplier: string, key: string) => `${supplier}:${key}` as PhisProductId;

/**
 * The product directory: what a supplier may write, what only the operator may, and which change is
 * owed an event. See design/COMMERCE_COORDINATION.md section 4.
 */
describe.skipIf(!configured)("products", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let subjectId: number;
  const listeners = [READY, NOT_READY];

  const draft = (key: string, rest: Partial<PhisProductDraft> = {}) =>
    normalizePhisProductDraft({ key, type: "licence", title: `Title ${key}`, summary: "Summary", ...rest });

  const register = (key: string, rest: Partial<PhisProductDraft> = {}, supplier = SUPPLIER, recipients: readonly string[] = []) =>
    registerProduct(pool, { siteId: site.id, supplier, draft: draft(key, rest), listeners: recipients });

  const state = (key: string, to: "draft" | "active" | "withdrawn", supplier = SUPPLIER, recipients: readonly string[] = []) =>
    setProductState(pool, { siteId: site.id, supplier, key, state: to, listeners: recipients });

  const get = (productId: PhisProductId) => readProduct(pool, site.id, productId);

  async function outbox() {
    const { rows } = await pool.query<{ addon_id: string; subject_kind: string; payload: { productId: string } }>(
      `SELECT addon_id, subject_kind, payload FROM phis.addon_event_outbox
       WHERE site_id = $1 AND event = 'product.changed' ORDER BY id`,
      [site.id],
    );
    return rows;
  }
  const clearOutbox = () => pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);

  async function switchSupplier(addonId: string, on: boolean) {
    await pool.query(`UPDATE phis.server_addons SET flags = $2 WHERE addon_id = $1`, [addonId, on ? 1 : 0]);
    await pool.query(`UPDATE phis.site_server_addons SET flags = $3 WHERE site_id = $1 AND addon_id = $2`, [site.id, addonId, on ? 1 : 0]);
  }

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("products");
    const userId = await createPhiTestUser(site);
    subjectId = (await findEntitlementSubject(pool, site.id, await ensureEntitlementSubject(pool, site.id, userId)))!.id;
    await enablePhiTestAddonForSite(site, READY);
    await activatePhiTestAddonForSite(site, NOT_READY);
    await activatePhiTestAddonForSite(site, SUPPLIER);
    await activatePhiTestAddonForSite(site, OTHER);
    await switchSupplier(SUPPLIER, true);
    await switchSupplier(OTHER, true);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("registers a draft idempotently: the same draft twice changes nothing, not even the version", async () => {
    await clearOutbox();
    const first = await register("idem", { publisher: null }, SUPPLIER, listeners);
    expect(first.outcome).toBe("created");
    expect(first.product).toMatchObject({
      id: id(SUPPLIER, "idem"), supplier: SUPPLIER, supplied: true, publisher: null, state: "draft", released: true,
      pendingTerms: null, sale: "own", free: false, counted: false, parts: [], attributes: {}, version: 1,
    });
    expect((await outbox()).map((row) => row.addon_id)).toEqual([READY]);

    const second = await register("idem", {}, SUPPLIER, listeners);
    expect(second.outcome).toBe("unchanged");
    expect(second.product).toEqual(first.product);
    expect(await outbox()).toHaveLength(1);

    const changed = await register("idem", { title: "Another title", free: true }, SUPPLIER, listeners);
    expect(changed.outcome).toBe("updated");
    expect(changed.product).toMatchObject({ title: "Another title", free: true, version: 2, state: "draft" });
    expect(await outbox()).toHaveLength(2);
  });

  it("does not let a supplier change a product of another: it finds nothing", async () => {
    await register("mine");
    // The same key of another supplier is another product.
    const theirs = await register("mine", { title: "Theirs" }, OTHER);
    expect(theirs.product.id).toBe(id(OTHER, "mine"));
    expect((await get(id(SUPPLIER, "mine")))!.title).toBe("Title mine");

    expect(await state("nothing-of-mine", "active", OTHER)).toBeNull();
    expect(await setProductState(pool, { siteId: site.id, supplier: OTHER, key: "idem", state: "active", listeners: [] })).toBeNull();
    expect(await removeProduct(pool, { siteId: site.id, supplier: OTHER, key: "idem" })).toBe(false);
    expect((await get(id(SUPPLIER, "idem")))!.state).toBe("draft");
  });

  it("keeps a publisher fixed, because changing it would skip the release", async () => {
    await register("pub-fixed", { publisher: "acme" });
    await expect(register("pub-fixed", { publisher: null })).rejects.toThrow(/publisher/);
    await expect(register("pub-fixed", { publisher: "other" })).rejects.toThrow(/publisher/);
    await register("own-fixed");
    await expect(register("own-fixed", { publisher: "acme" })).rejects.toThrow(/publisher/);
  });

  it("changes every term at once before a publisher's product is released, and refuses it active", async () => {
    await register("pre", { publisher: "acme", sale: "own" });
    const before = await get(id(SUPPLIER, "pre"));
    expect(before).toMatchObject({ released: false, pendingTerms: null });
    await expect(state("pre", "active")).rejects.toThrow(/not released/);

    const changed = await register("pre", { publisher: "acme", sale: "referral", referralUrl: "https://acme.example/shop", free: true });
    expect(changed.product).toMatchObject({ sale: "referral", referralUrl: "https://acme.example/shop", free: true, pendingTerms: null, released: false });
    // Draft and withdrawn are allowed; only active needs the release.
    expect((await state("pre", "withdrawn"))!.state).toBe("withdrawn");
  });

  it("holds changed terms of a released product as pendingTerms until the operator releases them", async () => {
    await clearOutbox();
    await register("rel", { publisher: "acme", sale: "own", type: "licence" });
    expect((await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "rel"), listeners }))).toMatchObject({ outcome: "released", product: { released: true, pendingTerms: null } });
    expect((await state("rel", "active"))!.state).toBe("active");
    expect((await outbox()).length).toBeGreaterThan(0);

    // Title, summary, type and picture change at once; sale, referralUrl, free and parts wait.
    const asked = await register("rel", { publisher: "acme", sale: "payout", free: true, title: "Renamed", type: "plan" });
    expect(asked.product).toMatchObject({
      title: "Renamed", type: "plan", sale: "own", free: false, referralUrl: null, parts: [],
      pendingTerms: { sale: "payout", referralUrl: null, free: true, parts: [] }, released: true, state: "active",
    });
    const version = asked.product.version;
    // The same draft again changes nothing, though jsonb stores the pending terms in its own key order.
    const again = await register("rel", { publisher: "acme", sale: "payout", free: true, title: "Renamed", type: "plan" });
    expect(again.outcome).toBe("unchanged");
    expect(again.product.version).toBe(version);

    // Asking for the terms in force again takes the request back.
    const back = await register("rel", { publisher: "acme", title: "Renamed", type: "plan" });
    expect(back.product.pendingTerms).toBeNull();
    await register("rel", { publisher: "acme", sale: "payout", free: true, title: "Renamed", type: "plan" });

    await clearOutbox();
    const applied = await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "rel"), listeners });
    expect(applied).toMatchObject({ outcome: "applied", product: { sale: "payout", free: true, pendingTerms: null } });
    expect(await outbox()).toHaveLength(1);
    expect((await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "rel"), listeners }))!.outcome).toBe("unchanged");
  });

  it("keeps whether an account is required with the terms: at once before the release, pending after it", async () => {
    expect((await register("acct-own")).product.accountRequired).toBe(false);
    expect((await register("acct-own", { accountRequired: true })).product.accountRequired).toBe(true);
    expect((await register("acct-own", { accountRequired: true })).outcome).toBe("unchanged");

    await register("acct-pub", { publisher: "acme" });
    expect((await register("acct-pub", { publisher: "acme", accountRequired: true })).product).toMatchObject({ accountRequired: true, pendingTerms: null });
    await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "acct-pub"), listeners: [] });
    const asked = await register("acct-pub", { publisher: "acme", accountRequired: false });
    expect(asked.product).toMatchObject({ accountRequired: true, pendingTerms: { accountRequired: false } });
    expect((await register("acct-pub", { publisher: "acme", accountRequired: false })).outcome).toBe("unchanged");
    const applied = await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "acct-pub"), listeners: [] });
    expect(applied!.product).toMatchObject({ accountRequired: false, pendingTerms: null });
  });

  it("needs no release for the Site's own product, and says so", async () => {
    await register("own-rel");
    await expect(releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "own-rel"), listeners: [] })).rejects.toThrow(/needs no release/);
    expect((await state("own-rel", "active"))!.state).toBe("active");
    expect(await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "absent"), listeners: [] })).toBeNull();
  });

  it("moves between draft, active and withdrawn, and refuses every move on a locked product", async () => {
    await clearOutbox();
    await register("moves");
    expect((await state("moves", "active", SUPPLIER, listeners))!.state).toBe("active");
    expect(await outbox()).toHaveLength(1);
    // Moving to the state it is in changes nothing.
    const same = await state("moves", "active", SUPPLIER, listeners);
    expect(same!.version).toBe(2);
    expect(await outbox()).toHaveLength(1);
    expect((await state("moves", "withdrawn"))!.state).toBe("withdrawn");
    expect((await state("moves", "draft"))!.state).toBe("draft");
    expect((await state("moves", "active"))!.state).toBe("active");

    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: id(SUPPLIER, "moves"), listeners: [] });
    for (const to of ["draft", "active", "withdrawn"] as const) {
      await expect(state("moves", to)).rejects.toThrow(/locked/);
    }
    expect((await get(id(SUPPLIER, "moves")))!.state).toBe("locked");
    // The supplier's other writes are not moves.
    expect((await register("moves", { title: "Still editable" })).outcome).toBe("updated");

    // Unlocked, it is withdrawn: the state before the lock is not kept.
    const unlocked = await moveProductsAsOperator(pool, { siteId: site.id, to: "unlocked", productId: id(SUPPLIER, "moves"), listeners: [] });
    expect(unlocked).toEqual([{ id: id(SUPPLIER, "moves"), from: "locked", to: "withdrawn" }]);
    expect((await state("moves", "active"))!.state).toBe("active");
  });

  it("withdraws one product, or all active products of a supplier or publisher, for the operator", async () => {
    await register("w1", { publisher: "wp" });
    await register("w2", { publisher: "wp" });
    await register("w3");
    await register("w-draft");
    for (const key of ["w1", "w2", "w3"]) {
      if (key !== "w3") await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, key), listeners: [] });
      await state(key, "active");
    }
    const byPublisher = await moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", publisher: "wp", listeners: [] });
    expect(byPublisher.map((move) => move.id).sort()).toEqual([id(SUPPLIER, "w1"), id(SUPPLIER, "w2")]);
    expect((await get(id(SUPPLIER, "w3")))!.state).toBe("active");
    const single = await moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", productId: id(SUPPLIER, "w-draft"), listeners: [] });
    expect(single).toHaveLength(1);
    expect(await moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", productId: id(SUPPLIER, "w-draft"), listeners: [] })).toEqual([]);
    const bySupplier = await moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", supplier: SUPPLIER, listeners: [] });
    expect(bySupplier.map((move) => move.id)).toContain(id(SUPPLIER, "w3"));
    expect((await get(id(SUPPLIER, "w3")))!.state).toBe("withdrawn");
    // Another supplier's products are not touched.
    expect((await get(id(OTHER, "mine")))!.state).toBe("draft");
  });

  it("removes a product nobody acquired, and keeps one an entitlement ever named or a bundle contains", async () => {
    await register("rm-free");
    expect(await removeProduct(pool, { siteId: site.id, supplier: SUPPLIER, key: "rm-free" })).toBe(true);
    expect(await get(id(SUPPLIER, "rm-free"))).toBeNull();
    expect(await removeProduct(pool, { siteId: site.id, supplier: SUPPLIER, key: "rm-free" })).toBe(false);

    await register("rm-held");
    await state("rm-held", "active");
    const entry = await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: id(SUPPLIER, "rm-held"), source: SHOP, reference: "rm-1",
      startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    });
    expect(entry).not.toBeNull();
    await state("rm-held", "withdrawn");
    expect(await removeProduct(pool, { siteId: site.id, supplier: SUPPLIER, key: "rm-held" })).toBe(false);
    expect(await get(id(SUPPLIER, "rm-held"))).not.toBeNull();

    await register("rm-part");
    await register("rm-bundle", { parts: [id(SUPPLIER, "rm-part")] });
    expect(await removeProduct(pool, { siteId: site.id, supplier: SUPPLIER, key: "rm-part" })).toBe(false);
  });

  it("fixes counted once an entitlement names the product", async () => {
    await register("cnt", { counted: true });
    await state("cnt", "active");
    expect((await register("cnt", { counted: false })).product.counted).toBe(false);
    await register("cnt", { counted: true });
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: id(SUPPLIER, "cnt"), source: SHOP, reference: "cnt-1",
      startsAt: null, endsAt: null, quantity: 2, counted: true, listeners: [],
    });
    await expect(register("cnt", { counted: false })).rejects.toThrow(/fixed/);
    expect((await register("cnt", { counted: true })).outcome).toBe("unchanged");
  });

  it("lets every Add-on write only its own attributes, whole, and take them away", async () => {
    await clearOutbox();
    await register("attr");
    const target = id(SUPPLIER, "attr");
    const mine = await annotateProduct(pool, { siteId: site.id, productId: target, addonId: SHOP, data: { rating: 4, tags: ["a"] }, listeners });
    expect(mine!.attributes).toEqual({ [SHOP]: { rating: 4, tags: ["a"] } });
    await annotateProduct(pool, { siteId: site.id, productId: target, addonId: OTHER, data: { signed: true }, listeners });
    expect((await get(target))!.attributes).toEqual({ [SHOP]: { rating: 4, tags: ["a"] }, [OTHER]: { signed: true } });
    expect(await outbox()).toHaveLength(2);

    // Whole, not merged; writing the same again changes nothing.
    const version = (await get(target))!.version;
    await annotateProduct(pool, { siteId: site.id, productId: target, addonId: SHOP, data: { tags: ["a"], rating: 4 }, listeners });
    expect((await get(target))!.version).toBe(version);
    await annotateProduct(pool, { siteId: site.id, productId: target, addonId: SHOP, data: { rating: 5 }, listeners });
    expect((await get(target))!.attributes[SHOP]).toEqual({ rating: 5 });
    expect((await get(target))!.version).toBe(version + 1);

    await annotateProduct(pool, { siteId: site.id, productId: target, addonId: SHOP, data: null, listeners });
    expect(Object.keys((await get(target))!.attributes)).toEqual([OTHER]);
    // Taking away what is not there changes nothing; a product that does not exist answers null.
    const afterRemoval = (await get(target))!.version;
    await annotateProduct(pool, { siteId: site.id, productId: target, addonId: SHOP, data: null, listeners });
    expect((await get(target))!.version).toBe(afterRemoval);
    expect(await annotateProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "absent"), addonId: SHOP, data: {}, listeners })).toBeNull();
  });

  it("checks a bundle's parts: they exist on the Site, not itself, no circles, not counted", async () => {
    await register("part-a");
    await register("part-b");
    await expect(register("bundle-x", { parts: [id(SUPPLIER, "missing")] })).rejects.toThrow(/is not a product of this Site/);
    expect(await get(id(SUPPLIER, "bundle-x"))).toBeNull();
    expect(() => draft("bundle-self", { parts: [id(SUPPLIER, "bundle-self")] })).not.toThrow();
    expect(() => normalizePhisProductDraft({ key: "bundle-self", type: "t", title: "t", summary: "", parts: [id(SUPPLIER, "bundle-self")] }, id(SUPPLIER, "bundle-self"))).toThrow(/part of itself/);
    expect(() => draft("bundle-counted", { counted: true, parts: [id(SUPPLIER, "part-a")] })).toThrow(/not counted/);

    const bundle = await register("bundle-ok", { parts: [id(SUPPLIER, "part-a"), id(SUPPLIER, "part-b")] });
    expect(bundle.product.parts).toEqual([id(SUPPLIER, "part-a"), id(SUPPLIER, "part-b")]);

    // A part of another supplier, on the same Site, is a part.
    expect((await register("bundle-mixed", { parts: [id(OTHER, "mine")] })).product.parts).toEqual([id(OTHER, "mine")]);

    // Circles: a bundle of a bundle may not reach itself again, however indirect.
    await register("loop-a");
    await register("loop-b", { parts: [id(SUPPLIER, "loop-a")] });
    await register("loop-c", { parts: [id(SUPPLIER, "loop-b")] });
    await expect(register("loop-a", { parts: [id(SUPPLIER, "loop-c")] })).rejects.toThrow(/contain itself/);
    expect((await get(id(SUPPLIER, "loop-a")))!.parts).toEqual([]);
  });

  it("holds changed parts of a released publisher's bundle as pending, and checks them for circles at release", async () => {
    await register("pb-part");
    await register("pb", { publisher: "acme" });
    await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "pb"), listeners: [] });
    const held = await register("pb", { publisher: "acme", parts: [id(SUPPLIER, "pb-part")] });
    expect(held.product).toMatchObject({ parts: [], pendingTerms: { parts: [id(SUPPLIER, "pb-part")] } });
    // Pending parts count as edges: the part cannot now take the bundle as its own part.
    await expect(register("pb-part", { parts: [id(SUPPLIER, "pb")] })).rejects.toThrow(/contain itself/);
    expect((await releaseProduct(pool, { siteId: site.id, productId: id(SUPPLIER, "pb"), listeners: [] }))!.product.parts).toEqual([id(SUPPLIER, "pb-part")]);
  });

  it("accepts an Asset of the Site as the picture, refuses another Site's, and drops it with the Asset", async () => {
    const asset = await createPhiTestAsset(site, "product-image", { lifecycleStatus: 2 });
    const withImage = await register("img", { imageAssetId: asset });
    expect(withImage.product).toMatchObject({ imageAssetId: asset, imageRevision: 1 });
    // The address follows the asset's cache revision, read at the moment it is used.
    await pool.query(`UPDATE phis.media_assets SET delivery_revision = 2 WHERE id = $1`, [asset]);
    expect((await get(id(SUPPLIER, "img")))!.imageRevision).toBe(2);
    await expect(register("img", { imageAssetId: 2_000_000_000 })).rejects.toThrow(/not an Asset of this Site/);
    const elsewhere = await createPhiTestSite("products-elsewhere");
    const foreign = await createPhiTestAsset(elsewhere, "foreign-image", { lifecycleStatus: 2 });
    await expect(register("img", { imageAssetId: foreign })).rejects.toThrow(/not an Asset of this Site/);
    expect(await listProductIdsWithImage(pool, site.id, asset)).toEqual([id(SUPPLIER, "img")]);
    expect(await listProductIdsWithImage(pool, elsewhere.id, asset)).toEqual([]);
    await pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [asset]);
    expect(await listProductIdsWithImage(pool, site.id, asset)).toEqual([]);
    expect((await get(id(SUPPLIER, "img")))).toMatchObject({ imageAssetId: null, imageRevision: null });
  });

  it("refuses a picture a visitor would not be served, and takes the supplier's own Add-on Space", async () => {
    const ready = { lifecycleStatus: 2 } as const;
    const space = (addonId: string) => createPhiTestAddonSpace(site, addonId);
    const own = await createPhiTestAsset(site, "own-cover", { ...ready, spaceId: await space(SUPPLIER) });
    expect((await register("pic", { imageAssetId: own })).product.imageAssetId).toBe(own);

    const pending = await createPhiTestAsset(site, "pending-image");
    const archived = await createPhiTestAsset(site, "archived-image", { lifecycleStatus: 3 });
    const authenticated = await createPhiTestAsset(site, "authenticated-image", { ...ready, deliveryPolicy: 2 });
    const others = await createPhiTestAsset(site, "other-addon-image", { ...ready, spaceId: await space(OTHER) });
    const userSpace = await createPhiTestAsset(site, "user-image", { ...ready, spaceId: await createPhiTestUserSpace(site) });
    for (const refused of [pending, archived, authenticated, others, userSpace]) {
      await expect(register("pic", { imageAssetId: refused })).rejects.toThrow(/cannot be a product's picture/);
    }
    expect((await get(id(SUPPLIER, "pic")))!.imageAssetId).toBe(own);
    // The other Add-on may use its own file, and the supplier's file is not another's.
    expect((await register("pic-other", { imageAssetId: others }, OTHER)).product.imageAssetId).toBe(others);
    await expect(register("pic-other", { imageAssetId: own }, OTHER)).rejects.toThrow(/cannot be a product's picture/);
  });

  it("takes an icon beside the picture under the picture's rules, and drops it with its Asset", async () => {
    const ready = { lifecycleStatus: 2 } as const;
    // An Add-on has one Space per Site; the picture test may have made these already.
    const space = async (addonId: string) => (await pool.query<{ id: number }>(
      `SELECT id FROM phis.media_spaces WHERE site_id = $1 AND addon_id = $2`, [site.id, addonId],
    )).rows[0]?.id ?? createPhiTestAddonSpace(site, addonId);
    const picture = await createPhiTestAsset(site, "icon-picture", ready);
    const icon = await createPhiTestAsset(site, "icon-logo", ready);
    const own = await createPhiTestAsset(site, "icon-own", { ...ready, spaceId: await space(SUPPLIER) });
    const withIcon = await register("ico", { imageAssetId: picture, iconAssetId: icon });
    expect(withIcon.product).toMatchObject({ imageAssetId: picture, iconAssetId: icon, iconRevision: 1 });
    // The same draft again changes nothing; a new icon alone is a change.
    expect((await register("ico", { imageAssetId: picture, iconAssetId: icon })).outcome).toBe("unchanged");
    expect((await register("ico", { imageAssetId: picture, iconAssetId: own })).product).toMatchObject({ imageAssetId: picture, iconAssetId: own });
    await pool.query(`UPDATE phis.media_assets SET delivery_revision = 4 WHERE id = $1`, [own]);
    expect((await get(id(SUPPLIER, "ico")))!.iconRevision).toBe(4);

    const pending = await createPhiTestAsset(site, "icon-pending");
    const others = await createPhiTestAsset(site, "icon-other-addon", { ...ready, spaceId: await space(OTHER) });
    const userSpace = await createPhiTestAsset(site, "icon-user", { ...ready, spaceId: await createPhiTestUserSpace(site) });
    for (const refused of [pending, others, userSpace]) {
      await expect(register("ico", { imageAssetId: picture, iconAssetId: refused })).rejects.toThrow(/cannot be a product's icon/);
    }
    const elsewhere = await createPhiTestSite("products-icon-elsewhere");
    const foreign = await createPhiTestAsset(elsewhere, "icon-foreign", ready);
    await expect(register("ico", { iconAssetId: foreign })).rejects.toThrow(/not an Asset of this Site/);
    expect((await get(id(SUPPLIER, "ico")))!.iconAssetId).toBe(own);

    // The Media delete guard names a product that wears the Asset as its icon; deleting it clears the icon alone.
    expect(await listProductIdsWithImage(pool, site.id, own)).toEqual([id(SUPPLIER, "ico")]);
    await pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [own]);
    expect(await listProductIdsWithImage(pool, site.id, own)).toEqual([]);
    expect((await get(id(SUPPLIER, "ico")))).toMatchObject({ imageAssetId: picture, iconAssetId: null, iconRevision: null });
  });

  it("lists active products unless states are asked for, by supplier, publisher and release, in pages", async () => {
    const lister = await createPhiTestSite("products-list");
    await activatePhiTestAddonForSite(lister, SUPPLIER);
    const add = async (key: string, rest: Partial<PhisProductDraft> = {}, to: "draft" | "active" | "withdrawn" = "active") => {
      await registerProduct(pool, { siteId: lister.id, supplier: SUPPLIER, draft: draft(key, rest), listeners: [] });
      if (to !== "draft") {
        if (rest.publisher) await releaseProduct(pool, { siteId: lister.id, productId: id(SUPPLIER, key), listeners: [] });
        await setProductState(pool, { siteId: lister.id, supplier: SUPPLIER, key, state: to, listeners: [] });
      }
    };
    await add("l1");
    await add("l2", { type: "plan" });
    await add("l3", {}, "draft");
    await add("l4", { publisher: "p1" }, "withdrawn");
    await registerProduct(pool, { siteId: lister.id, supplier: SUPPLIER, draft: draft("l5", { publisher: "p1" }), listeners: [] });
    const base = { siteId: lister.id, cursor: null, limit: 50 };
    const keys = (page: { products: { id: string }[] }) => page.products.map((product) => product.id.slice(SUPPLIER.length + 1));

    expect(keys(await listProducts(pool, { ...base, states: ["active"] }))).toEqual(["l1", "l2"]);
    expect(keys(await listProducts(pool, { ...base, states: ["draft", "withdrawn"] }))).toEqual(["l3", "l4", "l5"]);
    expect(keys(await listProducts(pool, { ...base, states: ["active"], type: "plan" }))).toEqual(["l2"]);
    expect(keys(await listProducts(pool, { ...base, states: ["draft", "withdrawn"], publisher: "p1" }))).toEqual(["l4", "l5"]);
    expect(keys(await listProducts(pool, { ...base, states: ["draft", "withdrawn", "active"], released: false }))).toEqual(["l5"]);
    expect(keys(await listProducts(pool, { ...base, states: ["active"], supplier: OTHER }))).toEqual([]);

    const all: ("draft" | "active" | "withdrawn")[] = ["draft", "active", "withdrawn"];
    const first = await listProducts(pool, { ...base, states: all, limit: 2 });
    expect(keys(first)).toEqual(["l1", "l2"]);
    const second = await listProducts(pool, { ...base, states: all, limit: 2, cursor: first.nextCursor });
    expect(keys(second)).toEqual(["l3", "l4"]);
    const third = await listProducts(pool, { ...base, states: all, limit: 2, cursor: second.nextCursor });
    expect(keys(third)).toEqual(["l5"]);
    expect(third.nextCursor).toBeNull();
    await expect(listProducts(pool, { ...base, states: all, cursor: "garbage" })).rejects.toThrow(/cursor/);

    // Named products, in any state; an unknown id is simply missing.
    const named = await listProducts(pool, { ...base, states: [...all, "locked"], ids: [id(SUPPLIER, "l4"), id(SUPPLIER, "l1"), id(SUPPLIER, "nope")] });
    expect(keys(named)).toEqual(["l1", "l4"]);
  });

  it("pages the operator's directory by number, in every state, by supplier, release and a search, counted", async () => {
    const directory = await createPhiTestSite("products-directory");
    await activatePhiTestAddonForSite(directory, SUPPLIER);
    await activatePhiTestAddonForSite(directory, OTHER);
    const add = (supplier: string, key: string, rest: Partial<PhisProductDraft> = {}) =>
      registerProduct(pool, { siteId: directory.id, supplier, draft: draft(key, rest), listeners: [] });
    await add(SUPPLIER, "d-own", { title: "Studio Pro" });
    await add(SUPPLIER, "d-new", { publisher: "p1", title: "Plain 100%_off" });
    await add(SUPPLIER, "d-pending", { publisher: "p1" });
    await releaseProduct(pool, { siteId: directory.id, productId: id(SUPPLIER, "d-pending"), listeners: [] });
    await add(SUPPLIER, "d-pending", { publisher: "p1", free: true });
    await add(OTHER, "d-locked");
    await moveProductsAsOperator(pool, { siteId: directory.id, to: "locked", productId: id(OTHER, "d-locked"), listeners: [] });

    const every: ("draft" | "active" | "withdrawn" | "locked")[] = ["draft", "active", "withdrawn", "locked"];
    const read = (rest: Partial<Parameters<typeof listProductDirectory>[1]> = {}) =>
      listProductDirectory(pool, { siteId: directory.id, states: every, page: 1, pageSize: 25, ...rest });
    const ids = (result: { products: { id: string }[] }) => result.products.map((product) => product.id);

    // Ordered by supplier and key, not by when they came.
    expect(ids(await read())).toEqual([
      id(OTHER, "d-locked"), id(SUPPLIER, "d-new"), id(SUPPLIER, "d-own"), id(SUPPLIER, "d-pending"),
    ]);
    expect((await read()).total).toBe(4);
    expect(ids(await read({ states: ["locked"] }))).toEqual([id(OTHER, "d-locked")]);
    expect(ids(await read({ supplier: OTHER }))).toEqual([id(OTHER, "d-locked")]);

    // Waiting for a release: never released, or released with terms pending -- the same rows as `released: false`.
    expect(ids(await read({ awaitingRelease: true }))).toEqual([id(SUPPLIER, "d-new"), id(SUPPLIER, "d-pending")]);
    expect(ids(await read({ awaitingRelease: false }))).toEqual([id(OTHER, "d-locked"), id(SUPPLIER, "d-own")]);
    const released = await listProducts(pool, { siteId: directory.id, states: every, cursor: null, limit: 50, released: false });
    expect(ids(released).sort()).toEqual(ids(await read({ awaitingRelease: true })).sort());
    expect((await read({ awaitingRelease: true })).products[1]!.pendingTerms).toMatchObject({ free: true });

    // The search reads the title and the id, any case, and takes `%` and `_` as themselves.
    expect(ids(await read({ search: "studio pro" }))).toEqual([id(SUPPLIER, "d-own")]);
    expect(ids(await read({ search: `${OTHER}:d-` }))).toEqual([id(OTHER, "d-locked")]);
    expect(ids(await read({ search: "100%_" }))).toEqual([id(SUPPLIER, "d-new")]);
    expect(ids(await read({ search: "%" }))).toEqual([id(SUPPLIER, "d-new")]);

    // Pages by number, the count beside every page and past the last one too.
    const second = await read({ page: 2, pageSize: 3 });
    expect(ids(second)).toEqual([id(SUPPLIER, "d-pending")]);
    expect(second.total).toBe(4);
    const beyond = await read({ page: 5, pageSize: 3 });
    expect(beyond).toEqual({ products: [], total: 4 });
    expect(await read({ supplier: "@pgtest/nobody" })).toEqual({ products: [], total: 0 });

    // The picture and the icon come joined, with what an address of one of their variants is built from.
    const picture = await createPhiTestAsset(directory, "directory-picture", { lifecycleStatus: 2 });
    const icon = await createPhiTestAsset(directory, "directory-icon", { lifecycleStatus: 2 });
    await add(SUPPLIER, "d-own", { title: "Studio Pro", imageAssetId: picture, iconAssetId: icon });
    await pool.query(`UPDATE phis.media_assets SET variant_version = 3, delivery_revision = 2 WHERE id = $1`, [picture]);
    await pool.query(`UPDATE phis.media_assets SET content_type = 'application/pdf' WHERE id = $1`, [icon]);
    const [own] = (await read({ search: "studio pro" })).products;
    expect(own).toMatchObject({
      imageAssetId: picture,
      imageMedia: { id: picture, deliveryRevision: 2, variantVersion: 3, contentType: "image/png" },
      iconMedia: { id: icon, deliveryRevision: 1, variantVersion: null, contentType: "application/pdf" },
    });
    expect((await read({ states: ["locked"] })).products[0]).toMatchObject({ imageMedia: null, iconMedia: null });
    // One product read the same way, for the answer to an act on it.
    expect(await readProductDirectoryEntry(pool, directory.id, id(SUPPLIER, "d-own"))).toEqual(own);
    expect(await readProductDirectoryEntry(pool, directory.id, id(SUPPLIER, "d-nope"))).toBeNull();
    // Gone with its Asset, like the product's own reference.
    await pool.query(`DELETE FROM phis.media_assets WHERE id = $1`, [icon]);
    expect((await read({ search: "studio pro" })).products[0]).toMatchObject({ iconMedia: null, iconAssetId: null });
  });

  it("withdraws a supplier's active products when it is switched off, restores exactly those, and keeps entries", async () => {
    const supplier = "@pgtest/prod-flicker";
    await activatePhiTestAddonForSite(site, supplier);
    await switchSupplier(supplier, true);
    const add = (key: string, to?: "active" | "draft" | "withdrawn") => registerProduct(pool, { siteId: site.id, supplier, draft: draft(key), listeners: [] })
      .then(() => to ? setProductState(pool, { siteId: site.id, supplier, key, state: to, listeners: [] }) : null);
    await add("f-active", "active");
    await add("f-draft", "draft");
    await add("f-operator", "active");
    await moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", productId: id(supplier, "f-operator"), listeners: [] });
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: id(supplier, "f-active"), source: SHOP, reference: "f-1",
      startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    });
    expect((await get(id(supplier, "f-active")))!.supplied).toBe(true);
    // Nothing to do while the supplier is on.
    expect(await reconcileProductSupply(pool, listeners, site.id)).toEqual([]);

    await clearOutbox();
    await switchSupplier(supplier, false);
    expect((await get(id(supplier, "f-active")))!.supplied).toBe(false);
    const lost = await reconcileProductSupply(pool, listeners, site.id);
    expect(lost).toEqual([{ siteId: site.id, id: id(supplier, "f-active"), to: "withdrawn" }]);
    expect((await get(id(supplier, "f-active")))).toMatchObject({ state: "withdrawn", supplied: false });
    expect((await get(id(supplier, "f-draft")))!.state).toBe("draft");
    expect((await outbox()).map((row) => row.payload.productId)).toEqual([id(supplier, "f-active")]);
    expect(await reconcileProductSupply(pool, listeners, site.id)).toEqual([]);
    // Product and entry stay.
    const { rows: entries } = await pool.query(`SELECT 1 FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, id(supplier, "f-active")]);
    expect(entries).toHaveLength(1);

    // A globally disabled Add-on is off as well, however the Site asked.
    await pool.query(`UPDATE phis.site_server_addons SET flags = 1 WHERE site_id = $1 AND addon_id = $2`, [site.id, supplier]);
    expect(await reconcileProductSupply(pool, listeners, site.id)).toEqual([]);
    expect((await get(id(supplier, "f-active")))!.supplied).toBe(false);

    await clearOutbox();
    await switchSupplier(supplier, true);
    const back = await reconcileProductSupply(pool, listeners, site.id);
    expect(back).toEqual([{ siteId: site.id, id: id(supplier, "f-active"), to: "active" }]);
    expect((await get(id(supplier, "f-active")))).toMatchObject({ state: "active", supplied: true });
    // What the operator withdrew stays withdrawn, and a draft stays a draft.
    expect((await get(id(supplier, "f-operator")))!.state).toBe("withdrawn");
    expect((await get(id(supplier, "f-draft")))!.state).toBe("draft");
    expect((await outbox())).toHaveLength(1);
  });

  it("registers manifest products as active, reconciles existing ones, and withdraws what a manifest dropped", async () => {
    const supplier = "@pgtest/prod-manifest";
    const sync = (declared: PhisProductDraft[], recipients: readonly string[] = []) => syncManifestProducts(pool, {
      siteId: site.id, supplier, declared: declared.map((entry) => normalizePhisProductDraft(entry, id(supplier, entry.key))), listeners: recipients,
    });
    const entry = (key: string, rest: Partial<PhisProductDraft> = {}): PhisProductDraft => ({ key, type: "addon", title: `T ${key}`, summary: "S", ...rest });
    await activatePhiTestAddonForSite(site, supplier);
    await switchSupplier(supplier, true);

    await clearOutbox();
    // The bundle is declared before its part and still registers, parts first.
    const first = await sync([entry("m-bundle", { parts: [id(supplier, "m-part")] }), entry("m-part"), entry("m-gone")], listeners);
    expect(first.map((a) => `${a.key}:${a.action}`).sort()).toEqual(["m-bundle:created", "m-gone:created", "m-part:created"]);
    expect((await get(id(supplier, "m-part")))).toMatchObject({ state: "active", publisher: null, released: true });
    expect((await get(id(supplier, "m-bundle")))!.parts).toEqual([id(supplier, "m-part")]);
    expect((await outbox()).length).toBe(3);

    // Run twice: nothing changes. A changed declaration reconciles the details and leaves the state.
    await clearOutbox();
    expect((await sync([entry("m-bundle", { parts: [id(supplier, "m-part")] }), entry("m-part"), entry("m-gone")], listeners)).every((a) => a.action === "unchanged")).toBe(true);
    expect(await outbox()).toHaveLength(0);
    await state("m-part", "withdrawn", supplier);
    const second = await sync([entry("m-bundle", { parts: [id(supplier, "m-part")] }), entry("m-part", { title: "Renamed" }), entry("m-new", { free: true })], listeners);
    expect(Object.fromEntries(second.map((a) => [a.key, a.action]))).toEqual({
      "m-bundle": "unchanged", "m-part": "updated", "m-new": "created", "m-gone": "withdrawn",
    });
    expect((await get(id(supplier, "m-part")))).toMatchObject({ title: "Renamed", state: "withdrawn" });
    expect((await get(id(supplier, "m-new")))).toMatchObject({ state: "active", free: true, accountRequired: false });
    await sync([entry("m-bundle", { parts: [id(supplier, "m-part")] }), entry("m-part", { title: "Renamed" }), entry("m-new", { free: true, accountRequired: true })]);
    expect((await get(id(supplier, "m-new")))!.accountRequired).toBe(true);
    // Withdrawn, not removed.
    expect((await get(id(supplier, "m-gone")))).toMatchObject({ state: "withdrawn" });

    // A product the supplier made at runtime is not the manifest's to withdraw.
    await registerProduct(pool, { siteId: site.id, supplier, draft: draft("runtime"), listeners: [] });
    await setProductState(pool, { siteId: site.id, supplier, key: "runtime", state: "active", listeners: [] });
    await sync([]);
    expect((await get(id(supplier, "runtime")))!.state).toBe("active");
    expect((await get(id(supplier, "m-new")))!.state).toBe("withdrawn");

    // A declaration that breaks a rule is reported and does not stop the others.
    const mixed = await sync([entry("m-ok"), entry("m-bad", { parts: [id(supplier, "nowhere")] })]);
    expect(Object.fromEntries(mixed.map((a) => [a.key, a.action]))).toMatchObject({ "m-ok": "created", "m-bad": "refused" });
  });

  it("leaves a picture and an icon set on a declared product alone: the manifest never names one", async () => {
    const supplier = "@pgtest/prod-manifest-image";
    await activatePhiTestAddonForSite(site, supplier);
    await switchSupplier(supplier, true);
    const sync = (title: string, recipients: readonly string[] = []) => syncManifestProducts(pool, {
      siteId: site.id, supplier, listeners: recipients,
      declared: [normalizePhisProductDraft({ key: "shop", type: "addon", title, summary: "S" }, id(supplier, "shop"))],
    });
    expect((await sync("Shop"))[0]!.action).toBe("created");
    expect((await get(id(supplier, "shop")))!.imageAssetId).toBeNull();
    const cover = await createPhiTestAsset(site, "manifest-cover", { lifecycleStatus: 2 });
    const logo = await createPhiTestAsset(site, "manifest-logo", { lifecycleStatus: 2 });
    await registerProduct(pool, {
      siteId: site.id, supplier, listeners: [],
      draft: draft("shop", { type: "addon", title: "Shop", summary: "S", imageAssetId: cover, iconAssetId: logo }),
    });
    const before = (await get(id(supplier, "shop")))!;
    expect(before).toMatchObject({ imageAssetId: cover, iconAssetId: logo });

    // No change: the picture stays, the version stays, nothing is owed.
    await clearOutbox();
    expect((await sync("Shop", listeners))[0]!.action).toBe("unchanged");
    expect(await outbox()).toHaveLength(0);
    expect((await get(id(supplier, "shop")))).toMatchObject({ imageAssetId: cover, iconAssetId: logo, version: before.version });
    // The manifest is the statement of the title; the picture still stays.
    expect((await sync("Renamed", listeners))[0]!.action).toBe("updated");
    expect((await get(id(supplier, "shop")))).toMatchObject({ title: "Renamed", imageAssetId: cover, iconAssetId: logo, version: before.version + 1 });
    expect(await outbox()).toHaveLength(1);
  });

  it("owes product.changed to the ready listeners for each kind of change, and for nothing that changed nothing", async () => {
    const supplier = "@pgtest/prod-events";
    await activatePhiTestAddonForSite(site, supplier);
    await switchSupplier(supplier, true);
    const productId = id(supplier, "ev");
    const count = async () => (await outbox()).filter((row) => row.payload.productId === productId).length;
    const steps: [string, () => Promise<unknown>][] = [
      ["registered", () => registerProduct(pool, { siteId: site.id, supplier, draft: draft("ev", { publisher: "acme" }), listeners })],
      ["changed", () => registerProduct(pool, { siteId: site.id, supplier, draft: draft("ev", { publisher: "acme", title: "New" }), listeners })],
      ["released", () => releaseProduct(pool, { siteId: site.id, productId, listeners })],
      ["state changed", () => setProductState(pool, { siteId: site.id, supplier, key: "ev", state: "active", listeners })],
      ["operator withdrew", () => moveProductsAsOperator(pool, { siteId: site.id, to: "withdrawn", productId, listeners })],
      ["operator locked", () => moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId, listeners })],
      ["operator unlocked", () => moveProductsAsOperator(pool, { siteId: site.id, to: "unlocked", productId, listeners })],
      ["annotated", () => annotateProduct(pool, { siteId: site.id, productId, addonId: SHOP, data: { a: 1 }, listeners })],
    ];
    await clearOutbox();
    let expected = 0;
    for (const [label, run] of steps) {
      await run();
      expected += 1;
      expect(await count(), label).toBe(expected);
    }
    // Lost and regained supplier.
    await setProductState(pool, { siteId: site.id, supplier, key: "ev", state: "active", listeners });
    expected += 1;
    await switchSupplier(supplier, false);
    await reconcileProductSupply(pool, listeners, site.id);
    await switchSupplier(supplier, true);
    await reconcileProductSupply(pool, listeners, site.id);
    expect(await count()).toBe(expected + 2);

    // Nothing that changed nothing, and nothing for a listener that is not ready.
    await registerProduct(pool, { siteId: site.id, supplier, draft: draft("ev", { publisher: "acme", title: "New" }), listeners });
    await annotateProduct(pool, { siteId: site.id, productId, addonId: SHOP, data: { a: 1 }, listeners });
    expect(await count()).toBe(expected + 2);
    const rows = (await outbox()).filter((row) => row.payload.productId === productId);
    expect(rows.every((row) => row.addon_id === READY && row.subject_kind === "product")).toBe(true);
  });
});
