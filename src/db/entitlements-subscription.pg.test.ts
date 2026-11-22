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
  readEntitlementState,
  updateEntitlement,
} from "./entitlements.mts";
import { updatePhiCliSite } from "./cli-sites.mts";
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

/**
 * An entitlement entry that follows a subscription of payments:v1: what it answers is derived from the
 * subscription's record on every read, with the Site's grace time, and never written.
 */
describe.skipIf(!configured)("entitlements bound to a subscription", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let subject: string;
  let subjectId: number;
  let seq = 0;

  async function setGrace(days: number) {
    await pool.query(`UPDATE phis.sites SET entitlement_grace_days = $2 WHERE id = $1`, [site.id, days]);
  }

  const record = (id: string, input: { status?: string; periodEnd?: string | null; endedAt?: string | null }) => ({
    id, reference: `ref-${id}`, profileKey: "sub", status: input.status ?? "active", version: 1, nextChargeAt: null,
    period: input.periodEnd === undefined || input.periodEnd === null ? null
      : { index: 0, startsAt: new Date(Date.parse(input.periodEnd) - 30 * DAY).toISOString(), endsAt: input.periodEnd },
    endedAt: input.endedAt ?? null,
  });

  async function subscription(input: { status?: string; periodEnd?: string | null; endedAt?: string | null }, consumer = SHOP) {
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
    const stored = { siteId: site.id, consumerAddonId: SHOP, record: record(id, input), request: {}, anchorAt: null, leaseToken: null } as unknown as PhisStoredPaymentSubscription;
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
  async function lone(input: { status?: string; periodEnd?: string | null; endedAt?: string | null }) {
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
    expect(entry).toMatchObject({ valid: false, endsAt: null });
    expect(entry.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state).toMatchObject({ entitled: false, until: null });
  });

  it("counts until the paid period's end, shows that end, and follows a renewal without a write", async () => {
    const { id, read, product } = await lone({ periodEnd: at(5 * DAY) });
    const first = await read();
    const end = first.entry.endsAt!;
    expect(first.entry.valid).toBe(true);
    expect(first.state).toMatchObject({ entitled: true, until: end });
    expect(Math.abs(Date.parse(end) - (Date.now() + 5 * DAY))).toBeLessThan(2000);

    const before = (await pool.query(`SELECT updated_at, ends_at FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, product])).rows[0];
    await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(record, '{period,endsAt}', to_jsonb($2::text)) WHERE id = $1`, [id, at(35 * DAY)]);
    const renewed = await read();
    expect(Math.abs(Date.parse(renewed.entry.endsAt!) - (Date.now() + 35 * DAY))).toBeLessThan(2000);
    expect(renewed.state.until).toBe(renewed.entry.endsAt);
    // Nothing was written to the entry.
    const after = (await pool.query(`SELECT updated_at, ends_at FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, product])).rows[0];
    expect(after).toEqual(before);
    expect(after.ends_at).toBeNull();
  });

  it("goes on counting for the Site's grace days after the period while the subscription has not ended", async () => {
    expect((await pool.query(`SELECT entitlement_grace_days FROM phis.sites WHERE id = $1`, [site.id])).rows[0].entitlement_grace_days).toBe(14);
    const lateBy = async (offset: number, input: { status?: string; endedAt?: string | null } = {}) =>
      (await lone({ ...input, periodEnd: at(-offset) })).read();

    // 14 days (the default): a period 13 days over still counts, one 15 days over does not.
    const recent = await lateBy(13 * DAY);
    expect(recent.entry.valid).toBe(true);
    expect(recent.state.entitled).toBe(true);
    // The end shown is the period's, without the grace.
    expect(Date.parse(recent.entry.endsAt!)).toBeLessThan(Date.now());
    expect(recent.state.until).toBe(recent.entry.endsAt);
    expect((await lateBy(15 * DAY)).entry.valid).toBe(false);
    for (const status of ["past_due", "unpaid"]) expect((await lateBy(2 * DAY, { status })).entry.valid).toBe(true);

    // 0 days: it ends with the period.
    await setGrace(0);
    expect((await lateBy(HOUR)).entry.valid).toBe(false);
    expect((await lateBy(-HOUR)).entry.valid).toBe(true);
    // Any number in between.
    await setGrace(3);
    expect((await lateBy(2 * DAY)).entry.valid).toBe(true);
    expect((await lateBy(4 * DAY)).entry.valid).toBe(false);
    await setGrace(14);
  });

  it("gives an ended subscription no grace: it counts to the paid period's end only", async () => {
    const endedAt = at(-HOUR);
    for (const input of [{ status: "canceled" }, { endedAt }, { status: "canceled", endedAt }]) {
      expect((await (await lone({ ...input, periodEnd: at(-HOUR) })).read()).entry.valid, JSON.stringify(input)).toBe(false);
      const running = await (await lone({ ...input, periodEnd: at(3 * DAY) })).read();
      expect(running.entry.valid, JSON.stringify(input)).toBe(true);
    }
  });

  it("still lets a revoked or suspended entry, and a locked product, override the subscription", async () => {
    const { entry, read, product } = await lone({ periodEnd: at(5 * DAY) });
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, suspended: true, listeners: [] });
    expect((await read()).entry.valid).toBe(false);
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, suspended: false, listeners: [] });
    expect((await read()).entry.valid).toBe(true);
    await pool.query(`UPDATE phis.products SET state = 'locked' WHERE site_id = $1 AND key = $2`, [site.id, product.slice(product.lastIndexOf(":") + 1)]);
    expect((await read()).state.entitled).toBe(false);
    await pool.query(`UPDATE phis.products SET state = 'withdrawn' WHERE site_id = $1 AND key = $2`, [site.id, product.slice(product.lastIndexOf(":") + 1)]);
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product, reference: entry.reference, revoke: true, listeners: [] });
    expect((await read()).entry.valid).toBe(false);
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
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: PRODUCT, reference: entry.reference, suspended: true, listeners: [] })).toMatchObject({ valid: false });
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
    expect((await readEntitlementState(pool, { siteId: site.id, subjectId, product: part })).entitled).toBe(false);
    await clearOutbox();

    const period = at(30 * DAY);
    await change(id, { status: "active", periodEnd: period });
    expect((await outbox()).map((row) => row.payload.product)).toEqual([bundle, part]);
    expect(await readEntitlementState(pool, { siteId: site.id, subjectId, product: part }))
      .toEqual({ product: part, entitled: true, quantity: null, until: new Date(period).toISOString(), via: [bundle] });
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
    expect((await read()).entry.valid).toBe(true);
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

  it("keeps the grace days a Site setting of 0 to 14, set by the operator", async () => {
    const row = (await pool.query<{ key: string }>(`SELECT key FROM phis.sites WHERE id = $1`, [site.id])).rows[0]!;
    const input = { siteKey: row.key, mailFrom: "no-reply@x.invalid", mailFromName: "x", contactRecipient: "x@x.invalid" };
    expect((await updatePhiCliSite(pool, { ...input, entitlementGraceDays: 7 }))!.entitlementGraceDays).toBe(7);
    // Left out, it stays.
    expect((await updatePhiCliSite(pool, input))!.entitlementGraceDays).toBe(7);
    expect((await updatePhiCliSite(pool, { ...input, entitlementGraceDays: 0 }))!.entitlementGraceDays).toBe(0);
    await expect(updatePhiCliSite(pool, { ...input, entitlementGraceDays: 15 })).rejects.toThrow(/entitlement_grace_days/);
    await expect(updatePhiCliSite(pool, { ...input, entitlementGraceDays: -1 })).rejects.toThrow(/entitlement_grace_days/);
    await setGrace(14);
  });
});
