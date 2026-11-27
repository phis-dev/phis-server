import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PhisPaymentCurrencyFeatureFlag, PhisPaymentSubscriptionFlag, type PhisPaymentCollection, type PhisPaymentPricing, type PhisPaymentSubscription,
} from "@phis/contracts/payments";
import type { PhisProductId } from "@phis/contracts/products";
import { PhisPaymentEngine } from "@/lib/payments/engine";
import { collectPhisPaymentRecords } from "@/lib/payments/records";
import { addPhisPaymentIntervals } from "@/lib/payments/schedule";
import { normalizePhisProductDraft } from "@/lib/addons/product-draft";
import { listPhisPaymentRefunds, readPhisPaymentProfile, recordPhisPaymentProfileFeatures, setPhisPaymentProfileEnabled, writePhisPaymentProfile } from "./payments.mts";
import { ensureEntitlementSubject, findEntitlementSubject, grantEntitlement, listEntitlements } from "./entitlements.mts";
import { registerProduct, setProductState } from "./products.mts";
import { closePhiTestPool, createPhiTestSite, createPhiTestUser, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";
import { StoringProvider } from "../../test/pg/payment-storing-provider";
import { TEST_CURRENCY_FEATURES } from "../../test/payment-features";

const providerBinding = vi.hoisted(() => ({ addonId: "@pgtest/collection-provider", factory: null as null | (() => unknown) }));
vi.mock("@/lib/addons/services.ts", () => ({ resolvePhisServiceProvider: async () => ({ addonId: providerBinding.addonId, factory: providerBinding.factory }) }));
vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
const CONSUMER = "@pgtest/collection-consumer";
const OTHER_CONSUMER = "@pgtest/collection-other";
const SUPPLIER = "@pgtest/collection-supplier";
const DAY = 86_400_000;
const QUARTER = { unit: "month", count: 3 } as const;
const FINAL: PhisPaymentPricing = { basis: "final", tax: "none" };
const REQUEST: PhisPaymentCollection = { mode: "payment-request", leadDays: 14 };

/**
 * The collection modes, changes of terms and settlement records of payments:v1 0.9, with the schedule
 * driven by hand: `advanceSubscription` is what the scheduler does for one subscription at the time given.
 */
describe("subscriptions collected by request, changed, and what payments settled", () => {
  let site: PhiTestSite;
  const remote = new StoringProvider();

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("collection");
    providerBinding.factory = () => remote;
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query(`INSERT INTO phis.server_addons
      (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    const policy = { roles: [], jobs: [], events: [] };
    const profile = await writePhisPaymentProfile(pool, site.id, providerBinding.addonId, {
      key: "sandbox", providerKey: "@pgtest/collection-provider/test", mode: "test", credentialReferences: {}, grants: [
        { consumerAddonId: CONSUMER, operations: ["read", "create", "refresh", "refund", "method-store", "method-read", "subscription-read", "subscription-create",
          "subscription-cancel", "subscription-change", "settlement-read"],
        merchantActions: { capture: policy, cancel: policy, refund: policy, subscriptionEnd: policy, subscriptionPrice: policy } },
        { consumerAddonId: OTHER_CONSUMER, operations: ["read", "create", "subscription-read"], merchantActions: { capture: policy, cancel: policy, refund: policy } },
      ],
    }, false);
    await recordPhisPaymentProfileFeatures(pool, profile, "acct_stored", "test", "CHF", []);
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, site.id, "sandbox"))!, true);
  });
  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; the product deliberately exposes no financial purge.
    for (const table of ["addon_event_outbox", "payment_record_tasks", "payment_settlements", "entitlements", "payment_subscription_changes"]) {
      await pool.query(`DELETE FROM phis.${table} WHERE site_id = $1`, [site.id]);
    }
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
  beforeEach(() => { remote.next = "paid"; remote.charges = []; remote.currency = TEST_CURRENCY_FEATURES; });

  async function service(consumerAddonId = CONSUMER, billingStaff = false) {
    return new PhisPaymentEngine({ pool: await requirePhiTestDatabase(), scope: { siteId: site.id, siteKey: site.key, consumerAddonId },
      signal: new AbortController().signal, publicBaseUrl: async () => `https://${site.key}.invalid`, resolveProvider: async () => remote,
      merchantAuthorized: async () => true, billingStaff: async () => billingStaff });
  }
  const terms = (minor: string, description = "Plan, one quarter") => ({ amount: { currency: "CHF", minor }, pricing: FINAL, description });
  function agreement(overrides = {}) {
    return { profileKey: "sandbox", reference: `sub-${randomUUID()}`, idempotencyKey: randomUUID(), payerReference: `payer-${randomUUID()}`, interval: QUARTER,
      recurring: terms("2700"), first: terms("6300", "Plan, first quarter and setup"),
      collection: { mode: "automatic", dunning: { retryAfterDays: [3, 5, 7] } } as PhisPaymentCollection, graceDays: 14,
      methodKey: "card" as string | null, checkoutKind: "redirect" as const, returnPath: "/return", ...overrides };
  }
  async function running(overrides: Partial<ReturnType<typeof agreement>> = {}) {
    const api = await service();
    const created = await api.createSubscription(agreement(overrides));
    remote.customerPays(created.payment.payment.id);
    await api.refresh(created.payment.payment.id);
    return { api, id: created.subscription.id, subscription: (await api.getSubscription(created.subscription.id))!, firstPayment: created.payment.payment };
  }
  const read = async (api: PhisPaymentEngine, id: string) => (await api.getSubscription(id)) as PhisPaymentSubscription;
  const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms);
  const iso = (date: Date) => date.toISOString();
  const pay = async (api: PhisPaymentEngine, paymentId: string) => { remote.customerPays(paymentId); await api.refresh(paymentId); };
  async function moments(id: string) {
    const { rows } = await (await requirePhiTestDatabase()).query<{ moment: string }>(`SELECT payload->>'moment' AS moment FROM phis.addon_event_outbox
      WHERE subscription_id = $1 AND payload->>'moment' IS NOT NULL ORDER BY id`, [id]);
    return rows.map(row => row.moment);
  }
  async function changeFacts(id: string) {
    const { rows } = await (await requirePhiTestDatabase()).query<{ change: string }>(`SELECT payload->>'changeId' AS change FROM phis.addon_event_outbox
      WHERE subscription_id = $1 AND payload->>'changeId' IS NOT NULL ORDER BY id`, [id]);
    return rows.map(row => row.change);
  }

  describe("payment-request", () => {
    it("pays the first period on a checkout that stores nothing, and asks for the next one lead days before the end", async () => {
      const { api, id, subscription, firstPayment } = await running({ collection: REQUEST, methodKey: "invoice" });
      expect(firstPayment.storedMethodId).toBeNull();
      expect(subscription).toMatchObject({ status: "active", collection: REQUEST, storedMethodId: null, flags: 0 });
      const E = subscription.period!.endsAt;
      expect(subscription.nextChargeAt).toBe(iso(shift(E, -14 * DAY)));

      // Before the request date nothing happens.
      await api.advanceSubscription(id, shift(E, -15 * DAY));
      expect(await api.listSubscriptionPeriods(id)).toHaveLength(1);

      const requestedAt = shift(E, -14 * DAY + 1_000);
      await api.advanceSubscription(id, requestedAt);
      const requested = await read(api, id);
      expect(requested).toMatchObject({ status: "active", flags: PhisPaymentSubscriptionFlag.CustomerActionRequired, period: { index: 0 } });
      expect(requested.nextChargeAt).toBe(iso(shift(E, -3 * DAY)));
      expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "open", startsAt: E, requestedAt: iso(requestedAt),
        graceEndsAt: iso(shift(E, 14 * DAY)), amount: { minor: "2700" } });
      expect(remote.charges).toHaveLength(0);

      await api.advanceSubscription(id, shift(E, -3 * DAY + 1_000));
      expect((await read(api, id)).nextChargeAt).toBe(E);
      expect(await moments(id)).toEqual(["requested", "reminder"]);
      // Asked again at the same time, nothing is said twice.
      await api.advanceSubscription(id, shift(E, -3 * DAY + 2_000));
      expect(await moments(id)).toEqual(["requested", "reminder"]);

      // The customer pays early, on a checkout that stores nothing; the boundaries stay where they were.
      const settle = await api.settleSubscription({ subscriptionId: id, idempotencyKey: randomUUID(), methodKey: "invoice", checkoutKind: "redirect", returnPath: "/return" });
      expect(settle.payment).toMatchObject({ initiator: "customer", storedMethodId: null, periodIndex: 1, amount: { minor: "2700" } });
      await pay(api, settle.payment.id);
      const paid = await read(api, id);
      const nextEnd = iso(addPhisPaymentIntervals(new Date(subscription.period!.startsAt), QUARTER, 2));
      expect(paid).toMatchObject({ status: "active", flags: 0, period: { index: 1, startsAt: E, endsAt: nextEnd }, storedMethodId: null });
      expect(paid.nextChargeAt).toBe(iso(shift(nextEnd, -14 * DAY)));
      expect(remote.charges).toHaveLength(0);
    });

    it("says the moments once each while unpaid -- due, then grace-ending -- and ends the subscription when the grace ends", async () => {
      const { api, id, subscription } = await running({ collection: REQUEST, methodKey: "invoice" });
      const E = subscription.period!.endsAt;
      await api.advanceSubscription(id, shift(E, -14 * DAY + 1_000));
      await api.advanceSubscription(id, shift(E, -3 * DAY + 1_000));

      await api.advanceSubscription(id, shift(E, 1_000));
      const due = await read(api, id);
      expect(due).toMatchObject({ status: "past_due", flags: PhisPaymentSubscriptionFlag.CustomerActionRequired });
      expect(due.nextChargeAt).toBe(iso(shift(E, 13 * DAY)));

      await api.advanceSubscription(id, shift(E, 5 * DAY));
      expect(await moments(id)).toEqual(["requested", "reminder", "due"]);
      await api.advanceSubscription(id, shift(E, 13 * DAY + 1_000));
      expect((await read(api, id)).nextChargeAt).toBe(iso(shift(E, 14 * DAY)));

      await api.advanceSubscription(id, shift(E, 14 * DAY + 1_000));
      expect(await read(api, id)).toMatchObject({ status: "canceled", nextChargeAt: null, flags: 0 });
      expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "failed" });
      expect(await moments(id)).toEqual(["requested", "reminder", "due", "grace-ending"]);
    });

    it("sends no reminder where the lead is 3 days or less, and no last call with a grace under 2 days", async () => {
      const { api, id, subscription } = await running({ collection: { mode: "payment-request", leadDays: 2 }, graceDays: 1, methodKey: "invoice" });
      const E = subscription.period!.endsAt;
      expect(subscription.nextChargeAt).toBe(iso(shift(E, -2 * DAY)));
      await api.advanceSubscription(id, shift(E, -2 * DAY + 1_000));
      expect((await read(api, id)).nextChargeAt).toBe(E);
      await api.advanceSubscription(id, shift(E, 1_000));
      expect((await read(api, id)).nextChargeAt).toBe(iso(shift(E, DAY)));
      await api.advanceSubscription(id, shift(E, DAY + 1_000));
      expect(await moments(id)).toEqual(["requested", "due"]);
      expect((await read(api, id)).status).toBe("canceled");
    });

    it("refuses a lead past 30 days or a period, a lead under automatic, and provider-managed", async () => {
      const api = await service();
      await expect(api.createSubscription(agreement({ collection: { mode: "payment-request", leadDays: 31 }, methodKey: "invoice" }))).rejects.toMatchObject({ code: "invalid_input" });
      await expect(api.createSubscription(agreement({ interval: { unit: "week", count: 1 }, graceDays: 0, collection: { mode: "payment-request", leadDays: 7 }, methodKey: "invoice" })))
        .rejects.toMatchObject({ code: "invalid_input" });
      await expect(api.createSubscription(agreement({ collection: { mode: "automatic", leadDays: 3, dunning: { retryAfterDays: [] } } as never }))).rejects.toMatchObject({ code: "invalid_input" });
      await expect(api.createSubscription(agreement({ collection: { mode: "provider-managed" } }))).rejects.toMatchObject({ code: "unsupported_operation" });
    });
  });

  describe("changes of terms", () => {
    it("quotes by the one rule and refuses a credit beyond the new period", async () => {
      const { api, id, subscription } = await running();
      const atEnd = await api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("1000"), timing: "period-end" });
      expect(atEnd).toMatchObject({ timing: "period-end", effectiveAt: subscription.period!.endsAt, credit: { minor: "0" }, charge: { minor: "1000" }, due: { minor: "0" },
        period: { startsAt: subscription.period!.endsAt } });
      const now = await api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("11700", "Premium, one quarter"), timing: "now" });
      // Period 0 credits the recurring amount of then, not the first payment with its one-time part.
      expect(Number(now.credit.minor)).toBeGreaterThanOrEqual(2699);
      expect(Number(now.credit.minor)).toBeLessThanOrEqual(2700);
      expect(BigInt(now.due.minor)).toBe(BigInt(11700) - BigInt(now.credit.minor));
      await expect(api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("1000"), timing: "now" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(api.previewSubscriptionChange({ subscriptionId: id, recurring: { ...terms("1000"), amount: { currency: "EUR", minor: "1000" } }, timing: "period-end" }))
        .rejects.toMatchObject({ code: "invalid_input" });
      // Lead days are for payment-request only; a grace that the policy's retries would pass is refused.
      await expect(api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("1000"), leadDays: 3, timing: "period-end" })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("1000"), graceDays: 5, timing: "period-end" })).rejects.toMatchObject({ code: "invalid_input" });
      // Another consumer's subscription is nobody's to change.
      await expect((await service(OTHER_CONSUMER)).previewSubscriptionChange({ subscriptionId: id, recurring: terms("1000"), timing: "period-end" }))
        .rejects.toMatchObject({ code: "not_found" });
      expect((await api.subscriptionCredit(id))!.periodIndex).toBe(0);
    });

    it("applies a change now when its due is captured: a new term, a period under the new terms, and the entry's end follows", async () => {
      const { api, id, subscription, firstPayment } = await running();
      const pool = await requirePhiTestDatabase();
      // An entry bound to the subscription, as a Shop writes one.
      await registerProduct(pool, { siteId: site.id, supplier: SUPPLIER, listeners: [], draft: normalizePhisProductDraft({ key: `plan-${id.slice(0, 8)}`, type: "plan", title: "Plan", summary: "" }) });
      await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key: `plan-${id.slice(0, 8)}`, state: "active", listeners: [] });
      const product = `${SUPPLIER}:plan-${id.slice(0, 8)}` as PhisProductId;
      const subjectId = (await findEntitlementSubject(pool, site.id, await ensureEntitlementSubject(pool, site.id, await createPhiTestUser(site))))!.id;
      await grantEntitlement(pool, { siteId: site.id, subjectId, product, source: CONSUMER, reference: subscription.reference, startsAt: null, endsAt: null, quantity: null,
        counted: false, subscriptionId: id, listeners: [] });

      const premium = terms("11700", "Premium, one quarter");
      const quote = await api.previewSubscriptionChange({ subscriptionId: id, recurring: premium, timing: "now" });
      const request = { subscriptionId: id, recurring: premium, timing: "now" as const, reference: "up-1", idempotencyKey: randomUUID(),
        checkout: { methodKey: "card", checkoutKind: "redirect" as const, returnPath: "/return" } };
      // Shown less than it now costs: quote again.
      await expect(api.changeSubscription({ ...request, expectedDue: { currency: "CHF", minor: String(Number(quote.due.minor) - 10) } })).rejects.toMatchObject({ code: "quote_outdated" });

      const result = await api.changeSubscription({ ...request, expectedDue: { currency: "CHF", minor: String(Number(quote.due.minor) + 5) } });
      expect(result.change).toMatchObject({ status: "awaiting_payment", timing: "now", reference: "up-1", recurring: premium, effectiveAt: null });
      expect(result.payment!.payment).toMatchObject({ status: "awaiting_customer", reference: `${subscription.reference}~up-1`, amount: result.change.due, initiator: "customer" });
      // Under automatic the checkout stores the method anew.
      expect(result.payment!.payment.storedMethodId).not.toBeNull();
      expect(result.change.paymentId).toBe(result.payment!.payment.id);
      expect((await read(api, id)).pendingChange).toMatchObject({ id: result.change.id, status: "awaiting_payment" });
      // The same key answers the same change; another change waits until this one is decided.
      expect((await api.changeSubscription({ ...request, expectedDue: { currency: "CHF", minor: String(Number(quote.due.minor) + 5) } })).change.id).toBe(result.change.id);
      await expect(api.changeSubscription({ ...request, reference: "up-2", idempotencyKey: randomUUID(), expectedDue: result.change.due })).rejects.toMatchObject({ code: "invalid_state" });
      await expect(api.changeSubscriptionPrice({ subscriptionId: id, recurring: terms("3000") })).rejects.toMatchObject({ code: "invalid_state" });

      await pay(api, result.payment!.payment.id);
      const changed = await read(api, id);
      const [latest, earlier] = await api.listSubscriptionPeriods(id);
      expect(changed).toMatchObject({ status: "active", recurring: premium, pendingChange: null, period: { index: 1 }, term: { firstIndex: 1 },
        storedMethodId: result.payment!.payment.storedMethodId });
      expect(changed.storedMethodId).not.toBe(firstPayment.storedMethodId);
      expect(changed.term!.startsAt).toBe(changed.period!.startsAt);
      expect(changed.period!.endsAt).toBe(iso(addPhisPaymentIntervals(new Date(changed.period!.startsAt), QUARTER, 1)));
      expect(changed.nextChargeAt).toBe(changed.period!.endsAt);
      expect(latest).toMatchObject({ index: 1, status: "paid", changeId: result.change.id, amount: { minor: "11700" }, paymentIds: [result.payment!.payment.id] });
      expect(earlier).toMatchObject({ index: 0, endsAt: subscription.period!.endsAt, endedEarlyAt: changed.period!.startsAt });
      expect((await api.listSubscriptionChanges(id))[0]).toMatchObject({ id: result.change.id, status: "applied", periodIndex: 1, effectiveAt: changed.period!.startsAt });
      expect(await changeFacts(id)).toContain(result.change.id);
      // The bound entry reads its end from the new period, without a write.
      expect((await listEntitlements(pool, { siteId: site.id, subjectId, product }))[0]).toMatchObject({ endsAt: changed.period!.endsAt, standing: "valid" });
    });

    it("applies a change at once where nothing is due", async () => {
      const { api, id } = await running();
      const pool = await requirePhiTestDatabase();
      // The paid period made to run from yesterday for a year: its unused share holds still for hours.
      const startsAt = iso(new Date(Date.now() - DAY)); const endsAt = iso(new Date(Date.now() + 364 * DAY));
      await pool.query(`UPDATE phis.payment_subscription_periods SET record = record || jsonb_build_object('startsAt', $2::text, 'endsAt', $3::text)
        WHERE subscription_id = $1 AND period_index = 0`, [id, startsAt, endsAt]);
      await pool.query(`UPDATE phis.payment_subscriptions SET record = jsonb_set(jsonb_set(record, '{period,startsAt}', to_jsonb($2::text)), '{period,endsAt}', to_jsonb($3::text))
        WHERE id = $1`, [id, startsAt, endsAt]);
      const credit = (await api.subscriptionCredit(id))!.credit.minor;
      expect(credit).toBe(String(Math.floor(2700 * 364 / 365)));

      const result = await api.changeSubscription({ subscriptionId: id, recurring: terms(credit, "Same value, monthly"), interval: { unit: "month", count: 1 }, timing: "now",
        reference: "even", idempotencyKey: randomUUID(), expectedDue: { currency: "CHF", minor: "0" }, checkout: { methodKey: "card", checkoutKind: "redirect", returnPath: "/return" } });
      expect(result.payment).toBeNull();
      expect(result.change).toMatchObject({ status: "applied", due: { minor: "0" }, paymentId: null, periodIndex: 1 });
      expect(result.subscription).toMatchObject({ interval: { unit: "month", count: 1 }, period: { index: 1 }, pendingChange: null });
      expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "paid", paymentIds: [], changeId: result.change.id });
    });

    it("applies a period-end change at the boundary, before the period is charged, and starts a new term there", async () => {
      const { api, id, subscription } = await running();
      const monthly = { unit: "month", count: 1 } as const;
      const result = await api.changeSubscription({ subscriptionId: id, recurring: terms("1100", "Plan, one month"), interval: monthly, timing: "period-end",
        reference: "down", idempotencyKey: randomUUID(), expectedDue: { currency: "CHF", minor: "0" }, checkout: null });
      expect(result).toMatchObject({ payment: null, change: { status: "scheduled", effectiveAt: null } });
      expect((await read(api, id)).pendingChange).toMatchObject({ id: result.change.id, status: "scheduled" });

      const E = subscription.period!.endsAt;
      await api.advanceSubscription(id, shift(E, 1_000));
      expect(remote.charges).toHaveLength(1);
      expect(remote.charges[0]).toMatchObject({ amount: { minor: "1100" }, description: "Plan, one month" });
      const renewed = await read(api, id);
      expect(renewed).toMatchObject({ interval: monthly, pendingChange: null, term: { startsAt: E, firstIndex: 1 }, period: { index: 1, startsAt: E } });
      expect(renewed.period!.endsAt).toBe(iso(addPhisPaymentIntervals(new Date(E), monthly, 1)));
      expect((await api.listSubscriptionPeriods(id))[0]).toMatchObject({ index: 1, status: "paid", changeId: result.change.id });
      expect((await api.listSubscriptionChanges(id))[0]).toMatchObject({ status: "applied", effectiveAt: E, periodIndex: 1 });
      // The next boundary is counted from the new term.
      await api.advanceSubscription(id, shift(renewed.period!.endsAt, 1_000));
      expect((await read(api, id)).period!.endsAt).toBe(iso(addPhisPaymentIntervals(new Date(E), monthly, 2)));
    });

    it("voids an awaiting change whose payment expires, which is taken back, or which a renewal overtakes", async () => {
      const now = async (api: PhisPaymentEngine, id: string, reference: string) => {
        const quote = await api.previewSubscriptionChange({ subscriptionId: id, recurring: terms("11700"), timing: "now" });
        return api.changeSubscription({ subscriptionId: id, recurring: terms("11700"), timing: "now", reference, idempotencyKey: randomUUID(), expectedDue: quote.due,
          checkout: { methodKey: "card", checkoutKind: "redirect", returnPath: "/return" } });
      };
      // Expired.
      const first = await running();
      const expiring = await now(first.api, first.id, "exp");
      const state = remote.states.get(expiring.payment!.payment.id)!;
      state.status = "expired"; state.checkout = null;
      await first.api.refresh(expiring.payment!.payment.id);
      expect(await read(first.api, first.id)).toMatchObject({ pendingChange: null, recurring: { amount: { minor: "2700" } }, period: { index: 0 } });
      expect((await first.api.listSubscriptionChanges(first.id))[0]).toMatchObject({ status: "void" });

      // Taken back.
      const second = await running();
      const takenBack = await now(second.api, second.id, "back");
      expect(await second.api.cancelSubscriptionChange({ subscriptionId: second.id, changeId: takenBack.change.id })).toMatchObject({ status: "void" });
      expect((await read(second.api, second.id)).pendingChange).toBeNull();
      expect(await second.api.cancelSubscriptionChange({ subscriptionId: second.id, changeId: randomUUID() })).toBeNull();
      // Paid anyway afterwards, it changes nothing: the consumer refunds it.
      await pay(second.api, takenBack.payment!.payment.id);
      expect(await read(second.api, second.id)).toMatchObject({ period: { index: 0 }, recurring: { amount: { minor: "2700" } } });

      // Overtaken by the renewal.
      const third = await running();
      const overtaken = await now(third.api, third.id, "late");
      await third.api.advanceSubscription(third.id, shift(third.subscription.period!.endsAt, 1_000));
      expect(remote.charges.at(-1)).toMatchObject({ amount: { minor: "2700" } });
      expect(await read(third.api, third.id)).toMatchObject({ pendingChange: null, period: { index: 1 }, recurring: { amount: { minor: "2700" } } });
      expect((await third.api.listSubscriptionChanges(third.id))[0]).toMatchObject({ id: overtaken.change.id, status: "void" });
    });

    it("voids a scheduled change when the customer cancels at the period end, and resuming does not bring it back", async () => {
      const { api, id } = await running();
      const scheduled = await api.changeSubscription({ subscriptionId: id, recurring: terms("1100"), timing: "period-end", reference: "sched", idempotencyKey: randomUUID(),
        expectedDue: { currency: "CHF", minor: "0" }, checkout: null });
      const cancelled = await api.cancelSubscription({ subscriptionId: id, at: "period-end" });
      expect(cancelled).toMatchObject({ flags: PhisPaymentSubscriptionFlag.CancelAtPeriodEnd, pendingChange: null });
      expect((await api.listSubscriptionChanges(id))[0]).toMatchObject({ id: scheduled.change.id, status: "void" });
      expect(await api.resumeSubscription(id)).toMatchObject({ flags: 0, pendingChange: null });
      // Ending the subscription makes no change either.
      await expect(api.changeSubscription({ subscriptionId: id, recurring: terms("1100"), timing: "period-end", reference: "sched", idempotencyKey: randomUUID(),
        expectedDue: { currency: "CHF", minor: "0" }, checkout: null })).rejects.toMatchObject({ code: "idempotency_conflict" });
    });
  });

  describe("settlement records", () => {
    const record = (patch: Record<string, unknown> = {}) => ({ reference: `txn_${randomUUID()}`, gross: { currency: "CHF", minor: "1990" },
      settled: { currency: "CHF", minor: "1990" }, fee: { currency: "CHF", minor: "60" }, withheldTax: null, net: { currency: "CHF", minor: "1930" }, exchangeRate: null,
      availableAt: "2026-12-04T00:00:00.000Z", bookedAt: "2026-11-27T10:00:00.000Z", refund: null, ...patch });
    async function capturedPayment() {
      remote.currency = { ...TEST_CURRENCY_FEATURES, settlementCurrencies: ["CHF"], flags: PhisPaymentCurrencyFeatureFlag.SettlementRecords };
      const api = await service();
      const created = await api.create({ profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "1990" }, pricing: FINAL,
        description: "Lifetime", captureMode: "automatic", methodKey: "card", checkoutKind: "redirect", returnPath: "/return", documentSubject: "sub_test", documentLabel: "Order X" });
      await pay(api, created.payment.id);
      return { api, paymentId: created.payment.id };
    }
    const tasks = async (paymentId: string) => (await (await requirePhiTestDatabase()).query<{ kind: string; refund_id: string | null; state: string; attempts: number; last_error: string | null }>(
      "SELECT kind, refund_id::text, state, attempts, last_error FROM phis.payment_record_tasks WHERE payment_id = $1 ORDER BY id", [paymentId])).rows;
    const due = async (paymentId: string) => (await requirePhiTestDatabase()).query("UPDATE phis.payment_record_tasks SET next_attempt_at = NOW() WHERE payment_id = $1", [paymentId]);
    const collect = async () => collectPhisPaymentRecords({ pool: await requirePhiTestDatabase(), signal: new AbortController().signal, resolveProvider: async () => remote });

    it("writes a task with the capture where the method reports settlements, and only then", async () => {
      const { paymentId } = await capturedPayment();
      expect(await tasks(paymentId)).toEqual([{ kind: "settlements", refund_id: null, state: "pending", attempts: 0, last_error: null }]);
      const pool = await requirePhiTestDatabase();
      expect((await pool.query("SELECT document_subject, document_label FROM phis.payments WHERE id = $1", [paymentId])).rows[0])
        .toEqual({ document_subject: "sub_test", document_label: "Order X" });

      remote.currency = TEST_CURRENCY_FEATURES;
      const api = await service();
      const plain = await api.create({ profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "500" }, pricing: FINAL,
        description: "Plain", captureMode: "automatic", methodKey: "card", checkoutKind: "redirect", returnPath: "/return" });
      await pay(api, plain.payment.id);
      expect(await tasks(plain.payment.id)).toEqual([]);
    });

    it("asks again while the Provider has not booked it, records it once, and never rewrites it", async () => {
      const { api, paymentId } = await capturedPayment();
      await collect();
      expect(await tasks(paymentId)).toMatchObject([{ state: "pending", attempts: 1 }]);
      const pool = await requirePhiTestDatabase();
      const next = (await pool.query<{ next: Date }>("SELECT next_attempt_at AS next FROM phis.payment_record_tasks WHERE payment_id = $1", [paymentId])).rows[0]!.next;
      expect(next.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);

      const booked = record();
      remote.settlements.set(paymentId, { records: [booked], state: "complete" });
      await due(paymentId);
      await collect();
      expect(await tasks(paymentId)).toMatchObject([{ state: "done" }]);

      await expect(api.listSettlements(paymentId)).rejects.toMatchObject({ code: "forbidden" });
      const staff = await service(CONSUMER, true);
      const listed = await staff.listSettlements(paymentId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ paymentId, refundId: null, reference: booked.reference, fee: { currency: "CHF", minor: "60" }, net: { minor: "1930" }, exchangeRate: null });
      // Another consumer's payment is nobody's to read: answered as unknown.
      expect(await (await service(OTHER_CONSUMER, true)).listSettlements(paymentId)).toEqual([]);

      // A refund owes its own records, signed from the merchant's side: the money going out with a fee of
      // its own, the capture's fee given back, and a refund that failed coming back in -- all on the refund.
      // The capture's record, reported again with another fee, stays as it was.
      const refund = await api.refund({ paymentId, idempotencyKey: randomUUID(), minor: "1990", reason: "Return" });
      expect((await tasks(paymentId)).map(task => [task.refund_id, task.state])).toEqual([[null, "done"], [refund.refund!.id, "pending"]]);
      const binding = (await listPhisPaymentRefunds(pool, paymentId))[0]!.binding!;
      const chf = (minor: string) => ({ currency: "CHF", minor });
      const out = record({ refund: binding, settled: chf("-1990"), fee: chf("30"), net: chf("-2020"), exchangeRate: "0.9312000000" });
      const feeBack = record({ refund: binding, gross: chf("0"), settled: chf("0"), fee: chf("-60"), net: chf("60") });
      const cameBack = record({ refund: binding, settled: chf("1990"), fee: chf("0"), net: chf("1990"), bookedAt: "2026-11-28T10:00:00.000Z" });
      remote.settlements.set(paymentId, { state: "complete", records: [{ ...booked, fee: chf("99"), net: chf("1891") }, out, feeBack, cameBack] });
      await collect();
      expect((await tasks(paymentId)).map(task => task.state)).toEqual(["done", "done"]);
      const all = await staff.listSettlements(paymentId);
      expect(all.map(entry => [entry.refundId, entry.settled.minor, entry.fee.minor, entry.net.minor])).toEqual(expect.arrayContaining([
        [null, "1990", "60", "1930"], [refund.refund!.id, "-1990", "30", "-2020"], [refund.refund!.id, "0", "-60", "60"], [refund.refund!.id, "1990", "0", "1990"]]));
      expect(all).toHaveLength(4);
      expect(all.find(entry => entry.reference === out.reference)!.exchangeRate).toBe("0.9312");
      expect(all.at(-1)!.reference).toBe(cameBack.reference);
      // What the balance moved in sum: in 1930, out 2020, back 60 and 1990.
      expect(all.reduce((sum, entry) => sum + BigInt(entry.net.minor), BigInt(0))).toBe(BigInt(1960));
    });

    it("refuses a record whose sums do not add up, and records nothing of the answer", async () => {
      const { paymentId } = await capturedPayment();
      remote.settlements.set(paymentId, { state: "complete", records: [record({ net: { currency: "CHF", minor: "1931" } })] });
      await collect();
      expect(await tasks(paymentId)).toMatchObject([{ state: "pending", attempts: 1 }]);
      expect((await tasks(paymentId))[0]!.last_error).toMatch(/inconsistent/);
      // Nor one in another settlement currency per amount, or in another gross currency than the payment's.
      // Nor a negative zero, a negative gross, or the old unsigned reading of a refund (settled positive, net its sum with a fee).
      for (const bad of [record({ fee: { currency: "EUR", minor: "60" } }), record({ gross: { currency: "EUR", minor: "1990" } }),
        record({ fee: { currency: "CHF", minor: "-0" }, net: { currency: "CHF", minor: "1990" } }), record({ gross: { currency: "CHF", minor: "-1990" } }),
        record({ settled: { currency: "CHF", minor: "-1990" }, fee: { currency: "CHF", minor: "30" }, net: { currency: "CHF", minor: "-1960" } })]) {
        remote.settlements.set(paymentId, { state: "complete", records: [bad] });
        await due(paymentId); await collect();
      }
      expect(await (await service(CONSUMER, true)).listSettlements(paymentId)).toEqual([]);
      expect(await tasks(paymentId)).toMatchObject([{ state: "pending", attempts: 6 }]);
    });

    it("gives a task up after 14 days", async () => {
      const { paymentId } = await capturedPayment();
      await (await requirePhiTestDatabase()).query("UPDATE phis.payment_record_tasks SET created_at = NOW() - INTERVAL '14 days' WHERE payment_id = $1", [paymentId]);
      await collect();
      expect(await tasks(paymentId)).toMatchObject([{ state: "failed" }]);
    });
  });
});
