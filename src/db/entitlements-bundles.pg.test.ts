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
  findEntitlementSubject,
  grantEntitlement,
  listEntitlements,
  readEntitlementState,
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
});
