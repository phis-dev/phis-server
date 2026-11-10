import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisPaymentDunningPolicy, PhisPaymentPricing, PhisPaymentSubscription } from "@phis/contracts/payments";
import { PhisPaymentEngine } from "@/lib/payments/engine";
import { runDuePhisPaymentSubscriptions } from "@/lib/payments/runtime";
import { addPhisPaymentIntervals } from "@/lib/payments/schedule";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { readPhisPaymentProfile, recordPhisPaymentProfileProbe, setPhisPaymentProfileEnabled, writePhisPaymentProfile } from "./payments.mts";
import { closePhiTestPool, createPhiTestSite, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";
import { StoringProvider } from "../../test/pg/payment-storing-provider";

const providerBinding = vi.hoisted(() => ({ addonId: "@pgtest/subscription-provider", factory: null as null | (() => unknown) }));
vi.mock("@/lib/addons/services.ts", () => ({ resolvePhisServiceProvider: async () => ({ addonId: providerBinding.addonId, factory: providerBinding.factory }) }));
vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
const CONSUMER = "@pgtest/subscription-consumer";
const OTHER_CONSUMER = "@pgtest/subscription-other";
const DAY = 86_400_000;
const QUARTER = { unit: "month", count: 3 } as const;
const FINAL: PhisPaymentPricing = { basis: "final", tax: "none" };

/**
 * A subscription from its first payment to its end, with the schedule driven by hand: `advance` is what
 * the scheduler does for one subscription, given the time it is asked to believe it is.
 */
describe("subscriptions on Core's own schedule", () => {
  let site: PhiTestSite;
  const remote = new StoringProvider();

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("subscriptions");
    providerBinding.factory = () => remote;
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query(`INSERT INTO phis.server_addons
      (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    const policy = { roles: [], jobs: [], events: [] };
    const profile = await writePhisPaymentProfile(pool, site.id, providerBinding.addonId, {
      key: "sandbox", providerKey: "@pgtest/subscription-provider/test", mode: "test", credentialReferences: {}, grants: [
        { consumerAddonId: CONSUMER, operations: ["read", "create", "refresh", "refund", "method-store", "method-read", "method-remove",
          "subscription-read", "subscription-create", "subscription-cancel"], merchantActions: { capture: policy, cancel: policy, refund: policy, subscriptionEnd: policy, subscriptionPrice: policy } },
        { consumerAddonId: OTHER_CONSUMER, operations: ["read", "create", "refresh", "method-store"], merchantActions: { capture: policy, cancel: policy, refund: policy } },
      ],
    }, false);
    await recordPhisPaymentProfileProbe(pool, profile, "acct_stored", "test");
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, site.id, "sandbox"))!, true);
  });
  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; the product deliberately exposes no financial purge.
    await pool.query("DELETE FROM phis.addon_event_outbox WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_subscription_periods WHERE subscription_id IN (SELECT id FROM phis.payment_subscriptions WHERE site_id = $1)", [site.id]);
    await pool.query("DELETE FROM phis.payment_subscriptions WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_refunds WHERE payment_id IN (SELECT id FROM phis.payments WHERE site_id = $1)", [site.id]);
    await pool.query("DELETE FROM phis.payment_operations WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_stored_methods WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payments WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_profiles WHERE site_id = $1", [site.id]);
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query("DELETE FROM phis.server_addons WHERE addon_id = $1", [addon]);
    await dropPhiTestSites(); await closePhiTestPool();
  });
  beforeEach(() => { remote.next = "paid"; remote.charges = []; });

  async function service(consumerAddonId = CONSUMER, merchant = true) {
    return new PhisPaymentEngine({ pool: await requirePhiTestDatabase(), scope: { siteId: site.id, siteKey: site.key, consumerAddonId },
      signal: new AbortController().signal, publicBaseUrl: async () => `https://${site.key}.invalid`, resolveProvider: async () => remote, merchantAuthorized: async () => merchant });
  }
  function agreement(overrides = {}) {
    return { profileKey: "sandbox", reference: `sub-${randomUUID()}`, idempotencyKey: randomUUID(), payerReference: `payer-${randomUUID()}`, interval: QUARTER,
      recurring: { amount: { currency: "CHF", minor: "2700" }, pricing: FINAL, description: "Plan, one quarter" },
      // The first payment carries the one-time fee as well.
      first: { amount: { currency: "CHF", minor: "6300" }, pricing: FINAL, description: "Plan, first quarter and setup" },
      methodKey: "card" as string | null, checkoutKind: "redirect" as const, returnPath: "/return", ...overrides };
  }
  /** A subscription whose first payment the customer has made: active, in its first period. */
  async function running(overrides: { dunning?: PhisPaymentDunningPolicy; methodKey?: string } = {}) {
    const api = await service();
    const created = await api.createSubscription(agreement(overrides));
    remote.customerPays(created.payment.payment.id);
    await api.refresh(created.payment.payment.id);
    const subscription = (await api.getSubscription(created.subscription.id))!;
    return { api, id: subscription.id, subscription, firstPaymentId: created.payment.payment.id };
  }
  const after = (iso: string, ms = 1_000) => new Date(new Date(iso).getTime() + ms);
  const read = async (api: PhisPaymentEngine, id: string) => (await api.getSubscription(id)) as PhisPaymentSubscription;

  it("is pending until its first payment is captured, and runs from that moment", async () => {
    const api = await service();
    const input = agreement();

    const created = await api.createSubscription(input);

    expect(created.subscription).toMatchObject({ status: "pending", period: null, storedMethodId: null, nextChargeAt: null, reference: input.reference,
      dunning: { retryAfterDays: [3, 5, 7], onExhausted: "unpaid" } });
    // The first payment is an ordinary hosted payment that also stores the method.
    expect(created.payment.payment).toMatchObject({ status: "awaiting_customer", reference: `${input.reference}#0`, subscriptionId: created.subscription.id,
      periodIndex: 0, initiator: "customer", amount: { currency: "CHF", minor: "6300" } });
    expect(created.payment.payment.storedMethodId).not.toBeNull();

    remote.customerPays(created.payment.payment.id);
    await api.refresh(created.payment.payment.id);
    const active = await read(api, created.subscription.id);

    expect(active).toMatchObject({ status: "active", customerActionRequired: false, storedMethodId: created.payment.payment.storedMethodId, cancelAtPeriodEnd: false });
    expect(active.period).toMatchObject({ index: 0 });
    // One quarter from the capture, and that is when Core next acts.
    expect(active.period!.endsAt).toBe(addPhisPaymentIntervals(new Date(active.period!.startsAt), QUARTER, 1).toISOString());
    expect(active.nextChargeAt).toBe(active.period!.endsAt);
    expect(await api.listSubscriptionPeriods(active.id)).toMatchObject([{ index: 0, status: "paid", paymentIds: [created.payment.payment.id], amount: { minor: "6300" } }]);
    // The consumer is told of the subscription itself, beside the payment.
    const { rows } = await (await requirePhiTestDatabase()).query<{ n: string }>(
      "SELECT count(*) AS n FROM phis.addon_event_outbox WHERE subscription_id = $1 AND subject_kind = 'subscription' AND event = 'payment.changed'", [active.id]);
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it("ends without ever running when its first payment is never made", async () => {
    const api = await service();
    const created = await api.createSubscription(agreement());
    const state = remote.states.get(created.payment.payment.id)!;
    state.status = "expired"; state.checkout = null;

    await api.refresh(created.payment.payment.id);

    const ended = await read(api, created.subscription.id);
    expect(ended).toMatchObject({ status: "canceled", period: null, nextChargeAt: null });
    expect(ended.endedAt).not.toBeNull();
    expect(await api.listSubscriptionPeriods(ended.id)).toEqual([]);
  });

  it("is the same subscription for the same key, and refuses a second one under a live reference", async () => {
    const api = await service();
    const input = agreement();

    const first = await api.createSubscription(input);
    const again = await api.createSubscription(input);

    expect(again.subscription.id).toBe(first.subscription.id);
    expect(again.payment.payment.id).toBe(first.payment.payment.id);
    await expect(api.createSubscription({ ...input, interval: { unit: "month", count: 1 } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(api.createSubscription({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "active_attempt_exists" });
  });

  it("stores nothing for a method that could not carry the renewals", async () => {
    const api = await service();
    const net: PhisPaymentPricing = { basis: "net", tax: "provider", promotionCodes: "none", customer: null,
      lineItems: [{ reference: "plan", description: "Plan", quantity: 1, unitMinor: "2700", taxCategory: "general", providerTaxCodes: null }], shipping: null, discounts: [] };

    // The checkout could compute the tax; the charges that follow could not.
    await expect(api.createSubscription(agreement({ recurring: { amount: { currency: "CHF", minor: "2700" }, pricing: net, description: "Plan" } })))
      .rejects.toMatchObject({ code: "unsupported_operation" });
    await expect(api.createSubscription(agreement({ methodKey: "invoice" }))).rejects.toMatchObject({ code: "method_unavailable" });
  });

  it("charges the next period when the paid one is over, once, on boundaries counted from the start", async () => {
    const { api, id, subscription } = await running();
    const due = after(subscription.period!.endsAt);

    await api.advanceSubscription(id, due);

    const renewed = await read(api, id);
    expect(renewed).toMatchObject({ status: "active", period: { index: 1, startsAt: subscription.period!.endsAt } });
    // The second boundary is two quarters from the start, not one quarter from when the charge ran.
    expect(renewed.period!.endsAt).toBe(addPhisPaymentIntervals(new Date(subscription.period!.startsAt), QUARTER, 2).toISOString());
    expect(renewed.nextChargeAt).toBe(renewed.period!.endsAt);
    expect(remote.charges).toHaveLength(1);
    expect(remote.charges[0]).toMatchObject({ action: "charge", sequence: "scheduled", amount: { currency: "CHF", minor: "2700" }, description: "Plan, one quarter" });
    const [latest] = await api.listSubscriptionPeriods(id);
    expect(latest).toMatchObject({ index: 1, status: "paid", amount: { minor: "2700" } });
    const payment = (await api.get(latest!.paymentIds[0]!))!;
    expect(payment).toMatchObject({ status: "captured", initiator: "schedule", reference: `${subscription.reference}#1`, subscriptionId: id, periodIndex: 1 });

    // Asked again for the same moment, the schedule has nothing to do.
    await api.advanceSubscription(id, due);
    expect(remote.charges).toHaveLength(1);
    // A renewal is refunded like any payment.
    const refund = await api.refund({ paymentId: payment.id, idempotencyKey: randomUUID(), minor: "2700", reason: "Goodwill" });
    expect(refund.payment.refundedMinor).toBe("2700");
  });

  it("retries a declined renewal on the days the policy names, without moving the schedule", async () => {
    const { api, id, subscription } = await running();
    const dueAt = subscription.period!.endsAt;
    remote.next = "declined";

    await api.advanceSubscription(id, after(dueAt));

    const pastDue = await read(api, id);
    expect(pastDue).toMatchObject({ status: "past_due", customerActionRequired: false, period: { index: 0 } });
    expect(pastDue.nextChargeAt).toBe(new Date(new Date(dueAt).getTime() + 3 * DAY).toISOString());
    expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "open" });

    // A day later is too early: nothing is tried.
    await api.advanceSubscription(id, after(dueAt, DAY));
    expect(remote.charges).toHaveLength(1);

    await api.advanceSubscription(id, after(pastDue.nextChargeAt!));

    const recovered = await read(api, id);
    expect(recovered).toMatchObject({ status: "active", period: { index: 1, startsAt: dueAt } });
    // Paid three days late, and the period still ends where it would have.
    expect(recovered.period!.endsAt).toBe(addPhisPaymentIntervals(new Date(subscription.period!.startsAt), QUARTER, 2).toISOString());
    expect(remote.charges).toHaveLength(2);
    expect((await api.listSubscriptionPeriods(id))[0]!.paymentIds).toHaveLength(2);
  });

  it("stops trying when the policy is used up, and is paid again by the customer", async () => {
    const { api, id, subscription } = await running();
    const dueAt = new Date(subscription.period!.endsAt).getTime();
    // The first charge and the three retries of the default policy.
    for (const day of [0, 3, 5, 7]) {
      remote.next = "declined";
      await api.advanceSubscription(id, new Date(dueAt + day * DAY + 1_000));
    }

    const unpaid = await read(api, id);
    expect(unpaid).toMatchObject({ status: "unpaid", nextChargeAt: null, period: { index: 0 } });
    expect(remote.charges).toHaveLength(4);
    expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "failed" });
    await api.advanceSubscription(id, new Date(dueAt + 30 * DAY));
    expect(remote.charges).toHaveLength(4);

    // The customer comes back and pays the open period on a checkout, which stores a method anew.
    const settle = await api.settleSubscription({ subscriptionId: id, idempotencyKey: randomUUID(), methodKey: "card", checkoutKind: "redirect", returnPath: "/return" });
    expect(settle.payment).toMatchObject({ status: "awaiting_customer", initiator: "customer", amount: { minor: "2700" }, periodIndex: 1 });
    remote.customerPays(settle.payment.id);
    await api.refresh(settle.payment.id);

    const back = await read(api, id);
    expect(back).toMatchObject({ status: "active", period: { index: 1 }, storedMethodId: settle.payment.storedMethodId });
    expect(back.storedMethodId).not.toBe(subscription.storedMethodId);
    expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "paid" });
  });

  it("ends by itself where the policy says so", async () => {
    const { api, id, subscription } = await running({ dunning: { retryAfterDays: [], onExhausted: "cancel" } });
    remote.next = "declined";

    await api.advanceSubscription(id, after(subscription.period!.endsAt));

    const ended = await read(api, id);
    expect(ended).toMatchObject({ status: "canceled", nextChargeAt: null });
    expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "failed" });
  });

  it("waits for a customer who has to return instead of charging again, and only so long", async () => {
    const { api, id, subscription } = await running();
    const dueAt = new Date(subscription.period!.endsAt).getTime();
    remote.next = "customer";

    await api.advanceSubscription(id, new Date(dueAt + 1_000));

    const waiting = await read(api, id);
    expect(waiting).toMatchObject({ status: "past_due", customerActionRequired: true });
    // Until the day the last retry would have been.
    expect(waiting.nextChargeAt).toBe(new Date(dueAt + 7 * DAY).toISOString());
    // No retry can cure it, so none is made on the days a declined charge would have been retried.
    await api.advanceSubscription(id, new Date(dueAt + 3 * DAY + 1_000));
    await api.advanceSubscription(id, new Date(dueAt + 5 * DAY + 1_000));
    expect(remote.charges).toHaveLength(1);

    await api.advanceSubscription(id, new Date(dueAt + 7 * DAY + 1_000));
    expect(await read(api, id)).toMatchObject({ status: "unpaid", nextChargeAt: null });
  });

  it("takes a customer's payment in time as the end of the waiting", async () => {
    const { api, id, subscription } = await running();
    remote.next = "customer";
    await api.advanceSubscription(id, after(subscription.period!.endsAt));

    const settle = await api.settleSubscription({ subscriptionId: id, idempotencyKey: randomUUID(), methodKey: "card", checkoutKind: "redirect", returnPath: "/return" });
    remote.customerPays(settle.payment.id);
    await api.refresh(settle.payment.id);

    expect(await read(api, id)).toMatchObject({ status: "active", customerActionRequired: false, period: { index: 1 } });
    // Nothing is open any more, so there is nothing to settle twice.
    await expect(api.settleSubscription({ subscriptionId: id, idempotencyKey: randomUUID(), methodKey: "card", checkoutKind: "redirect", returnPath: "/return" }))
      .rejects.toMatchObject({ code: "invalid_state" });
  });

  it("asks for the customer when the stored method is gone, and keeps a method in use from being removed", async () => {
    const { api, id, subscription } = await running();
    await expect(api.removeStoredMethod(subscription.storedMethodId!)).rejects.toMatchObject({ code: "invalid_state" });
    remote.next = "gone";

    await api.advanceSubscription(id, after(subscription.period!.endsAt));

    expect(await read(api, id)).toMatchObject({ status: "past_due", customerActionRequired: true });
    expect((await api.getStoredMethod(subscription.storedMethodId!))!.status).toBe("invalid");
  });

  it("does not charge a second time while the first answer is still out", async () => {
    const { api, id, subscription } = await running();
    const due = after(subscription.period!.endsAt);
    remote.next = "pending";

    await api.advanceSubscription(id, due);
    expect(await read(api, id)).toMatchObject({ status: "active", period: { index: 0 } });
    const paymentId = (await api.listSubscriptionPeriods(id))[0]!.paymentIds[0]!;
    expect((await api.get(paymentId))!.status).toBe("processing");

    // The schedule comes round again: it asks about the charge it made, and makes no other.
    await api.advanceSubscription(id, new Date(due.getTime() + 300_000));
    expect(remote.charges).toHaveLength(1);

    const state = remote.states.get(paymentId)!;
    state.status = "captured"; state.capturedMinor = "2700";
    await api.advanceSubscription(id, new Date(due.getTime() + 600_000));

    expect(await read(api, id)).toMatchObject({ status: "active", period: { index: 1 } });
    expect(remote.charges).toHaveLength(1);
  });

  it("ends with the paid period when the customer cancels, and not a day earlier", async () => {
    const { api, id, subscription } = await running();

    const cancelled = await api.cancelSubscription({ subscriptionId: id, at: "period-end" });
    expect(cancelled).toMatchObject({ status: "active", cancelAtPeriodEnd: true, nextChargeAt: subscription.period!.endsAt });
    // Changed their mind, and changed it back.
    expect(await api.resumeSubscription(id)).toMatchObject({ cancelAtPeriodEnd: false });
    await api.cancelSubscription({ subscriptionId: id, at: "period-end" });

    await api.advanceSubscription(id, after(subscription.period!.endsAt));

    const ended = await read(api, id);
    expect(ended).toMatchObject({ status: "canceled", endedAt: subscription.period!.endsAt, nextChargeAt: null });
    expect(remote.charges).toHaveLength(0);
    await expect(api.resumeSubscription(id)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("ends at once only on the merchant's word, and at once for a subscription with nothing paid ahead", async () => {
    const { id, subscription } = await running();
    const customer = await service(CONSUMER, false);
    await expect(customer.cancelSubscription({ subscriptionId: id, at: "now" })).rejects.toMatchObject({ code: "forbidden" });

    const staff = await service(CONSUMER, true);
    expect(await staff.cancelSubscription({ subscriptionId: id, at: "now" })).toMatchObject({ status: "canceled", nextChargeAt: null });

    // Past due: nothing is paid ahead, so a customer's cancellation has no period end to wait for.
    const late = await running();
    remote.next = "declined";
    await late.api.advanceSubscription(late.id, after(late.subscription.period!.endsAt));
    expect(await customer.cancelSubscription({ subscriptionId: late.id, at: "period-end" })).toMatchObject({ status: "canceled" });
    expect((await customer.listSubscriptionPeriods(late.id))[0]).toMatchObject({ index: 1, status: "void" });
    expect(subscription.status).toBe("active");
  });

  it("is charged to another method of the same payer once told to", async () => {
    const { api, id, subscription } = await running();
    // The payer pays for something else with `store`, which gives them a second method.
    const other = await api.create({ profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "500" }, pricing: FINAL,
      description: "Something else", captureMode: "automatic", methodKey: "card", checkoutKind: "redirect", returnPath: "/return", store: { payerReference: subscription.payerReference } });
    remote.customerPays(other.payment.id);
    await api.refresh(other.payment.id);
    const stranger = await api.create({ profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "500" }, pricing: FINAL,
      description: "Somebody else", captureMode: "automatic", methodKey: "card", checkoutKind: "redirect", returnPath: "/return", store: { payerReference: `payer-${randomUUID()}` } });
    remote.customerPays(stranger.payment.id);
    await api.refresh(stranger.payment.id);

    await expect(api.replaceSubscriptionMethod({ subscriptionId: id, storedMethodId: stranger.payment.storedMethodId! })).rejects.toMatchObject({ code: "stored_method_unavailable" });
    const replaced = await api.replaceSubscriptionMethod({ subscriptionId: id, storedMethodId: other.payment.storedMethodId! });

    expect(replaced!.storedMethodId).toBe(other.payment.storedMethodId);
    // The one it no longer uses can now be removed.
    expect((await api.removeStoredMethod(subscription.storedMethodId!))!.status).toBe("revoked");
  });

  it("costs something else from the next period on, on the merchant's word, and nothing changes behind", async () => {
    const { id, subscription } = await running();
    const dearer = { amount: { currency: "CHF", minor: "3300" }, pricing: FINAL, description: "Plan, one quarter" };
    const customer = await service(CONSUMER, false);
    await expect(customer.changeSubscriptionPrice({ subscriptionId: id, recurring: dearer })).rejects.toMatchObject({ code: "forbidden" });

    const staff = await service(CONSUMER, true);
    const changed = await staff.changeSubscriptionPrice({ subscriptionId: id, recurring: dearer });

    expect(changed).toMatchObject({ recurring: { amount: { minor: "3300" } }, status: "active", period: { index: 0 } });
    expect(changed!.version).toBeGreaterThan(subscription.version);
    // The paid period is what it was.
    expect((await staff.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 0, amount: { minor: "6300" }, status: "paid" });

    await staff.advanceSubscription(id, after(subscription.period!.endsAt));
    expect(remote.charges[0]).toMatchObject({ amount: { currency: "CHF", minor: "3300" } });
    expect((await staff.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, amount: { minor: "3300" }, status: "paid" });

    // Not another currency, and not what the stored method cannot be charged.
    await expect(staff.changeSubscriptionPrice({ subscriptionId: id, recurring: { ...dearer, amount: { currency: "EUR", minor: "3300" } } })).rejects.toMatchObject({ code: "invalid_input" });
    const net: PhisPaymentPricing = { basis: "net", tax: "provider", promotionCodes: "none", customer: null,
      lineItems: [{ reference: "plan", description: "Plan", quantity: 1, unitMinor: "3300", taxCategory: "general", providerTaxCodes: null }], shipping: null, discounts: [] };
    await expect(staff.changeSubscriptionPrice({ subscriptionId: id, recurring: { ...dearer, pricing: net } })).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("keeps the amount of a period that is already open when the price changes", async () => {
    const { api, id, subscription } = await running();
    remote.next = "declined";
    await api.advanceSubscription(id, after(subscription.period!.endsAt));

    await api.changeSubscriptionPrice({ subscriptionId: id, recurring: { amount: { currency: "CHF", minor: "3300" }, pricing: FINAL, description: "Plan, one quarter" } });
    remote.charges = [];
    await api.advanceSubscription(id, after((await read(api, id)).nextChargeAt!));

    // The retry is for the period as it was agreed when it fell due.
    expect(remote.charges[0]).toMatchObject({ amount: { minor: "2700" } });
    expect(await read(api, id)).toMatchObject({ status: "active", recurring: { amount: { minor: "3300" } } });
  });

  it("is advanced by the scheduler's run, under a lease that is given back", async () => {
    const { api, id } = await running();
    const pool = await requirePhiTestDatabase();
    // The run finds a Site the way a request does, and that way knows only active Sites.
    await pool.query("UPDATE phis.sites SET flags = flags | $2 WHERE id = $1", [site.id, SITE_FLAG_ACTIVE]);
    // The paid period is made to be over, as far as the clock in the database can tell.
    const past = new Date(Date.now() - 60_000).toISOString();
    await pool.query(`UPDATE phis.payment_subscriptions SET next_charge_at = $2::timestamptz, record = jsonb_set(record, '{nextChargeAt}', to_jsonb($3::text)) WHERE id = $1`, [id, past, past]);

    const taken = await runDuePhisPaymentSubscriptions(100);

    expect(taken).toBeGreaterThanOrEqual(1);
    expect(await read(api, id)).toMatchObject({ status: "active", period: { index: 1 } });
    const { rows } = await pool.query<{ lease_token: string | null }>("SELECT lease_token FROM phis.payment_subscriptions WHERE id = $1", [id]);
    expect(rows[0]!.lease_token).toBeNull();
    // Nothing is due any more, so a second run takes nothing of this Site's.
    const charges = remote.charges.length;
    await runDuePhisPaymentSubscriptions(100);
    expect(remote.charges).toHaveLength(charges);
  });

  it("keeps one consumer's subscriptions from another", async () => {
    const { id } = await running();
    const other = await service(OTHER_CONSUMER);

    expect(await other.getSubscription(id)).toBeNull();
    expect(await other.listSubscriptionPeriods(id)).toEqual([]);
    expect(await other.cancelSubscription({ subscriptionId: id, at: "period-end" })).toBeNull();
    // Taking payments and storing methods is not the right to start a subscription.
    await expect(other.createSubscription(agreement())).rejects.toMatchObject({ code: "not_found" });
  });
});
