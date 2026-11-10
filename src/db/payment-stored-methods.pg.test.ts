import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisPaymentPricing } from "@phis/contracts/payments";
import { PhisPaymentEngine } from "@/lib/payments/engine";
import { buildPhisPaymentNotificationsCapability } from "@/lib/payments/runtime";
import { readPhisPaymentProfile, recordPhisPaymentProfileProbe, setPhisPaymentProfileEnabled, writePhisPaymentProfile } from "./payments.mts";
import { closePhiTestPool, createPhiTestSite, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";
import { StoringProvider } from "../../test/pg/payment-storing-provider";

const providerBinding = vi.hoisted(() => ({ addonId: "@pgtest/stored-provider", factory: null as null | (() => unknown) }));
vi.mock("@/lib/addons/services.ts", () => ({ resolvePhisServiceProvider: async () => ({ addonId: providerBinding.addonId, factory: providerBinding.factory }) }));
vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
const CONSUMER = "@pgtest/stored-consumer";
const OTHER_CONSUMER = "@pgtest/stored-other";

describe("stored payment methods and charges without the customer", () => {
  let site: PhiTestSite;
  const remote = new StoringProvider();
  const FINAL: PhisPaymentPricing = { basis: "final", tax: "none" };

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("stored-methods");
    providerBinding.factory = () => remote;
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query(`INSERT INTO phis.server_addons
      (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    const policy = { roles: [], jobs: [], events: [] };
    const profile = await writePhisPaymentProfile(pool, site.id, providerBinding.addonId, {
      key: "sandbox", providerKey: "@pgtest/stored-provider/test", mode: "test", credentialReferences: {}, grants: [
        { consumerAddonId: CONSUMER, operations: ["read", "create", "refresh", "refund", "method-store", "method-read", "method-remove"], merchantActions: { capture: policy, cancel: policy, refund: policy } },
        // May take payments, and was never given the right to keep the means.
        { consumerAddonId: OTHER_CONSUMER, operations: ["read", "create", "refresh"], merchantActions: { capture: policy, cancel: policy, refund: policy } },
      ],
    }, false);
    await recordPhisPaymentProfileProbe(pool, profile, "acct_stored", "test");
    await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, site.id, "sandbox"))!, true);
  });
  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; the product deliberately exposes no financial purge.
    await pool.query("DELETE FROM phis.addon_event_outbox WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_refunds WHERE payment_id IN (SELECT id FROM phis.payments WHERE site_id = $1)", [site.id]);
    await pool.query("DELETE FROM phis.payment_operations WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_stored_methods WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payments WHERE site_id = $1", [site.id]);
    await pool.query("DELETE FROM phis.payment_profiles WHERE site_id = $1", [site.id]);
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query("DELETE FROM phis.server_addons WHERE addon_id = $1", [addon]);
    await dropPhiTestSites(); await closePhiTestPool();
  });
  beforeEach(() => { remote.next = "paid"; remote.revokeOutcome = "revoked"; remote.setupOutcome = "applied"; remote.charges = []; remote.probes = []; });

  async function service(consumerAddonId = CONSUMER) {
    return new PhisPaymentEngine({ pool: await requirePhiTestDatabase(), scope: { siteId: site.id, siteKey: site.key, consumerAddonId },
      signal: new AbortController().signal, publicBaseUrl: async () => `https://${site.key}.invalid`, resolveProvider: async () => remote, merchantAuthorized: async () => true });
  }
  function purchase(overrides = {}) {
    return { profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "6300" }, pricing: FINAL,
      description: "First period", captureMode: "automatic" as const, methodKey: "card" as string | null, checkoutKind: "redirect" as const, returnPath: "/return", ...overrides };
  }
  function renewal(storedMethodId: string, overrides = {}) {
    return { storedMethodId, reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "2700" }, pricing: FINAL,
      description: "Next period", initiator: "schedule" as const, ...overrides };
  }
  /** A payer who bought with `store` and finished the hosted page: the usual way a stored method exists. */
  async function storedMethod(payerReference = `payer-${randomUUID()}`, methodKey = "card") {
    const api = await service();
    const created = await api.create(purchase({ methodKey, store: { payerReference } }));
    remote.customerPays(created.payment.id);
    const payment = await api.refresh(created.payment.id);
    return { api, payerReference, paymentId: created.payment.id, methodId: payment!.storedMethodId! };
  }

  it("offers for a recurring use only what can be stored, and says how each method can be", async () => {
    const api = await service();
    const selector = { profileKey: "sandbox", amount: { currency: "CHF", minor: "6300" }, captureMode: "automatic" as const, checkoutKind: "redirect" as const,
      pricing: { basis: "final" as const, tax: "none" as const, discounts: 0, promotionCodes: "none" as const } };

    const once = await api.listMethods(selector);
    const recurring = await api.listMethods({ ...selector, usage: "recurring" });

    expect(once.map(method => method.methodKey)).toEqual(["card", "wallet", "invoice"]);
    expect(recurring.map(method => method.methodKey)).toEqual(["card", "wallet"]);
    expect(recurring[1]!.features.stored).toMatchObject({ perPayer: "single", chargeResult: "immediate", expires: false });
    expect(once[2]!.features.stored).toBeNull();
    // The Provider is told what is wanted, so it can leave out what it cannot charge for this amount.
    expect(remote.probes).toEqual([undefined, "recurring"]);
  });

  it("stores the method the customer paid with, and knows it only once the Provider has it", async () => {
    const api = await service();
    const payerReference = `payer-${randomUUID()}`;

    const created = await api.create(purchase({ store: { payerReference } }));

    expect(created.payment).toMatchObject({ initiator: "customer", status: "awaiting_customer" });
    const pending = await api.getStoredMethod(created.payment.storedMethodId!);
    expect(pending).toMatchObject({ status: "pending", payerReference, methodKey: "card", display: { title: "Test card", hint: null }, mode: "test" });

    remote.customerPays(created.payment.id);
    const paid = await api.refresh(created.payment.id);

    expect(paid!.status).toBe("captured");
    const active = await api.getStoredMethod(paid!.storedMethodId!);
    expect(active).toMatchObject({ status: "active", display: { title: "Visa", hint: "ends 4242" }, expiresAt: "2031-01-31T23:59:59.000Z" });
    expect(active!.version).toBeGreaterThan(pending!.version);
    expect((await api.listStoredMethods({ profileKey: "sandbox", payerReference })).map(method => method.id)).toEqual([active!.id]);
    // Nothing a consumer reads names the Provider's own reference.
    expect(JSON.stringify(active)).not.toContain("pm-");
  });

  it("tells the consumer when the method becomes active after the payment was already captured", async () => {
    const api = await service();
    const created = await api.create(purchase({ store: { payerReference: `payer-${randomUUID()}` } }));
    remote.customerPays(created.payment.id, null);
    const captured = await api.refresh(created.payment.id);
    expect((await api.getStoredMethod(captured!.storedMethodId!))!.status).toBe("pending");

    // The Provider reports the method a moment later, with nothing else about the payment changed.
    const state = remote.states.get(created.payment.id)!;
    state.storedMethod = { binding: { reference: `pm-${randomUUID()}`, data: {} }, display: { title: "Visa", hint: null }, status: "active", expiresAt: null };
    const later = await api.refresh(created.payment.id);

    expect(later!.version).toBeGreaterThan(captured!.version);
    expect((await api.getStoredMethod(later!.storedMethodId!))!.status).toBe("active");
  });

  it("ends a method that never came to exist when its payment ends without one", async () => {
    const api = await service();
    const created = await api.create(purchase({ store: { payerReference: `payer-${randomUUID()}` } }));
    const state = remote.states.get(created.payment.id)!;
    state.status = "expired"; state.checkout = null;

    const expired = await api.refresh(created.payment.id);

    expect(expired!.status).toBe("expired");
    expect((await api.getStoredMethod(expired!.storedMethodId!))!.status).toBe("invalid");
  });

  it("stores nothing for a method that cannot be stored, or under a grant that does not include it", async () => {
    const api = await service();
    await expect(api.create(purchase({ methodKey: "invoice", store: { payerReference: "payer-a" } }))).rejects.toMatchObject({ code: "method_unavailable" });

    const other = await service(OTHER_CONSUMER);
    // The right to take a payment is not the right to keep the means.
    await expect(other.create(purchase({ store: { payerReference: "payer-a" } }))).rejects.toMatchObject({ code: "not_found" });
    expect((await other.create(purchase())).payment.storedMethodId).toBeNull();
  });

  it("charges a stored method as an ordinary payment with no checkout, once per key", async () => {
    const { api, methodId, payerReference } = await storedMethod();
    const input = renewal(methodId);

    const charged = await api.chargeStoredMethod(input);

    expect(charged.payment).toMatchObject({ status: "captured", capturedMinor: "2700", initiator: "schedule", storedMethodId: methodId, checkout: null, captureMode: "automatic" });
    expect(charged.operation).toMatchObject({ action: "charge", state: "succeeded", errorCode: null });
    expect(remote.charges[0]).toMatchObject({ action: "charge", sequence: "scheduled", payerReference, methodKey: "card", amount: { currency: "CHF", minor: "2700" } });
    expect((await api.get(charged.payment.id))!.status).toBe("captured");

    // The same key is the same charge: answered again, and not sent again.
    const again = await api.chargeStoredMethod(input);
    expect(again.payment.id).toBe(charged.payment.id);
    expect(remote.charges).toHaveLength(1);
    await expect(api.chargeStoredMethod({ ...input, amount: { currency: "CHF", minor: "9999" } })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // A captured renewal is refunded like any other payment.
    const refunded = await api.refund({ paymentId: charged.payment.id, idempotencyKey: randomUUID(), minor: "700", reason: "Goodwill" });
    expect(refunded.refund).toMatchObject({ status: "succeeded", amount: { currency: "CHF", minor: "700" } });
    expect(refunded.payment.refundedMinor).toBe("700");
  });

  it("answers a declined charge as a failed payment and keeps the method", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "declined";

    const declined = await api.chargeStoredMethod(renewal(methodId));

    expect(declined.payment.status).toBe("failed");
    expect(declined.operation).toMatchObject({ state: "failed", errorCode: "payment_declined" });
    expect((await api.getStoredMethod(methodId))!.status).toBe("active");
    // A later attempt is a new payment under the same business reference.
    const retried = await api.chargeStoredMethod(renewal(methodId, { reference: declined.payment.reference }));
    expect(retried.payment.status).toBe("captured");
  });

  it("says that the customer has to return, which no retry can cure", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "customer";

    const refused = await api.chargeStoredMethod(renewal(methodId));

    expect(refused.payment.status).toBe("failed");
    expect(refused.operation.errorCode).toBe("customer_action_required");
    expect((await api.getStoredMethod(methodId))!.status).toBe("active");
  });

  it("ends a method the Provider says is gone, and charges it no more", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "gone";

    const refused = await api.chargeStoredMethod(renewal(methodId));

    expect(refused.operation.errorCode).toBe("stored_method_unavailable");
    expect((await api.getStoredMethod(methodId))!.status).toBe("invalid");
    remote.charges = [];
    await expect(api.chargeStoredMethod(renewal(methodId))).rejects.toMatchObject({ code: "stored_method_unavailable" });
    expect(remote.charges).toHaveLength(0);
  });

  it("waits for a charge the Provider answers later", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "pending";

    const pending = await api.chargeStoredMethod(renewal(methodId));
    expect(pending.payment.status).toBe("processing");
    expect(pending.operation.state).toBe("pending");

    const state = remote.states.get(pending.payment.id)!;
    state.status = "captured"; state.capturedMinor = "2700";
    expect((await api.refresh(pending.payment.id))!.status).toBe("captured");
  });

  it("does not charge twice when the first answer was lost", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "unknown";
    const input = renewal(methodId);

    const lost = await api.chargeStoredMethod(input);
    expect(lost.payment.reconciliationRequired).toBe(true);
    expect(lost.operation.state).toBe("indeterminate");

    // Asking again recovers what happened; it does not send the charge a second time.
    const recovered = await api.chargeStoredMethod(input);
    expect(recovered.payment).toMatchObject({ id: lost.payment.id, status: "captured", reconciliationRequired: false });
    expect(remote.charges).toHaveLength(1);
  });

  it("does not take a checkout for an answer to a charge", async () => {
    const { api, methodId } = await storedMethod();
    remote.next = "awaiting";

    const odd = await api.chargeStoredMethod(renewal(methodId));

    // Nobody is there to be sent to a page; the answer is not believed and the charge stays unresolved.
    expect(odd.payment.checkout).toBeNull();
    expect(odd.payment.status).not.toBe("awaiting_customer");
    expect(odd.operation.state).toBe("indeterminate");
  });

  it("charges only what the method was stored to carry", async () => {
    const { api, methodId } = await storedMethod();
    const net: PhisPaymentPricing = { basis: "net", tax: "provider", promotionCodes: "none", customer: null,
      lineItems: [{ reference: "plan", description: "Plan", quantity: 1, unitMinor: "2700", taxCategory: "general", providerTaxCodes: null }], shipping: null, discounts: [] };

    // A hosted page can compute tax; a charge without one can only where the method says so.
    await expect(api.chargeStoredMethod(renewal(methodId, { pricing: net }))).rejects.toMatchObject({ code: "unsupported_operation" });
    expect(remote.charges).toHaveLength(0);
  });

  it("removes a method at the Provider first, and keeps it when the Provider does not confirm", async () => {
    const { api, methodId } = await storedMethod();
    remote.revokeOutcome = "unknown";
    await expect(api.removeStoredMethod(methodId)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await api.getStoredMethod(methodId))!.status).toBe("active");

    remote.revokeOutcome = "revoked";
    const removed = await api.removeStoredMethod(methodId);

    expect(removed!.status).toBe("revoked");
    expect(remote.revoked.at(-1)).toMatch(/^pm-/u);
    await expect(api.chargeStoredMethod(renewal(methodId))).rejects.toMatchObject({ code: "stored_method_unavailable" });
    // Removing what is already gone asks nobody again.
    const calls = remote.revoked.length;
    expect((await api.removeStoredMethod(methodId))!.status).toBe("revoked");
    expect(remote.revoked).toHaveLength(calls);
  });

  it("replaces the payer's method where the Provider keeps one per payer", async () => {
    const payer = `payer-${randomUUID()}`;
    const first = await storedMethod(payer, "wallet");
    const second = await storedMethod(payer, "wallet");
    const card = await storedMethod(payer, "card");

    const api = await service();
    expect((await api.getStoredMethod(first.methodId))!.status).toBe("revoked");
    expect((await api.getStoredMethod(second.methodId))!.status).toBe("active");
    // Another method of the same payer is another matter.
    expect((await api.getStoredMethod(card.methodId))!.status).toBe("active");
  });

  it("follows a method the payer withdrew outside phis", async () => {
    const { api, methodId } = await storedMethod();
    const reference = [...remote.methods.keys()].at(-1)!;
    remote.methods.get(reference)!.status = "revoked";

    const answer = await buildPhisPaymentNotificationsCapability({ scope: { siteId: site.id, siteKey: site.key, consumerAddonId: providerBinding.addonId },
      method: "POST", headers: {}, body: Buffer.from(JSON.stringify({ reference, id: randomUUID() })), signal: new AbortController().signal }).receive({ profileKey: "sandbox" });

    expect(answer.outcome).toBe("processed");
    expect((await api.getStoredMethod(methodId))!.status).toBe("revoked");
    // A late word that it is active does not bring it back.
    remote.methods.get(reference)!.status = "active";
    await buildPhisPaymentNotificationsCapability({ scope: { siteId: site.id, siteKey: site.key, consumerAddonId: providerBinding.addonId },
      method: "POST", headers: {}, body: Buffer.from(JSON.stringify({ reference, id: randomUUID() })), signal: new AbortController().signal }).receive({ profileKey: "sandbox" });
    expect((await api.getStoredMethod(methodId))!.status).toBe("revoked");
  });

  const setupInput = (overrides = {}) => ({ profileKey: "sandbox", idempotencyKey: randomUUID(), payerReference: `payer-${randomUUID()}`,
    amount: { currency: "CHF", minor: "2700" }, methodKey: "card" as string | null, checkoutKind: "redirect" as const, returnPath: "/methods", ...overrides });

  it("stores a method without a payment, once per key, and knows it when the customer has finished", async () => {
    const api = await service();
    const input = setupInput();
    remote.setupCalls = [];

    const opened = await api.setupMethod(input);

    expect(opened.storedMethod).toMatchObject({ status: "pending", payerReference: input.payerReference, methodKey: "card" });
    expect(opened.checkout).toEqual({ kind: "redirect", url: `https://provider.example/setup/${opened.storedMethod.id}`, expiresAt: null });
    // The customer comes back to the Site with the record's own id, not with a payment's.
    expect(remote.setupCalls[0]!.returnUrl).toBe(`https://${site.key}.invalid/methods?storedMethodId=${opened.storedMethod.id}`);

    // The same request is the same page, and the Provider is not asked for a second one.
    const again = await api.setupMethod(input);
    expect(again).toEqual(opened);
    expect(remote.setupCalls).toHaveLength(1);
    await expect(api.setupMethod({ ...input, payerReference: "somebody-else" })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // Not finished yet: asking changes nothing.
    expect((await api.refreshStoredMethod(opened.storedMethod.id))!.status).toBe("pending");
    remote.customerSetsUp(opened.storedMethod.id);
    const stored = await api.refreshStoredMethod(opened.storedMethod.id);

    expect(stored).toMatchObject({ status: "active", display: { title: "Visa", hint: "ends 4242" }, expiresAt: "2031-01-31T23:59:59.000Z" });
    // Stored without a payment, charged like any other.
    const charged = await api.chargeStoredMethod(renewal(opened.storedMethod.id));
    expect(charged.payment).toMatchObject({ status: "captured", storedMethodId: opened.storedMethod.id });
    // Once it exists there is no page to send anybody to any more.
    expect((await api.setupMethod(input)).checkout).toBeNull();
  });

  it("ends a set-up the customer never finished, and one for which no page could be opened", async () => {
    const api = await service();
    const abandoned = await api.setupMethod(setupInput());
    remote.setups.get(`setup-${abandoned.storedMethod.id}`)!.state = "expired";
    expect((await api.refreshStoredMethod(abandoned.storedMethod.id))!.status).toBe("invalid");

    const refused = setupInput();
    remote.setupOutcome = "rejected";
    await expect(api.setupMethod(refused)).rejects.toMatchObject({ code: "provider_rejected" });
    remote.setupOutcome = "unknown";
    const lost = setupInput();
    await expect(api.setupMethod(lost)).rejects.toMatchObject({ code: "provider_unavailable" });
    remote.setupOutcome = "applied";
    // Neither left a record waiting for a customer who has nowhere to go.
    for (const input of [refused, lost]) {
      const [left] = await api.listStoredMethods({ profileKey: "sandbox", payerReference: input.payerReference });
      expect(left).toMatchObject({ status: "invalid" });
    }
  });

  it("sets up alone only what says it can be, under the right to store", async () => {
    const api = await service();
    // The wallet is stored with a payment and in no other way.
    await expect(api.setupMethod(setupInput({ methodKey: "wallet" }))).rejects.toMatchObject({ code: "unsupported_operation" });
    await expect(api.setupMethod(setupInput({ methodKey: "invoice" }))).rejects.toMatchObject({ code: "method_unavailable" });
    const other = await service(OTHER_CONSUMER);
    await expect(other.setupMethod(setupInput())).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps one consumer's stored methods from another", async () => {
    const { methodId, payerReference } = await storedMethod();
    const other = await service(OTHER_CONSUMER);

    expect(await other.getStoredMethod(methodId)).toBeNull();
    expect(await other.removeStoredMethod(methodId)).toBeNull();
    await expect(other.chargeStoredMethod(renewal(methodId))).rejects.toMatchObject({ code: "not_found" });
    await expect(other.listStoredMethods({ profileKey: "sandbox", payerReference })).rejects.toMatchObject({ code: "not_found" });
  });
});
