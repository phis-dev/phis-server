import type { PhisAddonManifestV1, PhisAddonRuntimeV1, PhisAddonHandler, PhisAddonEventHandler } from "@phis/contracts/addon";

const param = (name: string) => ({ kind: "parameter" as const, name });
const parameters = [{ name: "payment_id", type: "uuid" as const }];
export const manifest: PhisAddonManifestV1 = {
  manifestVersion: 1, addonId: "@phis/payment-probe", packageName: "@phis/payment-probe", packageVersion: "0.1.0", serverAbi: "^1",
  capabilities: [], serviceProviders: [], requiredCoreCapabilities: ["@phis/server/payments:v1", "@phis/server/data:v1"],
  apiRoutes: [
    { id: "checkout", method: "POST", path: "checkout", handler: "checkout", auth: "operator", siteScoped: true, timeoutMs: 15000 },
    { id: "read", method: "GET", path: "payments/:paymentId", handler: "read", auth: "operator", siteScoped: true },
    { id: "refund", method: "POST", path: "payments/:paymentId/refund", handler: "refund", auth: "operator", siteScoped: true, timeoutMs: 15000 },
  ], hooks: [], jobs: [{ id: "drain", handler: "drain" }], settings: [],
  eventHandlers: [{ id: "payment", event: "payment.changed", handler: "changed" }],
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

const checkout: PhisAddonHandler = async context => {
  const input = JSON.parse(Buffer.from(context.body).toString("utf8")) as { reference: string };
  if (!/^[0-9a-f-]{36}$/.test(input.reference)) return Response.json({ error: "Invalid test reference." }, { status: 400 });
  const result = await context.capabilities.payments!.create({ profileKey: "stripe-sandbox", reference: input.reference,
    idempotencyKey: `probe-create-${input.reference}`, amount: { currency: "CHF", minor: "1990" }, description: "Phis webhook settlement test",
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
  return Response.json(await context.capabilities.payments!.refund({ paymentId, idempotencyKey: `probe-refund-${paymentId}`, minor: "1990", reason: "Sandbox integration test cleanup" }));
};
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
  await data.insert("fulfil", { payment_id: payment.id, reference: payment.reference, currency: payment.amount.currency, minor: payment.amount.minor });
};
export const phisAddon: PhisAddonRuntimeV1 = { manifest, apiHandlers: { checkout, read, refund }, eventHandlers: { changed }, jobHandlers: { drain: async () => {} } };
