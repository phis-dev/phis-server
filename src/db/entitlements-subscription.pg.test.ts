import { randomUUID } from "node:crypto";
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
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";
import type { PhisStoredPaymentSubscription } from "../lib/payments/types.ts";
import {
  announceEndedEntitlements,
  ensureEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  isSubscriptionOfAddon,
  listEntitlements,
  listNamedEntitlements,
  readEntitlementState,
  updateEntitlement,
} from "./entitlements.mts";
import { writePhisPaymentSubscription } from "./payment-subscriptions.mts";
import { registerProduct, setProductState } from "./products.mts";

const configured = process.env.PHIS_PG_TEST === "1";

const SUPPLIER = "@pgtest/sub-supplier";
const SHOP = "@pgtest/sub-shop";
const OTHER = "@pgtest/sub-other";
const LISTENER = "@pgtest/sub-listener";
const PRODUCT = `${SUPPLIER}:plan` as PhisProductId;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
/** The instant a bound entry stops counting: its shown end plus the grace. */
const plus = (iso: string, offsetMs: number) => new Date(Date.parse(iso) + offsetMs).toISOString();

/**
 * An entitlement entry that follows a subscription of payments:v1: what it answers is derived from the
 * subscription's record on every read, with the subscription's own grace (`graceDays`), and never written.
 */
