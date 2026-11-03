import type { PhisAddonManifestV1, PhisAddonRuntimeV1, PhisAddonHandler, PhisAddonEventHandler, PhisAddonJobHandler, PhisNotificationsCapabilityV1 } from "@phis/contracts/addon";
import type { PhisPaymentMoney, PhisPaymentPricing } from "@phis/contracts/payments";

const param = (name: string) => ({ kind: "parameter" as const, name });
const parameters = [{ name: "payment_id", type: "uuid" as const }];
export const manifest: PhisAddonManifestV1 = {
  manifestVersion: 1, addonId: "@phis/payment-probe", packageName: "@phis/payment-probe", packageVersion: "0.3.0", serverAbi: "^1",
  capabilities: [], serviceProviders: [], requiredCoreCapabilities: ["@phis/server/payments:v1", "@phis/server/data:v1", "@phis/server/settings:v1", "@phis/server/notifications:v1"],
  apiRoutes: [
    { id: "checkout", method: "POST", path: "checkout", handler: "checkout", auth: "operator", siteScoped: true, timeoutMs: 15000 },
    { id: "read", method: "GET", path: "payments/:paymentId", handler: "read", auth: "operator", siteScoped: true },
    { id: "refund", method: "POST", path: "payments/:paymentId/refund", handler: "refund", auth: "operator", siteScoped: true, timeoutMs: 15000 },
  ], hooks: [], jobs: [{ id: "drain", handler: "drain" }, { id: "notify", handler: "notify" }],
  // The address a captured sandbox payment is confirmed to, as a contact without an account. Unset means
  // no mail; the probe never invents a recipient.
  settings: [{ name: "notify-contact", type: "text", description: "Address that receives the sandbox confirmation, as a contact." }],
  eventHandlers: [{ id: "payment", event: "payment.changed", handler: "changed" }],
  // One asked-for occasion, so the sandbox exercises `notifications:v1` with a contact recipient the way
  // a Shop would confirm a guest's order. The words are sealed by the manifest digest; Core frames them.
  occasions: [{ name: "payment-captured", class: "asked-for",
    description: "A sandbox payment was captured.",
    subject: { text: "Sandbox payment %1 captured", parameters: ["reference"] },
    lines: [
      { text: "The sandbox payment %1 over %2 was captured.", parameters: ["reference", "amount"] },
      { text: "This is a test message from the payment probe and needs no action." },
    ],
    parameters: [{ name: "reference", type: "text" }, { name: "amount", type: "text" }] }],
  schema: { descriptorVersion: 1, version: 1, tables: [{ name: "fulfilments", siteScoped: true,
    columns: [{ name: "payment_id", type: "uuid" }, { name: "reference", type: "string", maxLength: 120 },
      { name: "currency", type: "string", maxLength: 3 }, { name: "minor", type: "string", maxLength: 16 },
      { name: "created_at", type: "instant", default: { kind: "now" } }], primaryKey: ["payment_id"] }] },
  queries: { parameters: { fulfilments: parameters, fulfil: [...parameters, { name: "reference", type: "text" }, { name: "currency", type: "text" }, { name: "minor", type: "text" }] },
    queries: [
      { kind: "select", name: "fulfilments", table: "fulfilments", where: { kind: "compare", column: "payment_id", operator: "=", value: param("payment_id") }, limit: 2 },
      { kind: "insert", name: "fulfil", table: "fulfilments", values: ["payment_id", "reference", "currency", "minor"].map(column => ({ column, value: param(column) })) },
    ] }, migrationVersion: 1,
};

/**
 * One agreed base amount per policy, so the sandbox can exercise PAYMENTS.md section 12:
 * `fixed` is the v1 CHF 19.90 total; `net`, `gross` and `code` share two CHF 10.00 widgets plus CHF 5.00
 * shipping, with a stated CHF 5.00 discount (`net`, `gross`) or a customer promotion code (`code`).
 */
const lines = [{ reference: "probe-widget", description: "Phis probe widget", quantity: 2, unitMinor: "1000", taxCategory: "general" as const, providerTaxCodes: null }];
const shipping = { minor: "500", taxCategory: "shipping" as const };
const discounts = [{ reference: "probe-discount", label: "Probe discount", minor: "500" }];
const policies: Record<string, { amount: PhisPaymentMoney; pricing: PhisPaymentPricing }> = {
  fixed: { amount: { currency: "CHF", minor: "1990" }, pricing: { basis: "final", tax: "none" } },
  net: { amount: { currency: "CHF", minor: "2000" }, pricing: { basis: "net", tax: "provider", lineItems: lines, shipping, discounts, promotionCodes: "none", customer: null } },
  gross: { amount: { currency: "CHF", minor: "2000" }, pricing: { basis: "final", tax: "provider", lineItems: lines, shipping, discounts, promotionCodes: "none", customer: null } },
  code: { amount: { currency: "CHF", minor: "2500" }, pricing: { basis: "net", tax: "provider", lineItems: lines, shipping, discounts: [], promotionCodes: "provider", customer: null } },
};

