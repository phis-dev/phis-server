import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhisAddonManifestV1 } from "@phis/contracts/addon";
import type { PhisPaymentAuthority, PhisPaymentProfile, PhisStoredPayment } from "./types.ts";
import { buildPhisPaymentsCapability } from "./runtime.ts";
vi.mock("../addons/event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: vi.fn() }));

const dependencies = vi.hoisted(() => ({ profile: null as unknown, payment: null as unknown,
  role: false, admin: false, transaction: vi.fn(async () => { throw new Error("authorized-reservation-boundary"); }) }));
vi.mock("../db", () => ({ getPool: () => ({}) }));
vi.mock("../../db/payments.mts", () => ({ readPhisPayment: async () => dependencies.payment, readPhisPaymentProfile: async () => dependencies.profile }));
vi.mock("../db-transaction.ts", () => ({ withPoolTransaction: (...args: unknown[]) => dependencies.transaction(...args as []) }));
vi.mock("../addons/site-access.ts", () => ({ holdsPhisSiteAccess: async () => dependencies.admin }));
vi.mock("../addons/roles-capability.ts", () => ({ buildPhisAddonRolesCapability: () => ({ has: async (role: string) => dependencies.role && role === "merchant" }) }));

describe("Core-bound Payment merchant authority", () => {
  const manifest = { addonId: "@test/shop", roles: [{ name: "merchant" }], jobs: [{ id: "settle" }], eventHandlers: [{ event: "payment.changed" }] } as PhisAddonManifestV1;
  beforeEach(() => {
    dependencies.admin = false; dependencies.role = false; dependencies.transaction.mockClear();
    const policy = { roles: ["merchant"], jobs: ["settle"], events: ["payment.changed"] };
    dependencies.profile = { key: "sandbox", siteId: 1, providerKey: "@test/provider/main", providerAddonId: "@test/provider", mode: "test",
      credentialReferences: {}, merchantIdentity: "acct_test", revision: 1, enabled: true, retired: false, probedAt: "2026-10-04T00:00:00.000Z", methods: [], grants: [{ consumerAddonId: manifest.addonId, operations: ["read", "refund"], merchantActions: { capture: policy, cancel: policy, refund: policy } }] } as PhisPaymentProfile;
    dependencies.payment = { record: { id: "payment-1", profileKey: "sandbox", status: "captured" }, consumerAddonId: manifest.addonId, siteId: 1 } as PhisStoredPayment;
  });
  function capability(authority: PhisPaymentAuthority) {
    return buildPhisPaymentsCapability({ scope: { siteId: 1, siteKey: "demo", consumerAddonId: manifest.addonId }, manifest, authority, signal: new AbortController().signal });
  }
  async function tryRefund(authority: PhisPaymentAuthority) {
    return capability(authority).refund({ paymentId: "payment-1", idempotencyKey: "refund-1", minor: "500", reason: "Return" });
  }
  it.each([
    { kind: "request", operator: false, actorUserId: null },
    { kind: "request", operator: false, actorUserId: 7 },
    { kind: "job", id: "not-the-declared-job" },
    { kind: "event", id: "thread.status.changed" },
    { kind: "hook" },
  ] as PhisPaymentAuthority[])("refuses an unapproved actor/context before reserving: %j", async authority => {
    await expect(tryRefund(authority)).rejects.toMatchObject({ code: "forbidden" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { kind: "request", operator: true, actorUserId: null },
    { kind: "job", id: "settle" },
    { kind: "event", id: "payment.changed" },
  ] as PhisPaymentAuthority[])("admits an explicitly authorized Core context: %j", async authority => {
    await expect(tryRefund(authority)).rejects.toThrow("authorized-reservation-boundary");
    expect(dependencies.transaction).toHaveBeenCalledOnce();
  });
  it("uses existing Site Admin or consumer role authority", async () => {
    dependencies.admin = true;
    await expect(tryRefund({ kind: "request", operator: false, actorUserId: 7 })).rejects.toThrow("authorized-reservation-boundary");
    dependencies.admin = false; dependencies.role = true;
    await expect(tryRefund({ kind: "request", operator: false, actorUserId: 7 })).rejects.toThrow("authorized-reservation-boundary");
  });
  it("requires a grant even for the operator", async () => {
    (dependencies.profile as PhisPaymentProfile).grants = [];
    await expect(tryRefund({ kind: "request", operator: true, actorUserId: null })).rejects.toMatchObject({ code: "not_found" });
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });
});