describe.skipIf(!configured)("entitlements bound to a subscription", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let subject: string;
  let subjectId: number;
  let seq = 0;

  let grace = 14;
  /** The grace of the subscriptions written from now on, and of every one of this Site written so far. */
  async function setGrace(days: number) {
    grace = days;
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{graceDays}', to_jsonb($2::int)) WHERE site_id = $1`, [site.id, days]);
  }

  const record = (id: string, input: { status?: string; periodEnd?: string | null; endedAt?: string | null; graceDays?: number }) => ({
    id, reference: `ref-${id}`, profileKey: "sub", status: input.status ?? "active", version: 1, nextChargeAt: null, flags: 0,
    collection: { mode: "automatic", dunning: { retryAfterDays: [] } }, graceDays: input.graceDays ?? grace, term: null, pendingChange: null,
    period: input.periodEnd === undefined || input.periodEnd === null ? null
      : { index: 0, startsAt: new Date(Date.parse(input.periodEnd) - 30 * DAY).toISOString(), endsAt: input.periodEnd },
    endedAt: input.endedAt ?? null,
  });

  async function subscription(input: { status?: string; periodEnd?: string | null; endedAt?: string | null; graceDays?: number }, consumer = SHOP) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO phis.payment_subscriptions (id, site_id, consumer_addon_id, profile_key, idempotency_key, request, record)
       VALUES ($1::uuid, $2, $3, 'sub', $1::text, '{}'::jsonb, $4::jsonb)`,
      [id, site.id, consumer, JSON.stringify(record(id, input))],
    );
    return id;
  }

  /** Changes the subscription the way payments does: through its one write. */
  async function change(id: string, input: { status?: string; periodEnd?: string | null; endedAt?: string | null }, listeners: string[] = [LISTENER]) {
    const stored = { siteId: site.id, consumerAddonId: SHOP, record: record(id, input), request: {}, anchorAt: null, termFirstIndex: 0, leaseToken: null } as unknown as PhisStoredPaymentSubscription;
    const client = await pool.connect();
    try { await writePhisPaymentSubscription(client, stored, null, () => listeners); } finally { client.release(); }
  }

  async function bound(subscriptionId: string | null, extra: { endsAt?: string | null; reference?: string } = {}) {
    seq += 1;
    return (await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: PRODUCT, source: SHOP, reference: extra.reference ?? `bound-${seq}`,
      startsAt: null, endsAt: extra.endsAt ?? null, quantity: null, counted: false, subscriptionId, listeners: [],
    }))!;
  }

  /** The state of a product with exactly one bound entry: its own product, so entries do not mix. */
  async function lone(input: { status?: string; periodEnd?: string | null; endedAt?: string | null; graceDays?: number }) {
    seq += 1;
    const key = `lone-${seq}`;
    await registerProduct(pool, { siteId: site.id, supplier: SUPPLIER, listeners: [], draft: normalizePhisProductDraft({ key, type: "plan", title: key, summary: "" }) });
    await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key, state: "active", listeners: [] });
    const product = `${SUPPLIER}:${key}` as PhisProductId;
    const id = await subscription(input);
    const entry = (await grantEntitlement(pool, {
      siteId: site.id, subjectId, product, source: SHOP, reference: key, startsAt: null, endsAt: null, quantity: null, counted: false, subscriptionId: id, listeners: [],
    }))!;
    const read = async () => ({
      entry: (await listEntitlements(pool, { siteId: site.id, subjectId, product }))[0]!,
      state: await readEntitlementState(pool, { siteId: site.id, subjectId, product }),
    });
    return { id, product, entry, read };
  }

  async function outbox() {
    const { rows } = await pool.query<{ addon_id: string; payload: { subject: string; product: string } }>(
      `SELECT addon_id, payload FROM phis.addon_event_outbox WHERE site_id = $1 AND event = 'entitlement.changed' ORDER BY id`, [site.id],
    );
    return rows;
  }
  const clearOutbox = () => pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("entitlement-subscriptions");
    subjectId = (await findEntitlementSubject(pool, site.id, subject = await ensureEntitlementSubject(pool, site.id, await createPhiTestUser(site))))!.id;
    await enablePhiTestAddonForSite(site, LISTENER);
    for (const addon of [SHOP, OTHER]) {
      await pool.query(`INSERT INTO phis.server_addons (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
        VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    }
    await pool.query(`INSERT INTO phis.payment_profiles (site_id, key, provider_addon_id, draft) VALUES ($1, 'sub', $2, '{}'::jsonb)`, [site.id, SHOP]);
    await registerProduct(pool, { siteId: site.id, supplier: SUPPLIER, listeners: [], draft: normalizePhisProductDraft({ key: "plan", type: "plan", title: "Plan", summary: "" }) });
    await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key: "plan", state: "active", listeners: [] });
  });

  afterAll(async () => {
    // Fixture-only teardown: payments' tables restrict the Site's removal.
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);
    await pool.query(`DELETE FROM phis.entitlements WHERE site_id = $1`, [site.id]);
    await pool.query(`DELETE FROM phis.payment_subscriptions WHERE site_id = $1`, [site.id]);
    await pool.query(`DELETE FROM phis.payment_profiles WHERE site_id = $1`, [site.id]);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("does not count an entry whose subscription has no paid period yet, and shows no end", async () => {
    const { read } = await lone({ status: "pending", periodEnd: null });
    const { entry, state } = await read();
    expect(entry).toMatchObject({ standing: "ended", endsAt: null });
    expect(entry.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state).toMatchObject({ flags: 0, until: null });
  });

  it("counts until the paid period's end and the grace after it, shows the period's end, and follows a renewal without a write", async () => {
    const { id, read, product } = await lone({ periodEnd: at(5 * DAY) });
    const first = await read();
    const end = first.entry.endsAt!;
    expect(first.entry.standing).toBe("valid");
    expect(first.state).toMatchObject({ flags: 1, until: plus(end, 14 * DAY) });
    expect(Math.abs(Date.parse(end) - (Date.now() + 5 * DAY))).toBeLessThan(2000);

    const before = (await pool.query(`SELECT updated_at, ends_at FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, product])).rows[0];
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{period,endsAt}', to_jsonb($2::text)) WHERE id = $1`, [id, at(35 * DAY)]);
    const renewed = await read();
    expect(Math.abs(Date.parse(renewed.entry.endsAt!) - (Date.now() + 35 * DAY))).toBeLessThan(2000);
    expect(renewed.state.until).toBe(plus(renewed.entry.endsAt!, 14 * DAY));
    // Nothing was written to the entry.
    const after = (await pool.query(`SELECT updated_at, ends_at FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, product])).rows[0];
    expect(after).toEqual(before);
    expect(after.ends_at).toBeNull();
  });

  it("goes on counting for the subscription's grace days after the period while the subscription has not ended", async () => {
    const lateBy = async (offset: number, input: { status?: string; endedAt?: string | null } = {}) =>
      (await lone({ ...input, periodEnd: at(-offset) })).read();

    // 14 days (the default): a period 13 days over still counts, one 15 days over does not.
    const recent = await lateBy(13 * DAY);
    expect(recent.entry.standing).toBe("valid");
    expect(recent.state.flags).toBe(1);
    // The end shown is the period's, without the grace; the answer's until is when it stops counting.
    expect(Date.parse(recent.entry.endsAt!)).toBeLessThan(Date.now());
    expect(recent.state.until).toBe(plus(recent.entry.endsAt!, 14 * DAY));
    expect((await lateBy(15 * DAY)).entry.standing).not.toBe("valid");
    expect((await lateBy(2 * DAY, { status: "past_due" })).entry.standing).toBe("valid");

    // 0 days: it ends with the period.
    await setGrace(0);
    expect((await lateBy(HOUR)).entry.standing).not.toBe("valid");
    expect((await lateBy(-HOUR)).entry.standing).toBe("valid");
    // Any number in between.
    await setGrace(3);
    expect((await lateBy(2 * DAY)).entry.standing).toBe("valid");
    expect((await lateBy(4 * DAY)).entry.standing).not.toBe("valid");
    await setGrace(14);
  });

  it("reads each subscription's own grace, not one of the Site's", async () => {
    const short = await (await lone({ periodEnd: at(-2 * DAY), graceDays: 1 })).read();
    const long = await (await lone({ periodEnd: at(-2 * DAY), graceDays: 30 })).read();
    expect(short.entry.standing).toBe("ended");
    expect(short.state).toMatchObject({ flags: 0, until: null });
    expect(long.entry.standing).toBe("valid");
    expect(long.state.until).toBe(plus(long.entry.endsAt!, 30 * DAY));
  });

  it("gives an ended subscription no grace: it counts to the paid period's end only", async () => {
    const endedAt = at(-HOUR);
    for (const input of [{ status: "canceled" }, { endedAt }, { status: "canceled", endedAt }]) {
      expect((await (await lone({ ...input, periodEnd: at(-HOUR) })).read()).entry.standing, JSON.stringify(input)).not.toBe("valid");
      const running = await (await lone({ ...input, periodEnd: at(3 * DAY) })).read();
      expect(running.entry.standing, JSON.stringify(input)).toBe("valid");
    }
  });

  it("still lets a revoked or suspended entry, and a locked product, override the subscription", async () => {
    const { entry, read, product } = await lone({ periodEnd: at(5 * DAY) });
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, setFlags: 2, listeners: [] });
    expect((await read()).entry.standing).toBe("suspended");
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, clearFlags: 2, listeners: [] });
    expect((await read()).entry.standing).toBe("valid");
    await pool.query(`UPDATE phis.products SET state = 'locked' WHERE site_id = $1 AND key = $2`, [site.id, product.slice(product.lastIndexOf(":") + 1)]);
    expect((await read()).state.flags).toBe(0);
    expect((await read()).entry.standing).toBe("product-locked");
    await pool.query(`UPDATE phis.products SET state = 'withdrawn' WHERE site_id = $1 AND key = $2`, [site.id, product.slice(product.lastIndexOf(":") + 1)]);
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, revoke: true, listeners: [] });
    expect((await read()).entry.standing).toBe("revoked");
  });

  it("holds either a subscription or a written end, never both, and allows no end on a bound entry", async () => {
    const id = await subscription({ periodEnd: at(DAY) });
    await expect(pool.query(
      `INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference, ends_at, subscription_id)
       VALUES ($1, $2, $3, $4, 'both', NOW() + INTERVAL '1 day', $5)`, [site.id, subjectId, PRODUCT, SHOP, id],
    )).rejects.toThrow(/entitlements_end_or_subscription_check/);

    const entry = await bound(id, { reference: "no-end" });
    await expect(updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: entry.reference, endsAt: at(DAY), listeners: [] })).rejects.toThrow(/no written end/);
    await expect(updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: entry.reference, endsAt: null, listeners: [] })).rejects.toThrow(/no written end/);
    // Suspending, and a quantity, stay possible.
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: entry.reference, setFlags: 2, listeners: [] })).toMatchObject({ standing: "suspended" });
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: entry.reference, quantity: null, listeners: [] })).not.toBeNull();
    // An entry without a subscription still takes an end.
    const plain = await bound(null, { reference: "plain" });
    expect((await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: plain.reference, endsAt: at(DAY), listeners: [] }))!.endsAt).not.toBeNull();
  });

  it("is idempotent on (product, reference) with a subscription as without", async () => {
    const id = await subscription({ periodEnd: at(DAY) });
    const first = await bound(id, { reference: "idem-sub" });
    const second = await bound(await subscription({ periodEnd: at(9 * DAY) }), { reference: "idem-sub" });
    expect(second.id).toBe(first.id);
    expect(second.subscriptionId).toBe(id);
  });

  it("knows a subscription as its consumer's on this Site only", async () => {
    const id = await subscription({ periodEnd: at(DAY) });
    expect(await isSubscriptionOfAddon(pool, site.id, id, SHOP)).toBe(true);
    expect(await isSubscriptionOfAddon(pool, site.id, id, OTHER)).toBe(false);
    expect(await isSubscriptionOfAddon(pool, site.id + 1000, id, SHOP)).toBe(false);
    expect(await isSubscriptionOfAddon(pool, site.id, randomUUID(), SHOP)).toBe(false);
    expect(await isSubscriptionOfAddon(pool, site.id, "not a uuid", SHOP)).toBe(false);
  });

  it("owes entitlement.changed when payments books a paid period or ends the subscription, and only then", async () => {
    const id = await subscription({ status: "pending", periodEnd: null });
    await bound(id, { reference: "evt-1" });
    await bound(id, { reference: "evt-2" });
    const revoked = await bound(id, { reference: "evt-revoked" });
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: revoked.reference, revoke: true, listeners: [] });
    await clearOutbox();

    // Nothing the answer depends on changes: no event.
    await change(id, { status: "pending", periodEnd: null });
    expect(await outbox()).toHaveLength(0);
    // The first paid period.
    await change(id, { status: "active", periodEnd: at(30 * DAY) });
    const rows = await outbox();
    // One event for the subject and product, however many entries, none for the revoked one's alone.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ addon_id: LISTENER, payload: { subject, product: PRODUCT } });
    await clearOutbox();
    const period = at(60 * DAY);
    await change(id, { status: "active", periodEnd: period });
    expect(await outbox()).toHaveLength(1);
    await clearOutbox();
    await change(id, { status: "past_due", periodEnd: period });
    expect(await outbox()).toHaveLength(0);
    // The subscription ends.
    await change(id, { status: "canceled", periodEnd: period, endedAt: at(0) });
    expect(await outbox()).toHaveLength(1);
    // Payments' own payment.changed row is written all the same.
    const { rows: own } = await pool.query(`SELECT 1 FROM phis.addon_event_outbox WHERE site_id = $1 AND event = 'payment.changed'`, [site.id]);
    expect(own.length).toBeGreaterThan(0);
  });

  it("owes the parts of a bundle that follows a subscription their event, and holds them through it", async () => {
    seq += 1;
    const part = `${SUPPLIER}:part-${seq}` as PhisProductId;
    const bundle = `${SUPPLIER}:bundle-${seq}` as PhisProductId;
    for (const [key, parts] of [[`part-${seq}`, []], [`bundle-${seq}`, [part]]] as const) {
      await registerProduct(pool, { siteId: site.id, supplier: SUPPLIER, listeners: [], draft: normalizePhisProductDraft({ key, type: "plan", title: key, summary: "", parts: [...parts] }) });
      await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key, state: "active", listeners: [] });
    }
    const id = await subscription({ status: "pending", periodEnd: null });
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: bundle, source: SHOP, reference: `bundle-${seq}`, startsAt: null, endsAt: null, quantity: null, counted: false, subscriptionId: id, listeners: [],
    });
    expect((await readEntitlementState(pool, { siteId: site.id, subjectId, product: part })).flags).toBe(0);
    await clearOutbox();

    const period = at(30 * DAY);
    await change(id, { status: "active", periodEnd: period });
    expect((await outbox()).map((row) => row.payload.product)).toEqual([bundle, part]);
    expect(await readEntitlementState(pool, { siteId: site.id, subjectId, product: part }))
      .toEqual({ product: part, flags: 1, quantity: null, until: plus(period, 14 * DAY), via: [bundle] });
  });

  it("answers until as the instant the answer stops counting, by the rule valid follows", async () => {
    // Inside the grace: entitled, until the period's end plus the grace, which lies ahead.
    const late = await (await lone({ periodEnd: at(-2 * DAY) })).read();
    expect(late.entry).toMatchObject({ standing: "valid" });
    expect(late.state.flags).toBe(1);
    expect(late.state.until).toBe(plus(late.entry.endsAt!, 14 * DAY));
    expect(Date.parse(late.state.until!)).toBeGreaterThan(Date.now());
    // With another grace, that one.
    await setGrace(3);
    const short = await (await lone({ periodEnd: at(-2 * DAY) })).read();
    expect(short.state).toMatchObject({ flags: 1, until: plus(short.entry.endsAt!, 3 * DAY) });
    // After the grace: nobody is entitled, and there is no until.
    expect((await (await lone({ periodEnd: at(-4 * DAY) })).read()).state).toMatchObject({ flags: 0, until: null, via: [] });
    await setGrace(14);

    // An ended subscription has no grace: until is the paid period's end.
    for (const input of [{ status: "canceled" }, { endedAt: at(-HOUR) }]) {
      const ended = await (await lone({ ...input, periodEnd: at(3 * DAY) })).read();
      expect(ended.state, JSON.stringify(input)).toMatchObject({ flags: 1, until: ended.entry.endsAt });
    }

    // An entry without a subscription answers its written end, as before; the latest instant wins.
    const { product, read } = await lone({ periodEnd: at(-2 * DAY) });
    const counts = plus((await read()).entry.endsAt!, 14 * DAY);
    const later = at(20 * DAY);
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product, source: SHOP, reference: `plain-${seq}`, startsAt: null, endsAt: at(DAY), quantity: null, counted: false, listeners: [],
    });
    expect((await read()).state.until).toBe(counts);
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product, source: SHOP, reference: `plain-later-${seq}`, startsAt: null, endsAt: later, quantity: null, counted: false, listeners: [],
    });
    expect((await read()).state.until).toBe(later);
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product, source: SHOP, reference: `plain-open-${seq}`, startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    });
    expect((await read()).state.until).toBeNull();
  });

  it("answers a part held through a bundle bound to a subscription inside its grace until the grace ends", async () => {
    seq += 1;
    const part = `${SUPPLIER}:gpart-${seq}` as PhisProductId;
    const bundle = `${SUPPLIER}:gbundle-${seq}` as PhisProductId;
    for (const [key, parts] of [[`gpart-${seq}`, []], [`gbundle-${seq}`, [part]]] as const) {
      await registerProduct(pool, { siteId: site.id, supplier: SUPPLIER, listeners: [], draft: normalizePhisProductDraft({ key, type: "plan", title: key, summary: "", parts: [...parts] }) });
      await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key, state: "active", listeners: [] });
    }
    const period = at(-DAY);
    const id = await subscription({ status: "past_due", periodEnd: period });
    await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: bundle, source: SHOP, reference: `gbundle-${seq}`, startsAt: null, endsAt: null, quantity: null, counted: false, subscriptionId: id, listeners: [],
    });
    expect(await readEntitlementState(pool, { siteId: site.id, subjectId, product: part }))
      .toEqual({ product: part, flags: 1, quantity: null, until: plus(period, 14 * DAY), via: [bundle] });
    // Past the grace, the part goes with the bundle.
    await setGrace(0);
    expect(await readEntitlementState(pool, { siteId: site.id, subjectId, product: part }))
      .toEqual({ product: part, flags: 0, quantity: null, until: null, via: [] });
    await setGrace(14);
  });

  it("announces an expired bound entry once, and again after a renewal expires", async () => {
    await setGrace(0);
    // Earlier tests' entries may be owed too; this one's rows are the ones counted.
    const { id, read, product } = await lone({ periodEnd: at(-HOUR) });
    await clearOutbox();
    const mine = async () => (await outbox()).filter((row) => row.payload.product === product);
    expect(await announceEndedEntitlements(pool, [LISTENER])).toContain(site.id);
    expect(await mine()).toHaveLength(1);

    await clearOutbox();
    expect(await announceEndedEntitlements(pool, [LISTENER])).not.toContain(site.id);

    // Renewed: not expired, nothing owed. Then it runs out again, later than the last announcement.
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{period,endsAt}', to_jsonb($2::text)) WHERE id = $1`, [id, at(2 * HOUR)]);
    expect((await read()).entry.standing).toBe("valid");
    expect(await announceEndedEntitlements(pool, [LISTENER])).not.toContain(site.id);
    await pool.query(`UPDATE phis.entitlements SET ended_event_at = NOW() - INTERVAL '3 hours' WHERE subscription_id = $1`, [id]);
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{period,endsAt}', to_jsonb($2::text)) WHERE id = $1`, [id, at(-HOUR)]);
    expect(await announceEndedEntitlements(pool, [LISTENER])).toContain(site.id);
    expect(await mine()).toHaveLength(1);
    expect(await announceEndedEntitlements(pool, [LISTENER])).not.toContain(site.id);

    // Within the grace time it is not expired; a subscription that has not got a period never is.
    await setGrace(14);
    await lone({ periodEnd: at(-DAY) });
    await lone({ status: "pending", periodEnd: null });
    await clearOutbox();
    expect(await announceEndedEntitlements(pool, [LISTENER])).not.toContain(site.id);
    expect(await outbox()).toHaveLength(0);
  });

  it("takes an entry off its subscription: it counts without an end, or to an end stated in the same call, and only once", async () => {
    const { id, entry, product, read } = await lone({ periodEnd: at(-20 * DAY) });
    expect((await read()).entry.standing).toBe("ended");
    await clearOutbox();
    const unbound = await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, unbind: true, listeners: [LISTENER] });
    expect(unbound).toMatchObject({ subscriptionId: null, endsAt: null, standing: "valid" });
    expect((await read()).state).toMatchObject({ flags: 1, until: null });
    expect((await outbox()).filter(row => row.payload.product === product)).toHaveLength(1);
    // The subscription's later facts no longer reach it.
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{status}', '"canceled"') WHERE id = $1`, [id]);
    expect((await read()).entry.standing).toBe("valid");

    // An entry that is not bound is answered as it is, without an event.
    await clearOutbox();
    const again = await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, unbind: true, listeners: [LISTENER] });
    expect(again).toEqual(unbound);
    expect(await outbox()).toHaveLength(0);

    // Unbound with an end in the same call: that end; a bound entry is refused one otherwise.
    const second = await lone({ periodEnd: at(5 * DAY) });
    const until = at(40 * DAY);
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: second.product, reference: second.entry.reference, unbind: true, endsAt: until, listeners: [] }))
      .toMatchObject({ subscriptionId: null, endsAt: until, standing: "valid" });
  });

  it("reads named entries in one call, in the order asked, and nobody else's", async () => {
    const mine = await bound(null, { reference: "named-1" });
    const other = await ensureEntitlementSubject(pool, site.id, await createPhiTestUser(site));
    const otherId = (await findEntitlementSubject(pool, site.id, other))!.id;
    await grantEntitlement(pool, { siteId: site.id, subjectId: otherId, product: PRODUCT, source: SHOP, reference: "named-2", startsAt: null, endsAt: null,
      quantity: null, counted: false, listeners: [] });
    const answer = await listNamedEntitlements(pool, { siteId: site.id, fallbackSubject: subject, entries: [
      { source: SHOP, reference: "named-2", product: PRODUCT },                   // another person's: not found
      { source: SHOP, reference: "named-1", product: PRODUCT },
      { source: OTHER, reference: "named-1", product: PRODUCT },                  // another source's
      { source: SHOP, reference: "named-2", product: PRODUCT, subject: other },  // named for its person
      { source: SHOP, reference: "missing", product: PRODUCT },
    ] });
    expect(answer.map(entry => entry?.reference ?? null)).toEqual([null, "named-1", null, "named-2", null]);
    expect(answer[1]).toMatchObject({ id: mine.id, subject, standing: "valid" });
    expect(await listNamedEntitlements(pool, { siteId: site.id, fallbackSubject: null, entries: [{ source: SHOP, reference: "named-1", product: PRODUCT }] })).toEqual([null]);
    expect(await listNamedEntitlements(pool, { siteId: site.id, fallbackSubject: subject, entries: [] })).toEqual([]);
  });
});
