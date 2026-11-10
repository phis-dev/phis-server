import { randomUUID } from "node:crypto";
import type {
  PhisPaymentFeatures, PhisPaymentProviderCommand, PhisPaymentProviderExecution, PhisPaymentProviderObservation,
  PhisPaymentProviderStoredMethod, PhisPaymentProviderV1,
} from "@phis/contracts/payments";

const PRICING = { bases: ["final", "net"] as const, tax: ["none", "provider"] as const, maxDiscounts: 1, promotionCodes: "alone" as const, collectsCustomerDetails: true, collectsTaxIds: false };
/** What a charge without a checkout can carry here: a final price, and nothing a hosted page would have to ask. */
const STORED_PRICING = { bases: ["final"] as const, tax: ["none"] as const, maxDiscounts: 0, promotionCodes: "none" as const, collectsCustomerDetails: false, collectsTaxIds: false };
function features(stored: PhisPaymentFeatures["stored"]): PhisPaymentFeatures {
  return { captureModes: ["automatic"], checkoutKinds: ["redirect"], canPartialCapture: false, canCancel: true, canRefund: true, canPartialRefund: true, pricing: PRICING, stored };
}

export type ChargeAnswer = "paid" | "declined" | "customer" | "gone" | "pending" | "unknown" | "awaiting";

/**
 * A Provider that can store a method with a payment and charge it later, and can be told what the next
 * charge answers. Three methods: a card (many per payer), a wallet (one per payer) and an invoice that
 * cannot be stored at all.
 */
