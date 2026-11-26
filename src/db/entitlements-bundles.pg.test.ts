import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import type { PhisProductId } from "@phis/contracts/products";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  announceEndedEntitlements,
  ensureEntitlementSubject,
  ensureMemberEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  listEntitlements,
  readEntitlementState,
  readEntitlementStates,
  redeliverEntitlementChanged,
  updateEntitlement,
} from "./entitlements.mts";
import { moveProductsAsOperator, registerProduct, setProductState } from "./products.mts";
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";

const configured = process.env.PHIS_PG_TEST === "1";

/** Parts and bundles of different suppliers, as a Site's directory has them. */
const PARTS = "@pgtest/bundle-parts";
const BUNDLES = "@pgtest/bundle-sets";
const SHOP = "@pgtest/bundle-shop";
const LISTENER = "@pgtest/bundle-listener";
/** A second Add-on that listens too, and must hear nothing of another's redelivery. */
const BYSTANDER = "@pgtest/bundle-bystander";

const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString();

/**
 * Whoever holds a bundle holds each of its parts, for Core: the answer for a part reads the entries on
 * every bundle that contains it, a locked product passes nothing on, and an entry on a bundle owes the
 * parts their event. See SERVER_ADDONS.md, entitlements:v1.
 */
describe.skipIf(!configured)("entitlements through bundles", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let seq = 0;

  /** A product of the Site, active, with the parts given (a bundle) or none. */
  async function product(supplier: string, input: { parts?: PhisProductId[]; counted?: boolean } = {}) {
    seq += 1;
    const key = `p${seq}`;
    await registerProduct(pool, {
      siteId: site.id, supplier, listeners: [],
      draft: normalizePhisProductDraft({ key, type: "licence", title: key, summary: "", counted: input.counted === true, parts: input.parts ?? [] }),
    });
    await setProductState(pool, { siteId: site.id, supplier, key, state: "active", listeners: [] });
    return `${supplier}:${key}` as PhisProductId;
  }

  /** A fresh person, so that the entries of one case do not count in another. */
  async function person() {
    const subject = await ensureEntitlementSubject(pool, site.id, await createPhiTestUser(site));
    const subjectId = (await findEntitlementSubject(pool, site.id, subject))!.id;
    return {
      subject,
      subjectId,
      state: (id: PhisProductId) => readEntitlementState(pool, { siteId: site.id, subjectId, product: id }),
      grant: async (id: PhisProductId, input: { endsAt?: string | null; startsAt?: string | null; quantity?: number | null; counted?: boolean; listeners?: string[]; reference?: string } = {}) =>
        (await grantEntitlement(pool, {
          siteId: site.id, subjectId, product: id, source: SHOP, reference: input.reference ?? `order-${(seq += 1)}`,
          startsAt: input.startsAt ?? null, endsAt: input.endsAt ?? null, quantity: input.quantity ?? null,
          counted: input.counted ?? false, listeners: input.listeners ?? [],
        }))!,
    };
  }

  async function outboxOf(subject: string) {
    const { rows } = await pool.query<{ addon_id: string; payload: { subject: string; product: string } }>(
      `SELECT addon_id, payload FROM phis.addon_event_outbox
       WHERE site_id = $1 AND event = 'entitlement.changed' AND payload->>'subject' = $2 ORDER BY id`,
      [site.id, subject],
    );
    return rows;
  }

  const clearOutbox = () => pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("entitlement-bundles");
    await enablePhiTestAddonForSite(site, LISTENER);
    await enablePhiTestAddonForSite(site, BYSTANDER);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("entitles a part through an entry on the bundle, and names the bundle in via", async () => {
    const part = await product(PARTS);
    const other = await product(PARTS);
    const bundle = await product(BUNDLES, { parts: [part] });
    const someone = await person();
    await someone.grant(bundle);

    expect(await someone.state(part)).toEqual({ product: part, entitled: true, quantity: null, until: null, via: [bundle] });
    expect(await someone.state(bundle)).toEqual({ product: bundle, entitled: true, quantity: null, until: null, via: [bundle] });
    // What the bundle does not contain it does not give.
    expect(await someone.state(other)).toEqual({ product: other, entitled: false, quantity: null, until: null, via: [] });
    // Nobody else holds it.
    expect((await (await person()).state(part)).entitled).toBe(false);
  });

  it("names the product first and then every bundle it is held through", async () => {
    const part = await product(PARTS);
    const first = await product(BUNDLES, { parts: [part] });
    const second = await product(BUNDLES, { parts: [part] });
    const someone = await person();
    await someone.grant(second);
    await someone.grant(first);
    await someone.grant(part);
    expect((await someone.state(part)).via).toEqual([part, ...[first, second].sort()]);
  });

  it("resolves a bundle inside a bundle", async () => {
    const part = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [part] });
    const outer = await product(BUNDLES, { parts: [inner] });
    const someone = await person();
    await someone.grant(outer);
    expect(await someone.state(part)).toMatchObject({ entitled: true, via: [outer] });
    expect(await someone.state(inner)).toMatchObject({ entitled: true, via: [outer] });
  });

  it("passes nothing on through a locked product: a locked part, a locked bundle, a locked bundle inside another", async () => {
    const part = await product(PARTS);
    const bundle = await product(BUNDLES, { parts: [part] });
    const someone = await person();
    await someone.grant(bundle);
    expect((await someone.state(part)).entitled).toBe(true);

    // A locked part is held through no bundle; the bundle itself still is.
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: part, listeners: [] });
    expect(await someone.state(part)).toEqual({ product: part, entitled: false, quantity: null, until: null, via: [] });
    expect((await someone.state(bundle)).entitled).toBe(true);
    await moveProductsAsOperator(pool, { siteId: site.id, to: "unlocked", productId: part, listeners: [] });
    expect((await someone.state(part)).entitled).toBe(true);

    // A locked bundle gives none of its parts, also when it is held inside another bundle.
    const nestedPart = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [nestedPart] });
    const outer = await product(BUNDLES, { parts: [inner] });
    await someone.grant(outer);
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: bundle, listeners: [] });
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: inner, listeners: [] });
    expect((await someone.state(part)).entitled).toBe(false);
    expect((await someone.state(nestedPart)).entitled).toBe(false);
    expect((await someone.state(outer)).entitled).toBe(true);
  });

  it("answers several products in one read as each one's own read answers it, in the order asked", async () => {
    const part = await product(PARTS);
    const seats = await product(PARTS, { counted: true });
    const lockedPart = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [part, lockedPart] });
    const outer = await product(BUNDLES, { parts: [inner] });
    const unheld = await product(PARTS);
    const someone = await person();
    await someone.grant(outer, { endsAt: hours(4) });
    await someone.grant(part, { endsAt: hours(2) });
    await someone.grant(seats, { quantity: 3, counted: true });
    await someone.grant(seats, { quantity: 2, counted: true });
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: lockedPart, listeners: [] });

    const missing = `${PARTS}:nobody` as PhisProductId;
    const asked = [seats, part, lockedPart, inner, missing, unheld, part, outer];
    const many = await readEntitlementStates(pool, { siteId: site.id, subjectId: someone.subjectId, products: asked });
    expect(many).toEqual(await Promise.all(asked.map((id) => someone.state(id))));
    expect(many.map((answer) => answer.product)).toEqual(asked);
    expect(many[0]).toMatchObject({ entitled: true, quantity: 5 });
    expect(many[1]).toMatchObject({ entitled: true, via: [part, outer] });
    expect(many[2]!.entitled).toBe(false);
    expect(many[4]!.entitled).toBe(false);

    // Nobody to ask for, and nothing asked: no read, every answer no.
    expect(await readEntitlementStates(pool, { siteId: site.id, subjectId: null, products: [part] }))
      .toEqual([{ product: part, entitled: false, quantity: null, until: null, via: [] }]);
    expect(await readEntitlementStates(pool, { siteId: site.id, subjectId: someone.subjectId, products: [] })).toEqual([]);
  });

  it("issues a member's subject for staff on first asking, the one the member has, and none to a non-member", async () => {
    const member = await createPhiTestUser(site);
    const issued = await ensureMemberEntitlementSubject(pool, site.id, member);
    expect(issued).toMatch(/^sub_[0-9a-z]{24}$/);
    expect(await ensureEntitlementSubject(pool, site.id, member)).toBe(issued);
    expect(await ensureMemberEntitlementSubject(pool, site.id, member)).toBe(issued);

    const elsewhere = await createPhiTestSite("entitlement-bundles-elsewhere");
    const stranger = await createPhiTestUser(elsewhere);
    expect(await ensureMemberEntitlementSubject(pool, site.id, stranger)).toBeNull();
    const { rowCount } = await pool.query(`SELECT 1 FROM phis.entitlement_subjects WHERE site_id = $1 AND user_id = $2`, [site.id, stranger]);
    expect(rowCount).toBe(0);
    expect(await ensureMemberEntitlementSubject(pool, site.id, 2_000_000_000)).toBeNull();
  });

  it("answers until over the product's and its bundles' entries, null as soon as one has no end", async () => {
    const part = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [part] });
    const outer = await product(BUNDLES, { parts: [inner] });
    const someone = await person();
    const soon = hours(5);
    const later = hours(10);
    await someone.grant(part, { endsAt: soon });
    await someone.grant(inner, { endsAt: later });
    // An ended entry on a bundle neither entitles nor moves the end.
    await someone.grant(outer, { startsAt: hours(-3), endsAt: hours(-1) });
    expect(await someone.state(part)).toMatchObject({ entitled: true, until: new Date(later).toISOString(), via: [part, inner] });

    await someone.grant(outer);
    expect(await someone.state(part)).toMatchObject({ entitled: true, until: null, via: [part, inner, outer] });
  });

  it("counts only the product's own entries: held through a bundle alone, a counted product has 0", async () => {
    const seats = await product(PARTS, { counted: true });
    const bundle = await product(BUNDLES, { parts: [seats] });
    const someone = await person();
    await someone.grant(bundle);
    expect(await someone.state(seats)).toEqual({ product: seats, entitled: true, quantity: 0, until: null, via: [bundle] });
    await someone.grant(seats, { counted: true, quantity: 3 });
    await someone.grant(seats, { counted: true, quantity: 2 });
    expect(await someone.state(seats)).toMatchObject({ entitled: true, quantity: 5, via: [seats, bundle] });
    // The bundle itself is not counted.
    expect((await someone.state(bundle)).quantity).toBeNull();
  });

  it("lists the entries on the bundles of a product with resolveBundles, each as it is, valid or not", async () => {
    const part = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [part] });
    const outer = await product(BUNDLES, { parts: [inner] });
    const unrelated = await product(BUNDLES);
    const someone = await person();
    const own = await someone.grant(part);
    const viaInner = await someone.grant(inner);
    const viaOuter = await someone.grant(outer);
    await someone.grant(unrelated);
    // Another person's entry on the bundle is not theirs.
    await (await person()).grant(inner);
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: outer, listeners: [] });

    const plain = await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId, product: part });
    expect(plain.map((entry) => entry.id)).toEqual([own.id]);
    expect(await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId, product: part, resolveBundles: false })).toEqual(plain);

    const resolved = await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId, product: part, resolveBundles: true });
    expect(resolved.map((entry) => [entry.id, entry.product, entry.valid])).toEqual([
      [own.id, part, true], [viaInner.id, inner, true], [viaOuter.id, outer, false],
    ]);
    // Without a product there is nothing to resolve: every entry of the subject is listed already.
    expect(await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId, resolveBundles: true }))
      .toEqual(await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId }));
  });

  it("lists the entries of several subjects in one statement, narrowed and resolved as for one", async () => {
    const part = await product(PARTS);
    const bundle = await product(BUNDLES, { parts: [part] });
    const other = await product(PARTS);
    const first = await person();
    const second = await person();
    const outsider = await person();
    const a = await first.grant(part);
    const b = await second.grant(bundle);
    const c = await second.grant(other);
    await outsider.grant(part);

    const both = [first.subject, second.subject, "sub_nobody_here"];
    const all = await listEntitlements(pool, { siteId: site.id, subjectReferences: both });
    expect(all.map((entry) => [entry.id, entry.subject])).toEqual([[a.id, first.subject], [b.id, second.subject], [c.id, second.subject]]);
    expect((await listEntitlements(pool, { siteId: site.id, subjectReferences: both, product: part })).map((entry) => entry.id)).toEqual([a.id]);
    expect((await listEntitlements(pool, { siteId: site.id, subjectReferences: both, product: part, resolveBundles: true })).map((entry) => entry.id))
      .toEqual([a.id, b.id]);
  });

  it("reads one entry past the bound, so a longer listing can be refused and not cut", async () => {
    const part = await product(PARTS);
    const someone = await person();
    // Written in one statement: 501 entries of one source and product, references apart.
    await pool.query(
      `INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference, starts_at, flags)
       SELECT $1, $2, $3, $4, 'bulk-' || n, NOW(), 0 FROM generate_series(1, 501) n`,
      [site.id, someone.subjectId, part, SHOP],
    );
    expect(await listEntitlements(pool, { siteId: site.id, subjectId: someone.subjectId })).toHaveLength(501);
    expect(await listEntitlements(pool, { siteId: site.id, subjectReferences: [someone.subject] })).toHaveLength(501);
  });

  it("owes each part, through nested bundles, its event when an entry on the bundle is written or taken back", async () => {
    const part = await product(PARTS);
    const inner = await product(BUNDLES, { parts: [part] });
    const outer = await product(BUNDLES, { parts: [inner, part] });
    const someone = await person();
    await clearOutbox();
    const entry = await someone.grant(outer, { listeners: [LISTENER], reference: "bundle-order" });
    const products = async () => (await outboxOf(someone.subject)).map((row) => [row.addon_id, row.payload.product]);
    // The product that changed first; each part once, though `part` is reached twice.
    expect(await products()).toEqual([outer, ...[inner, part].sort()].map((id) => [LISTENER, id]));

    await clearOutbox();
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: outer, reference: entry.reference, revoke: true, listeners: [LISTENER] });
    expect((await products()).map(([, id]) => id).sort()).toEqual([outer, inner, part].sort());
    expect(await someone.state(part)).toMatchObject({ entitled: false, via: [] });

    // A product that is nobody's bundle owes its own event only.
    await clearOutbox();
    const lone = await product(PARTS);
    await someone.grant(lone, { listeners: [LISTENER] });
    expect(await products()).toEqual([[LISTENER, lone]]);
  });

  it("owes the parts of ended bundle entries their event once, however many of the entries reach them", async () => {
    const part = await product(PARTS);
    const first = await product(BUNDLES, { parts: [part] });
    const second = await product(BUNDLES, { parts: [part] });
    const someone = await person();
    await someone.grant(first, { startsAt: hours(-4), endsAt: hours(-2) });
    await someone.grant(second, { startsAt: hours(-4), endsAt: hours(-1) });
    await someone.grant(part, { startsAt: hours(-4), endsAt: hours(-1) });
    await clearOutbox();

    expect(await announceEndedEntitlements(pool, [LISTENER])).toContain(site.id);
    const ended = (await outboxOf(someone.subject)).map((row) => row.payload.product);
    expect([...ended].sort()).toEqual([first, second, part].sort());

    await clearOutbox();
    await announceEndedEntitlements(pool, [LISTENER]);
    expect(await outboxOf(someone.subject)).toHaveLength(0);
  });

  describe("redelivery", () => {
    const redeliver = (id: PhisProductId, addonId = LISTENER) =>
      redeliverEntitlementChanged(pool, { siteId: site.id, addonId, product: id });

    async function redelivered(id: PhisProductId) {
      const { rows } = await pool.query<{ addon_id: string; subject: string; product: string; redelivery: string | null }>(
        `SELECT addon_id, payload->>'subject' AS subject, payload->>'product' AS product, payload->>'redelivery' AS redelivery
         FROM phis.addon_event_outbox
         WHERE site_id = $1 AND event = 'entitlement.changed' AND payload->>'product' = $2 ORDER BY id`,
        [site.id, id],
      );
      return rows;
    }

    it("owes the calling Add-on alone one event per current holder, directly or through nested bundles, naming the product", async () => {
      const part = await product(PARTS);
      const inner = await product(BUNDLES, { parts: [part] });
      const outer = await product(BUNDLES, { parts: [inner] });
      const direct = await person();
      const throughBundle = await person();
      const both = await person();
      const revoked = await person();
      const ended = await person();
      const nobody = await person();
      await direct.grant(part);
      await throughBundle.grant(outer);
      await both.grant(part);
      await both.grant(inner);
      const taken = await revoked.grant(part);
      await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: part, reference: taken.reference, revoke: true, listeners: [] });
      await ended.grant(part, { startsAt: hours(-2), endsAt: hours(-1) });
      await clearOutbox();

      expect(await redeliver(part)).toBe(3);
      const rows = await redelivered(part);
      expect(rows.map((row) => row.subject).sort()).toEqual([direct.subject, throughBundle.subject, both.subject].sort());
      expect(new Set(rows.map((row) => row.addon_id))).toEqual(new Set([LISTENER]));
      expect(rows.every((row) => row.product === part && typeof row.redelivery === "string")).toBe(true);
      expect(rows.map((row) => row.subject)).not.toContain(nobody.subject);
    });

    it("queues nothing new while the first call is still owed, and again once it was delivered", async () => {
      const part = await product(PARTS);
      const someone = await person();
      await someone.grant(part);
      await clearOutbox();
      // An ordinary change that is still owed does not stand in for a redelivery.
      await someone.grant(part, { listeners: [LISTENER] });

      expect(await redeliver(part)).toBe(1);
      expect(await redeliver(part)).toBe(0);
      expect(await Promise.all([redeliver(part), redeliver(part)])).toEqual([0, 0]);
      // Another Add-on's own redelivery is its own question.
      expect(await redeliver(part, BYSTANDER)).toBe(1);

      await pool.query(
        `UPDATE phis.addon_event_outbox SET delivered_at = NOW() WHERE site_id = $1 AND addon_id = $2 AND payload ? 'redelivery'`,
        [site.id, LISTENER],
      );
      // Two calls at once take turns: one queues, the other finds it owed.
      expect((await Promise.all([redeliver(part), redeliver(part)])).sort()).toEqual([0, 1]);
      expect((await redelivered(part)).filter((row) => row.addon_id === LISTENER && row.redelivery)).toHaveLength(2);
    });

    it("answers 0 for a locked product, one the Site lacks, and an Add-on not configured on the Site", async () => {
      const part = await product(PARTS);
      const someone = await person();
      await someone.grant(part);
      await clearOutbox();
      expect(await redeliver(part, "@pgtest/bundle-absent")).toBe(0);
      await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: part, listeners: [] });
      expect(await redeliver(part)).toBe(0);
      expect(await redeliver(`${PARTS}:missing` as PhisProductId)).toBe(0);
      expect(await redelivered(part)).toHaveLength(0);
    });
  });
});