const checkout: PhisAddonHandler = async context => {
  const input = JSON.parse(Buffer.from(context.body).toString("utf8")) as { reference: string; policy?: string };
  if (!/^[0-9a-f-]{36}$/.test(input.reference)) return Response.json({ error: "Invalid test reference." }, { status: 400 });
  const policy = policies[input.policy ?? "fixed"];
  if (!policy) return Response.json({ error: "Unknown policy; use fixed, net, gross or code." }, { status: 400 });
  const result = await context.capabilities.payments!.create({ profileKey: "stripe-sandbox", reference: input.reference,
    idempotencyKey: `probe-create-${input.reference}`, amount: policy.amount, pricing: policy.pricing, description: "Phis webhook settlement test",
    captureMode: "automatic", methodKey: "card", checkoutKind: "redirect", returnPath: "/?payment-probe=return" });
  if (result.payment.mode !== "test") throw new Error("Expected sandbox payment.");
  return Response.json(result);
};
const read: PhisAddonHandler = async context => {
  const payment = await context.capabilities.payments!.get(context.pathParams.paymentId!);
  const fulfilments = await context.capabilities.data!.select("fulfilments", { payment_id: context.pathParams.paymentId! });
  return Response.json({ payment, fulfilments: fulfilments.rows });
};
const refund: PhisAddonHandler = async context => {
  const paymentId = context.pathParams.paymentId!;
  const payment = await context.capabilities.payments!.get(paymentId);
  if (!payment || payment.mode !== "test") return Response.json({ error: "Sandbox payment required." }, { status: 400 });
  // A full refund of what the customer actually paid, which under a taxed policy is the total, not the base amount.
  return Response.json(await context.capabilities.payments!.refund({ paymentId, idempotencyKey: `probe-refund-${paymentId}`, minor: payment.capturedMinor, reason: "Sandbox integration test cleanup" }));
};
/** Writes the captured confirmation to the configured contact, if one is configured; never to anybody else. */
async function confirmToContact(input: { notifications: PhisNotificationsCapabilityV1 | undefined; address: unknown; reference: string; amount: string; dedupeKey: string }) {
  if (!input.notifications || typeof input.address !== "string" || !input.address) return null;
  const { notificationId } = await input.notifications.notify({ occasion: "payment-captured",
    recipient: { kind: "contact", address: input.address, locale: "en", name: "Payment probe" },
    params: { reference: input.reference, amount: input.amount }, dedupeKey: input.dedupeKey });
  return notificationId;
}
const changed: PhisAddonEventHandler = async context => {
  if (context.subject.kind !== "payment") throw new Error("Unexpected subject.");
  const payment = await context.capabilities.payments!.get(context.subject.paymentId);
  if (!payment || payment.mode !== "test") throw new Error("Expected owned sandbox payment.");
  if (payment.status !== "captured") return;
  const data = context.capabilities.data!;
  const exists = await data.select("fulfilments", { payment_id: payment.id });
  if (exists.rows.length) return;
  // The primary key makes fulfilment durable and unique even if two deliveries race.
  // A conflicting insert leaves the outbox owed; the retry observes the existing fulfilment.
  await data.insert("fulfil", { payment_id: payment.id, reference: payment.reference, currency: payment.amount.currency, minor: payment.totals?.total.minor ?? payment.amount.minor });
  // After the durable fulfilment, so a redelivered event finds the row and never reaches this line twice;
  // the dedupe key covers the remaining window between insert and notify.
  const minor = payment.totals?.total.minor ?? payment.amount.minor;
  await confirmToContact({ notifications: context.capabilities.notifications, address: await context.capabilities.settings?.read("notify-contact"),
    reference: payment.reference, amount: `${payment.amount.currency} ${(Number(minor) / 100).toFixed(2)}`, dedupeKey: `captured-${payment.id}` });
};
/** Sends the occasion without a payment, so an operator can verify the mail path on a stage from the CLI. */
const notify: PhisAddonJobHandler = async context => {
  const id = await confirmToContact({ notifications: context.capabilities.notifications, address: await context.capabilities.settings?.read("notify-contact"),
    reference: `job-${context.runId}`, amount: "CHF 0.00", dedupeKey: `job-${context.runId}` });
  if (id === null) throw new Error("notify-contact is not configured or the message was already written.");
};
export const phisAddon: PhisAddonRuntimeV1 = { manifest, apiHandlers: { checkout, read, refund }, eventHandlers: { changed }, jobHandlers: { drain: async () => {}, notify } };