export class StoringProvider implements PhisPaymentProviderV1 {
  states = new Map<string, PhisPaymentProviderObservation>();
  stores = new Map<string, string>();
  methods = new Map<string, PhisPaymentProviderStoredMethod>();
  probes: (string | undefined)[] = [];
  charges: PhisPaymentProviderCommand[] = [];
  revoked: string[] = [];
  next: ChargeAnswer = "paid";
  revokeOutcome: "revoked" | "unknown" = "revoked";
  /** Hosted pages for a set-up without payment, by the binding reference Core was given for each. */
  setups = new Map<string, { state: "open" | "expired"; method: PhisPaymentProviderStoredMethod | null }>();
  setupCalls: { storedMethodId: string; returnUrl: string }[] = [];
  setupOutcome: "applied" | "rejected" | "unknown" = "applied";
  async probe(input: Parameters<PhisPaymentProviderV1["probe"]>[0]) {
    this.probes.push(input.usage);
    const all = [
      { methodKey: "card", title: "Test card", features: features({ setup: ["with-payment", "alone"], chargeResult: "notified", expires: true, perPayer: "many", pricing: STORED_PRICING }) },
      { methodKey: "wallet", title: "Test wallet", features: features({ setup: ["with-payment"], chargeResult: "immediate", expires: false, perPayer: "single", pricing: STORED_PRICING }) },
      { methodKey: "invoice", title: "Test invoice", features: features(null) },
    ];
    return { merchantIdentity: "acct_stored", mode: "test" as const, methods: input.usage === "recurring" ? all.filter(method => method.features.stored) : all };
  }
  private observation(command: { paymentId: string; amount: { currency: string; minor: string } }, status: PhisPaymentProviderObservation["status"]): PhisPaymentProviderObservation {
    return { binding: { reference: `remote-${command.paymentId}`, data: { id: command.paymentId } }, merchantIdentity: "acct_stored", mode: "test", status,
      amount: command.amount, authorizedMinor: "0", capturedMinor: status === "captured" ? command.amount.minor : "0", authorizationExpiresAt: null,
      totals: { total: command.amount, additions: [], customer: null },
      checkout: status === "awaiting_customer" ? { kind: "redirect", url: "https://provider.example/checkout", expiresAt: null } : null, refunds: [] };
  }
  async execute(command: PhisPaymentProviderCommand): Promise<PhisPaymentProviderExecution> {
    if (command.action === "create") {
      const state = this.observation(command, "awaiting_customer");
      this.states.set(command.paymentId, state);
      if (command.store) this.stores.set(command.paymentId, command.store.payerReference);
      return { outcome: "applied", observation: structuredClone(state) };
    }
    if (command.action === "charge") {
      this.charges.push(command);
      const answer = this.next; this.next = "paid";
      if (answer === "declined") return { outcome: "rejected", code: "payment_declined" };
      if (answer === "customer") return { outcome: "rejected", code: "customer_action_required" };
      if (answer === "gone") return { outcome: "rejected", code: "stored_method_unavailable" };
      const state = this.observation(command, answer === "pending" ? "processing" : answer === "awaiting" ? "awaiting_customer" : "captured");
      this.states.set(command.paymentId, state);
      if (answer === "unknown") return { outcome: "unknown" };
      return { outcome: answer === "pending" ? "pending" : "applied", observation: structuredClone(state) };
    }
    if (command.action === "refund") {
      const state = this.states.get(command.paymentId)!;
      state.refunds = [...state.refunds, { operationId: command.operationId, minor: command.minor, status: "succeeded", binding: { reference: randomUUID(), data: {} }, additions: null }];
      return { outcome: "applied", observation: structuredClone(state) };
    }
    throw new Error(`Unexpected ${command.action}`);
  }
  /** The customer finishes the hosted page; the Provider now holds the method, if one was asked for. */
  customerPays(paymentId: string, method: Partial<PhisPaymentProviderStoredMethod> | null = {}) {
    const state = this.states.get(paymentId)!;
    state.status = "captured"; state.capturedMinor = state.amount.minor; state.checkout = null;
    if (this.stores.has(paymentId) && method) {
      const stored: PhisPaymentProviderStoredMethod = { binding: { reference: `pm-${randomUUID()}`, data: { customer: `cus-${this.stores.get(paymentId)}` } },
        display: { title: "Visa", hint: "ends 4242" }, status: "active", expiresAt: "2031-01-31T23:59:59.000Z", ...method };
      state.storedMethod = stored; this.methods.set(stored.binding.reference, stored);
    }
  }
  async observe({ binding }: Parameters<PhisPaymentProviderV1["observe"]>[0]) { return structuredClone(this.states.get(binding.data.id!)!); }
  async recover({ command }: Parameters<PhisPaymentProviderV1["recover"]>[0]): Promise<PhisPaymentProviderExecution> {
    const state = this.states.get(command.paymentId);
    return state ? { outcome: "applied", observation: structuredClone(state) } : { outcome: "unknown" };
  }
  async verifyNotification(input: Parameters<PhisPaymentProviderV1["verifyNotification"]>[0]) {
    const body = JSON.parse(Buffer.from(input.body).toString()) as { reference: string; id: string };
    return { outcome: "verified" as const, reference: body.reference, deliveryId: body.id, subject: "stored-method" as const };
  }
  async setupStoredMethod(input: Parameters<NonNullable<PhisPaymentProviderV1["setupStoredMethod"]>>[0]) {
    this.setupCalls.push({ storedMethodId: input.storedMethodId, returnUrl: input.returnUrl });
    if (this.setupOutcome === "rejected") return { outcome: "rejected" as const, code: "provider_rejected" as const };
    if (this.setupOutcome === "unknown") return { outcome: "unknown" as const };
    const reference = `setup-${input.storedMethodId}`;
    this.setups.set(reference, { state: "open", method: null });
    return { outcome: "applied" as const, binding: { reference, data: { setup: reference } },
      checkout: { kind: "redirect" as const, url: `https://provider.example/setup/${input.storedMethodId}`, expiresAt: null } };
  }
  /** The customer finishes the set-up page: the Provider now holds a method, under a binding of its own. */
  customerSetsUp(storedMethodId: string) {
    const stored: PhisPaymentProviderStoredMethod = { binding: { reference: `pm-${randomUUID()}`, data: { customer: "cus-setup" } },
      display: { title: "Visa", hint: "ends 4242" }, status: "active", expiresAt: "2031-01-31T23:59:59.000Z" };
    this.setups.get(`setup-${storedMethodId}`)!.method = stored;
    this.methods.set(stored.binding.reference, stored);
  }
  async observeStoredMethod({ binding }: { binding: { reference: string; data: Readonly<Record<string, string>> } }): Promise<PhisPaymentProviderStoredMethod> {
    const setup = this.setups.get(binding.reference);
    if (setup) {
      if (setup.method) return structuredClone(setup.method);
      return { binding: { reference: binding.reference, data: { ...binding.data } }, display: { title: "Test card", hint: null },
        status: setup.state === "open" ? "pending" : "invalid", expiresAt: null };
    }
    return structuredClone(this.methods.get(binding.reference)!);
  }
  async revokeStoredMethod({ binding }: { binding: { reference: string } }) {
    this.revoked.push(binding.reference);
    return { outcome: this.revokeOutcome };
  }
}
