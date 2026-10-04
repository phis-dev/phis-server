import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PhisPaymentProviderCommand, PhisPaymentProviderExecution, PhisPaymentProviderObservation, PhisPaymentProviderV1 } from "@phis/contracts/payments";
import { PhisPaymentEngine } from "@/lib/payments/engine";
import { buildPhisPaymentNotificationsCapability } from "@/lib/payments/runtime";
import { schedulePhisAddonEventDelivery } from "@/lib/addons/event-trigger.ts";
import { withPoolTransaction } from "@/lib/db-transaction";
import { claimPhisPaymentReceipt, findPhisPaymentForNotification, listPhisPaymentRefunds, readPhisPayment, readPhisPaymentProfile,
  recordPhisPaymentProfileProbe, setPhisPaymentProfileEnabled, writePhisPaymentProfile, claimPhisPayment } from "./payments.mts";
import { closePhiTestPool, createPhiTestSite, dropPhiTestSites, requirePhiTestDatabase, type PhiTestSite } from "../../test/pg/harness";

const providerBinding = vi.hoisted(() => ({ addonId: "@pgtest/payment-provider", factory: null as null | (() => unknown) }));
vi.mock("@/lib/addons/services.ts", () => ({ resolvePhisServiceProvider: async () => ({ addonId: providerBinding.addonId, factory: providerBinding.factory }) }));
vi.mock("@/lib/addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));
const CONSUMER = "@pgtest/payment-consumer";
const OTHER_CONSUMER = "@pgtest/payment-other";

class FakeProvider implements PhisPaymentProviderV1 {
  states = new Map<string, PhisPaymentProviderObservation>();
  calls: Record<string, number> = {};
  unknownAfter: string | null = null;
  malformedRefusal = false;
  unavailable = false;
  pause: Promise<void> | null = null;
  entered: (() => void) | null = null;
  async probe() { return { merchantIdentity: "acct_test", mode: "test" as const, methods: [{ methodKey: "card", title: "Test card",
    features: { captureModes: ["automatic", "manual"] as const, checkoutKinds: ["redirect"] as const, canPartialCapture: true, canCancel: true, canRefund: true, canPartialRefund: true } }] }; }
  async execute(command: PhisPaymentProviderCommand): Promise<PhisPaymentProviderExecution> {
    this.calls[command.action] = (this.calls[command.action] ?? 0) + 1;
    this.entered?.(); if (this.pause) await this.pause;
    let state = this.states.get(command.paymentId);
    if (command.action === "create") {
      state = { binding: { reference: `remote-${command.paymentId}`, data: { id: command.paymentId } }, merchantIdentity: "acct_test", mode: "test",
        status: "awaiting_customer", amount: command.amount, authorizedMinor: "0", capturedMinor: "0", authorizationExpiresAt: null,
        checkout: { kind: "redirect", url: "https://provider.example/checkout#provider-fragment", expiresAt: null }, refunds: [] };
      this.states.set(command.paymentId, state);
    }
    if (!state) throw new Error("Missing test remote payment");
    if (command.action === "capture") { state.status = "captured"; state.capturedMinor = command.minor; state.authorizedMinor = "0"; state.checkout = null; }
    if (command.action === "cancel") { state.status = "expired"; state.checkout = null; state.authorizedMinor = "0"; }
    if (command.action === "refund") state.refunds = [...state.refunds, { operationId: command.operationId, minor: command.minor, status: "succeeded",
      binding: { reference: randomUUID(), data: {} } }];
    if (this.unknownAfter === command.action) { this.unknownAfter = null; return { outcome: "unknown" }; }
    if (this.malformedRefusal) { this.malformedRefusal = false; return { outcome: "rejected", code: "sensitive-provider-error" } as unknown as PhisPaymentProviderExecution; }
    return { outcome: "applied", observation: structuredClone(state) };
  }
  async observe({ binding }: Parameters<PhisPaymentProviderV1["observe"]>[0]) {
    if (this.unavailable) throw new Error("Provider is unavailable");
    const state = this.states.get(binding.data.id!);
    if (!state) throw new Error("Missing test remote payment");
    return structuredClone(state);
  }
  async recover({ command }: Parameters<PhisPaymentProviderV1["recover"]>[0]): Promise<PhisPaymentProviderExecution> {
    if (this.unavailable) return { outcome: "unknown" };
    const state = this.states.get(command.paymentId);
    return state ? { outcome: "applied", observation: structuredClone(state) } : { outcome: "unknown" };
  }
  async verifyNotification(input: Parameters<PhisPaymentProviderV1["verifyNotification"]>[0]) {
    if (input.headers.signature !== "verified") return { outcome: "rejected" as const };
    const body = JSON.parse(Buffer.from(input.body).toString()) as { paymentId: string; id: string; irrelevant?: boolean };
    return body.irrelevant ? { outcome: "irrelevant" as const } : { outcome: "verified" as const, reference: body.paymentId, deliveryId: body.id };
  }
}

describe("durable Payment execution", () => {
  let site: PhiTestSite; let otherSite: PhiTestSite;
  const remote = new FakeProvider();
  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("payments"); otherSite = await createPhiTestSite("payments-other");
    providerBinding.factory = () => remote;
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query(`INSERT INTO phis.server_addons
      (addon_id, package_name, package_version, server_abi, manifest_digest, release_build_id)
      VALUES ($1, $1, '0.1.0', '^1', repeat('0', 64), 'pgtest') ON CONFLICT (addon_id) DO NOTHING`, [addon]);
    for (const selected of [site, otherSite]) {
      const policy = { roles: [], jobs: [], events: [] };
      const profile = await writePhisPaymentProfile(pool, selected.id, providerBinding.addonId, {
        key: "sandbox", providerKey: "@pgtest/payment-provider/test", mode: "test", credentialReferences: {}, grants: [CONSUMER, OTHER_CONSUMER].map(consumerAddonId => ({
          consumerAddonId, operations: ["read", "create", "complete", "refresh", "capture", "cancel", "refund"], merchantActions: { capture: policy, cancel: policy, refund: policy },
        })),
      }, false);
      await recordPhisPaymentProfileProbe(pool, profile, "acct_test", "test");
      await setPhisPaymentProfileEnabled(pool, (await readPhisPaymentProfile(pool, selected.id, "sandbox"))!, true);
    }
  });
  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    // Fixture-only teardown; the product deliberately exposes no financial purge.
    for (const selected of [site, otherSite].filter(Boolean)) {
      await pool.query("DELETE FROM phis.addon_event_outbox WHERE site_id = $1", [selected.id]);
      await pool.query("DELETE FROM phis.payment_notification_receipts WHERE site_id = $1", [selected.id]);
      await pool.query("DELETE FROM phis.payment_refunds WHERE payment_id IN (SELECT id FROM phis.payments WHERE site_id = $1)", [selected.id]);
      await pool.query("DELETE FROM phis.payment_operations WHERE site_id = $1", [selected.id]);
      await pool.query("DELETE FROM phis.payments WHERE site_id = $1", [selected.id]);
      await pool.query("DELETE FROM phis.payment_profiles WHERE site_id = $1", [selected.id]);
    }
    for (const addon of [providerBinding.addonId, CONSUMER, OTHER_CONSUMER]) await pool.query("DELETE FROM phis.server_addons WHERE addon_id = $1", [addon]);
    await dropPhiTestSites(); await closePhiTestPool();
  });
  async function service(selected = site, consumerAddonId = CONSUMER, merchant = true) {
    return new PhisPaymentEngine({ pool: await requirePhiTestDatabase(), scope: { siteId: selected.id, siteKey: selected.key, consumerAddonId },
      signal: new AbortController().signal, publicBaseUrl: async () => `https://${selected.key}.invalid`, resolveProvider: async () => remote, merchantAuthorized: async () => merchant });
  }
  function input(overrides = {}) { return { profileKey: "sandbox", reference: randomUUID(), idempotencyKey: randomUUID(), amount: { currency: "CHF", minor: "1990" },
    description: "Test purchase", captureMode: "automatic" as const, methodKey: "card", checkoutKind: "redirect" as const, returnPath: "/return", ...overrides }; }
  async function captured() {
    const api = await service(); const result = await api.create(input()); const state = remote.states.get(result.payment.id)!;
    state.status = "captured"; state.capturedMinor = "1990"; state.checkout = null;
    await api.refresh(result.payment.id);
    return { api, id: result.payment.id, state };
  }
  function hook(paymentId: string, id = randomUUID(), signature = "verified") {
    return buildPhisPaymentNotificationsCapability({ scope: { siteId: site.id, siteKey: site.key, consumerAddonId: providerBinding.addonId },
      method: "POST", headers: { signature }, body: Buffer.from(JSON.stringify({ paymentId, id })), signal: new AbortController().signal });
  }

  it("creates CHF, EUR and USD independently and stores their exponents", async () => {
    const api = await service();
    for (const currency of ["CHF", "EUR", "USD"]) {
      const result = await api.create(input({ amount: { currency, minor: "1990" } }));
      expect(result.payment.amount).toEqual({ currency, minor: "1990" });
      expect(result.operation.state).toBe("succeeded");
      expect((await readPhisPayment(await requirePhiTestDatabase(), site.id, result.payment.id))?.currencyExponent).toBe(2);
    }
  });
  it("creates the checked Payment/outbox structure on a fresh schema", async () => {
    const pool = await requirePhiTestDatabase(); const client = await pool.connect();
    const schema = `pgtest_payment_ddl_${randomUUID().replaceAll("-", "")}`;
    // Only a fixture-owned scratch namespace is created, and the whole DDL is rolled back.
    const ddl = (await readFile(new URL("../../scripts/sql/001_create_phis.pgsql", import.meta.url), "utf8")).replace(/\bphis\b/g, schema);
    try {
      await client.query("BEGIN"); await client.query(ddl);
      const columns = (await client.query<{ column_name: string; is_nullable: string }>(
        "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'addon_event_outbox'", [schema])).rows;
      expect(columns.find(c => c.column_name === "thread_id")?.is_nullable).toBe("YES");
      expect(columns.some(c => c.column_name === "payment_id")).toBe(true);
      const constraints = (await client.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = 'addon_event_outbox'", [schema])).rows;
      expect(constraints.some(c => c.conname === "addon_event_outbox_subject_check")).toBe(true);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("reuses a durable command without a second remote operation and rejects changed arguments", async () => {
    const api = await service(); const args = input(); const count = remote.calls.create ?? 0;
    const first = await api.create(args); const retry = await api.create(args);
    expect(retry.operation.id).toBe(first.operation.id); expect(remote.calls.create).toBe(count + 1);
    await expect(api.create({ ...args, amount: { currency: "CHF", minor: "1991" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
  it("returns one reserved operation to concurrent identical callers", async () => {
    const api = await service(); const args = input(); let release!: () => void;
    remote.pause = new Promise<void>(r => { release = r; });
    let entered!: () => void; const entry = new Promise<void>(r => { entered = r; }); remote.entered = entered;
    const count = remote.calls.create ?? 0; const first = api.create(args); await entry;
    const concurrent = await api.create(args); expect(concurrent.operation.state).toBe("reserved");
    release(); await first; remote.pause = null; remote.entered = null;
    expect(remote.calls.create).toBe(count + 1);
  });
  it("blocks another active attempt, but permits a new attempt after confirmed expiry", async () => {
    const api = await service(); const args = input(); const result = await api.create(args);
    await expect(api.create({ ...args, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "active_attempt_exists" });
    await api.cancel({ paymentId: result.payment.id, idempotencyKey: randomUUID() });
    expect((await api.create({ ...args, idempotencyKey: randomUUID() })).payment.id).not.toBe(result.payment.id);
  });
  it("hides payments, operations and refunds from another Site or consumer", async () => {
    const api = await service(); const result = await api.create(input());
    for (const inaccessible of [await service(otherSite), await service(site, OTHER_CONSUMER)]) {
      expect(await inaccessible.get(result.payment.id)).toBeNull(); expect(await inaccessible.getOperation(result.operation.id)).toBeNull();
      await expect(inaccessible.cancel({ paymentId: result.payment.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    }
    const { id } = await captured(); const refund = await api.refund({ paymentId: id, idempotencyKey: randomUUID(), minor: "500", reason: "Return" });
    expect(await (await service(site, OTHER_CONSUMER)).getRefund(refund.refund!.id)).toBeNull();
  });
  it("requires merchant authority in addition to an operation grant", async () => {
    const { id } = await captured(); const customer = await service(site, CONSUMER, false);
    await expect(customer.refund({ paymentId: id, idempotencyKey: randomUUID(), minor: "500", reason: "Return" })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("recovers remote acceptance after a timeout without recreating a checkout", async () => {
    const api = await service(); const args = input(); remote.unknownAfter = "create";
    const count = remote.calls.create ?? 0; const result = await api.create(args);
    expect(result.operation.state).toBe("indeterminate"); expect(result.payment.reconciliationRequired).toBe(true);
    const retry = await api.create(args); expect(retry.operation.state).toBe("succeeded"); expect(retry.payment.reconciliationRequired).toBe(false);
    expect(remote.calls.create).toBe(count + 1);
  });
  it("does not persist or expose a malformed Provider refusal after submission", async () => {
    const api = await service(); remote.malformedRefusal = true;
    const result = await api.create(input());
    expect(result.operation.state).toBe("indeterminate");
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-error");
    await api.refresh(result.payment.id);
    expect((await api.getOperation(result.operation.id))?.state).toBe("succeeded");
  });
  it("keeps manual approval separate from one final partial capture", async () => {
    const api = await service(); const result = await api.create(input({ captureMode: "manual" }));
    const state = remote.states.get(result.payment.id)!; state.status = "authorized"; state.authorizedMinor = "1990"; state.checkout = null;
    const complete = await api.complete({ paymentId: result.payment.id, idempotencyKey: randomUUID() });
    expect(complete.payment.status).toBe("authorized"); expect(complete.payment.capturedMinor).toBe("0");
    const capture = await api.capture({ paymentId: result.payment.id, idempotencyKey: randomUUID(), minor: "1500" });
    expect(capture.payment.capturedMinor).toBe("1500");
    await expect(api.capture({ paymentId: result.payment.id, idempotencyKey: randomUUID(), minor: "490" })).rejects.toMatchObject({ code: "invalid_state" });
  });
  it("retains an unknown refund reservation and resumes the same refund", async () => {
    const { api, id } = await captured(); remote.unknownAfter = "refund";
    const args = { paymentId: id, idempotencyKey: randomUUID(), minor: "500", reason: "Return" }; const count = remote.calls.refund ?? 0;
    const result = await api.refund(args); expect(result.refund?.status).toBe("pending"); expect(result.payment.refundedMinor).toBe("0");
    await expect(api.refund({ ...args, idempotencyKey: randomUUID(), minor: "1800" })).rejects.toMatchObject({ code: "reconciliation_required" });
    const retry = await api.refund(args); expect(retry.refund?.id).toBe(result.refund?.id); expect(retry.payment.refundedMinor).toBe("500");
    expect(remote.calls.refund).toBe(count + 1);
  });
  it("prevents two concurrent refunds from reserving more than captured funds", async () => {
    const { api, id } = await captured();
    const results = await Promise.allSettled([1, 2].map(() => api.refund({ paymentId: id, idempotencyKey: randomUUID(), minor: "1500", reason: "Return" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await api.get(id))!.refundedMinor).toBe("1500");
  });
  it("tracks pending and external refunds and releases confirmed failed reservations", async () => {
    const { api, id, state } = await captured();
    state.refunds = [{ operationId: null, binding: { reference: randomUUID(), data: {} }, minor: "500", status: "pending" }];
    await api.refresh(id); expect((await api.get(id))!.refundedMinor).toBe("0");
    await expect(api.refund({ paymentId: id, idempotencyKey: randomUUID(), minor: "1600", reason: "Return" })).rejects.toMatchObject({ code: "invalid_state" });
    state.refunds[0]!.status = "failed"; await api.refresh(id);
    await api.refund({ paymentId: id, idempotencyKey: randomUUID(), minor: "1600", reason: "Return" });
    expect((await api.get(id))!.refundedMinor).toBe("1600");
    expect(await listPhisPaymentRefunds(await requirePhiTestDatabase(), id)).toHaveLength(2);
  });
  it("never regresses confirmed capture on a delayed expired observation", async () => {
    const { api, id, state } = await captured(); state.status = "expired"; state.capturedMinor = "0";
    await expect(api.refresh(id)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await api.get(id))!.status).toBe("captured"); expect((await api.get(id))!.capturedMinor).toBe("1990");
  });
  it("rejects wrong merchant, mode, amount or currency observations without settling", async () => {
    const api = await service();
    for (const patch of [{ merchantIdentity: "acct_other" }, { mode: "live" }, { amount: { currency: "EUR", minor: "1990" } }, { amount: { currency: "CHF", minor: "1991" } }]) {
      const result = await api.create(input()); const state = remote.states.get(result.payment.id)!;
      Object.assign(state, patch); await expect(api.refresh(result.payment.id)).rejects.toMatchObject({ code: "provider_unavailable" });
      expect((await api.get(result.payment.id))!.status).toBe("awaiting_customer");
    }
  });
  it("updates last observation time without emitting a new version for unchanged facts", async () => {
    const api = await service(); const result = await api.create(input()); const version = result.payment.version;
    await api.refresh(result.payment.id); expect((await api.get(result.payment.id))!.version).toBe(version);
  });
  it("fences an expired claim so an earlier response cannot overwrite the new owner", async () => {
    const api = await service(); const result = await api.create(input()); const pool = await requirePhiTestDatabase();
    const first = await withPoolTransaction(pool, async db => { const payment = (await readPhisPayment(db, site.id, result.payment.id, null, true))!; await claimPhisPayment(db, payment); return payment; });
    await pool.query("UPDATE phis.payments SET lease_until = NOW() - interval '1 second' WHERE id = $1", [result.payment.id]);
    const next = await withPoolTransaction(pool, async db => { const payment = (await readPhisPayment(db, site.id, result.payment.id, null, true))!; await claimPhisPayment(db, payment); return payment; });
    expect(next.leaseToken).not.toBe(first.leaseToken); expect(next.generation).toBeGreaterThan(first.generation);
    // Calling the finishing path with the stale claim must fail before any state write.
    await expect((api as unknown as { apply(...args: unknown[]): Promise<void> }).apply(first, await readPhisPaymentProfile(pool, site.id, "sandbox"), { outcome: "unknown" }, null)).rejects.toMatchObject({ code: "provider_unavailable" });
    await pool.query("UPDATE phis.payments SET lease_token = NULL, lease_until = NULL WHERE id = $1", [result.payment.id]);
  });
  it("acknowledges a signed notification only with durable inbox, payment and owner outbox", async () => {
    vi.mocked(schedulePhisAddonEventDelivery).mockClear();
    const { api, id, state } = await captured(); const deliveryId = randomUUID();
    state.refunds = [{ operationId: null, binding: { reference: randomUUID(), data: {} }, minor: "500", status: "succeeded" }];
    const ingress = hook(id, deliveryId); expect(await ingress.receive({ profileKey: "sandbox" })).toEqual({ outcome: "processed" });
    expect(await ingress.receive({ profileKey: "sandbox" })).toEqual({ outcome: "duplicate" });
    expect(schedulePhisAddonEventDelivery).toHaveBeenCalledTimes(2);
    expect(schedulePhisAddonEventDelivery).toHaveBeenLastCalledWith(site.id);
    expect((await api.get(id))!.refundedMinor).toBe("500");
    const pool = await requirePhiTestDatabase();
    const receipt = (await pool.query<{ processed: boolean }>("SELECT processed FROM phis.payment_notification_receipts WHERE site_id = $1 AND delivery_id = $2", [site.id, deliveryId])).rows[0];
    expect(receipt?.processed).toBe(true);
    const recipients = (await pool.query<{ addon_id: string; subject_kind: string; thread_id: number | null }>("SELECT addon_id, subject_kind, thread_id FROM phis.addon_event_outbox WHERE payment_id = $1", [id])).rows;
    expect(recipients.length).toBeGreaterThan(0); expect(recipients.every(r => r.addon_id === CONSUMER && r.subject_kind === "payment" && r.thread_id === null)).toBe(true);
  });
  it("does not acknowledge a live competing receipt as a completed duplicate", async () => {
    const api = await service(); const result = await api.create(input()); const pool = await requirePhiTestDatabase(); const id = randomUUID();
    const payment = (await findPhisPaymentForNotification(pool, site.id, "sandbox", result.payment.id))!;
    expect(await claimPhisPaymentReceipt(pool, payment, id)).not.toBe("busy");
    await expect(hook(result.payment.id, id).receive({ profileKey: "sandbox" })).rejects.toMatchObject({ code: "provider_unavailable" });
    await pool.query("UPDATE phis.payment_notification_receipts SET claim_until = NOW() - interval '1 second' WHERE delivery_id = $1", [id]);
    expect(await hook(result.payment.id, id).receive({ profileKey: "sandbox" })).toEqual({ outcome: "processed" });
  });
  it("retains retryability after Provider failure and rejects unsigned or unknown correlation", async () => {
    const api = await service(); const result = await api.create(input()); const id = randomUUID();
    await expect(hook(result.payment.id, id, "forged").receive({ profileKey: "sandbox" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(hook(randomUUID()).receive({ profileKey: "sandbox" })).rejects.toMatchObject({ code: "provider_unavailable" });
    remote.unavailable = true;
    await expect(hook(result.payment.id, id).receive({ profileKey: "sandbox" })).rejects.toMatchObject({ code: "provider_unavailable" });
    remote.unavailable = false;
    expect(await hook(result.payment.id, id).receive({ profileKey: "sandbox" })).toEqual({ outcome: "processed" });
  });
  it("retired profiles reject new payments and preserve access to existing evidence", async () => {
    const api = await service(); const args = input(); const result = await api.create(args); const pool = await requirePhiTestDatabase();
    const profile = (await readPhisPaymentProfile(pool, site.id, "sandbox"))!;
    await setPhisPaymentProfileEnabled(pool, profile, false, true);
    await expect(api.create(input())).rejects.toMatchObject({ code: "profile_unavailable" });
    expect(await api.get(result.payment.id)).not.toBeNull();
    expect((await api.create(args)).operation.id).toBe(result.operation.id);
    await api.refresh(result.payment.id);
  });
});
