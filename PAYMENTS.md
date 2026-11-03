# Payment Service and Capabilities

**Status: approved v1 contract, Core execution implemented in the workspace.** Approved on 2026-10-04;
the pricing extension of section 12 (provider-added tax, shipping and discounts) was approved and built on 2026-11-02.
The consumer and Provider types are exported from `@phis/contracts/payments` and `/addon`. Core now
binds both capabilities, resolves statically installed Providers, persists merchant profiles/grants,
payments, commands, refunds and verified receipts, and routes `payment.changed` to the owning consumer.
The development database has been updated explicitly to the creation schema; this does not deploy any compiled installation.

The agreed commerce ownership is recorded in [COMMERCE_AND_PAYMENTS.md](./design/COMMERCE_AND_PAYMENTS.md).
The existing installation and Service Provider boundary is
[SERVER_ADDONS.md](./SERVER_ADDONS.md). The Payment service, consumer capability and notification ingress are admitted together with their
implementation. Notification ingress is bound only to an original external hook; no route, job or
Provider factory receives authority to submit a synthetic request.

## 1. Three boundaries

| Contract identity | Who uses it | Purpose |
| --- | --- | --- |
| `@phis/server/payments:v1` | Shop, booking or another consuming Add-on | Request payment execution through Core |
| `@phis/server/service/payments` | Stripe, PayPal, Mollie or another Provider Add-on | Implement the provider adapter Core calls |
| `@phis/server/payment-notifications:v1` | A Payment Provider Add-on's external hook | Ask Core to verify a notification and reconcile known payments |

Core is the sole supplier of both capabilities. Providers declare `serviceProviders`, not a second
supplier of `payments:v1`. The provider interface has version 1 and its own interface digest. A
provider key is package-qualified, for example `@phis/stripe/stripe`.

```text
Consumer handler -> capabilities.payments -> Core payment service -> registered Provider adapter

Provider hook -> capabilities.paymentNotifications -> Core verification/reconciliation
              -> payment record and transactional event -> owning Consumer Add-on
```

The second capability has intentionally narrower authority. A webhook cannot mark a payment paid,
select another consumer, supply a trusted amount or gain the general write authority of a verified
system actor. It can only submit its bound external request for verification and reconciliation.

Core owns payment execution records, not a product catalogue, a cart, tax calculations, invoices,
inventory, fulfilment or accounting. The consuming Add-on supplies the final amount and decides what
that payment means for its own business record. Core does not inspect another Add-on's tables.

## 2. Merchant profiles and ownership

A merchant profile is identified by a stable Site-local key. It binds one registered provider key to
one merchant account and one mode (`test` or `live`). Core records its configuration revision and
validated operation capabilities. Secret references point into the declaring Provider Add-on's
existing Site secret namespace; their values never enter a manifest or a client response.

The operator grants named consuming Add-ons access to specific profiles and operations. An installed
Add-on declaring `payments:v1` does not thereby gain every merchant profile on a Site. No grants means
no payment access. Profile configuration and secret writes remain operator/authorized administration
operations, not methods on the consumer capability.

Every payment is permanently bound to:

```text
Site + consuming Add-on + opaque business reference
merchant profile + provider key + merchant identity + mode
requested amount/currency + capture mode + provider method selection
```

The business reference is an opaque, stable consumer-owned key, such as an order or booking id. It is
not an email address, an authorization token or a foreign key Core resolves. The Site and consuming
Add-on come from the bound capability context, never request arguments.

Changing provider, merchant or mode creates a new profile. Existing payments keep their binding.
Credential rotation for the same binding is allowed. A retired profile rejects new payments but can
still service its existing payments while its Provider Add-on remains enabled. Disabling the Provider
Add-on stops remote operations; Core can still return its persisted payment records. No automatic
provider failover is allowed for a financial operation.

## 3. Authority

The consumer capability is a server-only business service, not a public payment-by-id API. Core checks
Site, consumer ownership and configured profile grants on every operation. `get` answers `null` for
an absent or inaccessible record. A mutation uses the same `not_found` result for either case.

The consuming Add-on also enforces access to its business resource before making a call. For example,
a guest's opaque order-access token is checked by the Shop, and a merchant's order role is checked by
its management route. The Site proxy's internal token authenticates a transport, not a customer or a
merchant. A browser knowing a payment id is not entitled to operate it.

Core additionally enforces the configured merchant-action policy for capture, cancel and refund:
Site Admin, a declared role of the consuming Add-on, or an explicitly authorized system context. A
job or verified event may be such a context; an ordinary request labelled `internal` by a Site proxy
is not sufficient. Unverified external hooks cannot use these consumer methods.

`complete` is the customer-flow continuation: it can only advance the previously agreed payment,
using its stored provider binding and amount. It cannot change the amount, turn manual capture into
automatic capture or replace the payment source. The Provider verifies approval itself; browser
query parameters claiming success are not accepted as evidence.

## 4. Consumer capability

The following declarations are exported from `@phis/contracts/payments`. Runtime validation is
required in addition to these types. The capability and Provider interfaces are server-only in use;
a Site may import checkout-plan types without receiving a capability or merchant credentials.

```ts
export type PhisPaymentId = string;
export type PhisPaymentOperationId = string;
export type PhisPaymentRefundId = string;

export type PhisPaymentMoney = {
  /** Uppercase ISO currency code; one agreed currency for the whole payment. */
  currency: string;
  /** Canonical non-negative integer string of minor units, never floating-point money. */
  minor: string;
};

export type PhisPaymentCaptureMode = "automatic" | "manual";
export type PhisPaymentCheckoutKind = "redirect" | "provider-ui";

export type PhisPaymentFeatures = {
  captureModes: readonly PhisPaymentCaptureMode[];
  checkoutKinds: readonly PhisPaymentCheckoutKind[];
  canPartialCapture: boolean;
  canCancel: boolean;
  canRefund: boolean;
  canPartialRefund: boolean;
  pricing: PhisPaymentPricingFeatures;
};

export type PhisPaymentMethod = {
  profileKey: string;
  methodKey: string | null;
  title: string;
  features: PhisPaymentFeatures;
};

export type PhisPaymentCheckoutPlan =
  | {
      kind: "redirect";
      url: string;
      expiresAt: string | null;
    }
  | {
      kind: "provider-ui";
      moduleId: string;
      adapterKey: string;
      parameters: Readonly<Record<string, string>>;
      expiresAt: string | null;
    };

export type PhisPaymentStatus =
  | "created"
  | "awaiting_customer"
  | "processing"
  | "authorized"
  | "captured"
  | "canceled"
  | "expired"
  | "failed";

export type PhisPayment = {
  id: PhisPaymentId;
  reference: string;
  profileKey: string;
  mode: "test" | "live";
  /** The consumer's base amount; the customer pays `totals.total` once the Provider reports it. */
  amount: PhisPaymentMoney;
  pricing: PhisPaymentPricing;
  totals: PhisPaymentTotals | null;
  captureMode: PhisPaymentCaptureMode;
  status: PhisPaymentStatus;
  authorizedMinor: string;
  capturedMinor: string;
  refundedMinor: string;
  authorizationExpiresAt: string | null;
  checkout: PhisPaymentCheckoutPlan | null;
  reconciliationRequired: boolean;
  version: number;
  lastObservedAt: string | null;
};

export type PhisPaymentErrorCode =
  | "invalid_input"
  | "not_found"
  | "forbidden"
  | "profile_unavailable"
  | "method_unavailable"
  | "unsupported_operation"
  | "invalid_state"
  | "active_attempt_exists"
  | "idempotency_conflict"
  | "payment_declined"
  | "provider_rejected"
  | "provider_unavailable"
  | "reconciliation_required";

export type PhisPaymentOperation = {
  id: PhisPaymentOperationId;
  paymentId: PhisPaymentId;
  action: "create" | "complete" | "capture" | "cancel" | "refund";
  state: "reserved" | "pending" | "succeeded" | "failed" | "indeterminate";
  errorCode: PhisPaymentErrorCode | null;
};

export type PhisPaymentRefund = {
  id: PhisPaymentRefundId;
  paymentId: PhisPaymentId;
  amount: PhisPaymentMoney;
  /** The tax or discount share of this refund when the Provider reports one; informational. */
  additions: readonly PhisPaymentAddition[] | null;
  status: "pending" | "succeeded" | "failed" | "canceled";
};

export type PhisPaymentCommandResult = {
  operation: PhisPaymentOperation;
  payment: PhisPayment;
  refund: PhisPaymentRefund | null;
};

export type PhisPaymentCreateInput = {
  profileKey: string;
  reference: string;
  idempotencyKey: string;
  amount: PhisPaymentMoney;
  pricing: PhisPaymentPricing;
  description: string;
  captureMode: PhisPaymentCaptureMode;
  methodKey: string | null;
  checkoutKind: PhisPaymentCheckoutKind;
  returnPath: string;
};

export type PhisPaymentCommandInput = {
  paymentId: PhisPaymentId;
  idempotencyKey: string;
};

export interface PhisPaymentsCapabilityV1 {
  listMethods(input: {
    profileKey: string;
    amount: PhisPaymentMoney;
    captureMode: PhisPaymentCaptureMode;
    checkoutKind: PhisPaymentCheckoutKind;
    pricing: PhisPaymentPricingSelector;
  }): Promise<readonly PhisPaymentMethod[]>;
  /** Core binds Site/consumer/profile; the consumer checks access to its business resource. */
  create(input: PhisPaymentCreateInput): Promise<PhisPaymentCommandResult>;
  get(paymentId: PhisPaymentId): Promise<PhisPayment | null>;
  getOperation(operationId: PhisPaymentOperationId): Promise<PhisPaymentOperation | null>;
  getRefund(refundId: PhisPaymentRefundId): Promise<PhisPaymentRefund | null>;
  /** Customer continuation; never captures a manually authorized payment. */
  complete(input: PhisPaymentCommandInput): Promise<PhisPaymentCommandResult>;
  /** Explicit bounded reconciliation that may update state and enqueue a consumer event. */
  refresh(paymentId: PhisPaymentId): Promise<PhisPayment | null>;
  /** One final merchant-authorized capture; minor units inherit the stored currency. */
  capture(input: PhisPaymentCommandInput & {
    minor: string;
  }): Promise<PhisPaymentCommandResult>;
  cancel(input: PhisPaymentCommandInput): Promise<PhisPaymentCommandResult>;
  /** Merchant-authorized refund; pending/unknown amounts reserve the captured balance. */
  refund(input: PhisPaymentCommandInput & {
    minor: string;
    reason: string;
  }): Promise<PhisPaymentCommandResult>;
}

export type PhisPaymentProviderConfigV1 = {
  profileKey: string;
  mode: "test" | "live";
  merchantIdentity: string | null;
};

export type PhisPaymentProviderContextV1 = {
  providerKey: string;
  readCredentials(): Promise<Readonly<Record<string, string>> | null>;
};

export type PhisPaymentProviderBinding = {
  reference: string;
  data: Readonly<Record<string, string>>;
};

export type PhisPaymentProviderProbe = {
  merchantIdentity: string;
  mode: "test" | "live";
  methods: readonly Omit<PhisPaymentMethod, "profileKey">[];
};

export type PhisPaymentProviderObservation = {
  binding: PhisPaymentProviderBinding;
  merchantIdentity: string;
  mode: "test" | "live";
  status: PhisPaymentStatus;
  /** The base amount as created; a Provider never changes it. */
  amount: PhisPaymentMoney;
  /** Null only while the Provider cannot yet know the total; required from `authorized` on. */
  totals: PhisPaymentObservedTotals | null;
  authorizedMinor: string;
  capturedMinor: string;
  authorizationExpiresAt: string | null;
  checkout: PhisPaymentCheckoutPlan | null;
  /** Complete refund observations, including remote refunds created outside Core. */
  refunds: readonly {
    operationId: PhisPaymentOperationId | null;
    binding: PhisPaymentProviderBinding;
    minor: string;
    status: PhisPaymentRefund["status"];
    additions: readonly PhisPaymentAddition[] | null;
  }[];
};

export type PhisPaymentProviderCommand = {
  operationId: PhisPaymentOperationId;
  paymentId: PhisPaymentId;
  providerIdempotencyKey: string;
  signal: AbortSignal;
} & (
  | {
      action: "create";
      amount: PhisPaymentMoney;
      pricing: PhisPaymentPricing;
      description: string;
      captureMode: PhisPaymentCaptureMode;
      methodKey: string | null;
      checkoutKind: PhisPaymentCheckoutKind;
      returnUrl: string;
      notificationUrl: string;
    }
  | { action: "complete" | "cancel"; binding: PhisPaymentProviderBinding }
  | { action: "capture"; binding: PhisPaymentProviderBinding; minor: string }
  | { action: "refund"; binding: PhisPaymentProviderBinding; minor: string; reason: string }
);

export type PhisPaymentProviderExecution =
  | {
      outcome: "applied" | "pending";
      observation: PhisPaymentProviderObservation;
    }
  | { outcome: "rejected"; code: PhisPaymentErrorCode }
  | { outcome: "unknown" };

export type PhisPaymentProviderNotification =
  | { outcome: "verified"; deliveryId: string; reference: string }
  | { outcome: "lookup-required"; reference: string }
  | { outcome: "irrelevant" }
  | { outcome: "rejected" }
  | { outcome: "unavailable" };

export interface PhisPaymentProviderV1 {
  probe(input: {
    amount: PhisPaymentMoney;
    captureMode: PhisPaymentCaptureMode;
    checkoutKind: PhisPaymentCheckoutKind;
    pricing: PhisPaymentPricingSelector;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderProbe>;
  execute(input: PhisPaymentProviderCommand): Promise<PhisPaymentProviderExecution>;
  observe(input: {
    binding: PhisPaymentProviderBinding;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderObservation>;
  /** Recover the same command; never replace its key, merchant, mode or Provider. */
  recover(input: {
    command: PhisPaymentProviderCommand;
    binding: PhisPaymentProviderBinding | null;
  }): Promise<PhisPaymentProviderExecution>;
  verifyNotification(input: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderNotification>;
}

export interface PhisPaymentNotificationsCapabilityV1 {
  receive(input: {
    profileKey: string;
  }): Promise<{ outcome: "processed" | "duplicate" | "ignored" }>;
}

export type PhisPaymentGrantedOperation =
  | "read"
  | "create"
  | "complete"
  | "refresh"
  | "capture"
  | "cancel"
  | "refund";

export type PhisPaymentMerchantActionPolicy = {
  roles: readonly string[];
  jobs: readonly string[];
  events: readonly string[];
};

export type PhisPaymentProfileGrant = {
  consumerAddonId: string;
  operations: readonly PhisPaymentGrantedOperation[];
  merchantActions: {
    capture: PhisPaymentMerchantActionPolicy;
    cancel: PhisPaymentMerchantActionPolicy;
    refund: PhisPaymentMerchantActionPolicy;
  };
};

/** Operator-controlled references and grants; contains no credential values. */
export type PhisPaymentProfileDraft = {
  key: string;
  providerKey: string;
  mode: "test" | "live";
  credentialReferences: Readonly<Record<string, string>>;
  grants: readonly PhisPaymentProfileGrant[];
};

/** A payment event reaches only the consuming Add-on stored on that payment. */
export type PhisPaymentChangedEventFacts = {
  event: "payment.changed";
  subject: {
    kind: "payment";
    paymentId: PhisPaymentId;
    reference: string;
    version: number;
    operationId: PhisPaymentOperationId | null;
    refundId: PhisPaymentRefundId | null;
  };
};

/*
 * Pricing: how a consumer lets a Provider add tax, shipping and discounts to its base amount, and how
 * the Provider reports the customer's total with its parts. PAYMENTS.md section 12 states the rules Core
 * enforces; a Provider documents its mapping of the closed tax-category vocabulary to its own codes.
 */

export type PhisPaymentPricingBasis = "final" | "net";
export type PhisPaymentTaxHandling = "none" | "provider" | "merchant-of-record";
export type PhisPaymentPromotionCodes = "none" | "provider";

/** What is sold, never a rate; each Provider maps the closed vocabulary to its own codes. */
export type PhisPaymentTaxCategory =
  | "general"
  | "reduced-goods"
  | "digital-goods"
  | "digital-service"
  | "service"
  | "shipping"
  | "exempt";

export type PhisPaymentLineItem = {
  reference: string;
  description: string;
  quantity: number;
  unitMinor: string;
  taxCategory: PhisPaymentTaxCategory;
  /** Provider-specific code overriding the category mapping, keyed by provider key. */
  providerTaxCodes: Readonly<Record<string, string>> | null;
};

/** A reduction the consumer decided; the Provider shows it and taxes the reduced amount. */
export type PhisPaymentDiscount = {
  reference: string;
  label: string;
  minor: string;
};

export type PhisPaymentCustomerDetails = {
  country: string;
  postalCode: string | null;
  region: string | null;
  addressSource: "billing" | "shipping";
  taxIds: readonly { type: string; value: string }[];
};

/**
 * `final`/`none` is v1: the base amount is what the customer pays and the Provider adds nothing. Every
 * other policy carries line items; the base amount then equals their sum plus shipping minus discounts.
 */
export type PhisPaymentPricing =
  | { basis: "final"; tax: "none" }
  | {
      basis: PhisPaymentPricingBasis;
      tax: PhisPaymentTaxHandling;
      lineItems: readonly PhisPaymentLineItem[];
      shipping: { minor: string; taxCategory: "shipping" } | null;
      discounts: readonly PhisPaymentDiscount[];
      promotionCodes: PhisPaymentPromotionCodes;
      customer: PhisPaymentCustomerDetails | null;
    };

/** The facts of a policy a method must support; `discounts` is the number of stated discounts. */
export type PhisPaymentPricingSelector = {
  basis: PhisPaymentPricingBasis;
  tax: PhisPaymentTaxHandling;
  discounts: number;
  promotionCodes: PhisPaymentPromotionCodes;
};

export type PhisPaymentPricingFeatures = {
  /** Always includes `final`. */
  bases: readonly PhisPaymentPricingBasis[];
  /** Always includes `none`. */
  tax: readonly PhisPaymentTaxHandling[];
  /** How many stated discounts one payment may carry; 0 when the Provider shows none. */
  maxDiscounts: number;
  /** Whether a customer may enter a code on the Provider's page, and whether next to stated discounts. */
  promotionCodes: "none" | "alone" | "with-discounts";
  collectsCustomerDetails: boolean;
  collectsTaxIds: boolean;
};

export type PhisPaymentAdditionKind = "tax" | "shipping" | "discount";

export type PhisPaymentAddition = {
  kind: PhisPaymentAdditionKind;
  minor: string;
  label: string;
  /** Contained in the base amount rather than added to it; a `discount` is never inclusive. */
  inclusive: boolean;
  /** Display-only decimal string such as "8.1"; never enters Core arithmetic. */
  rate: string | null;
  /** ISO country code, optionally followed by "-" and a region. */
  jurisdiction: string | null;
  /** Who owes a tax addition to the authority: the merchant, or the Provider as Merchant of Record. */
  collectedBy: "merchant" | "provider";
  /** The promotion code or stated discount reference behind a `discount`; null for every other kind. */
  code: string | null;
};

export type PhisPaymentObservedTotals = {
  total: PhisPaymentMoney;
  additions: readonly PhisPaymentAddition[];
  customer: PhisPaymentCustomerDetails | null;
};

export type PhisPaymentTotals = PhisPaymentObservedTotals & {
  /** Set by Core when the total became binding; a differing total afterwards is an inconsistency. */
  frozenAt: string | null;
};
```

Money uses an uppercase ISO currency code and a canonical non-negative integer string of minor units:
`{ currency: "CHF", minor: "1990" }` represents CHF 19.90. No floating-point arithmetic or provider
decimal string is accepted at this boundary. Creation, capture and refund amounts are positive;
recorded totals may be zero. Core retains the validated currency exponent with the payment. A Provider
adapts this representation to its API's currency rules. Values and lengths have bounded validation.


A consumer can maintain independent prices in CHF, EUR, USD or another supported currency. Price
selection and any exchange-rate conversion belong to that consumer. Each payment attempt uses exactly
one currency and one agreed amount; capture and every refund inherit that currency from the payment.
Core does not convert currencies, combine mixed-currency carts or choose a settlement currency. A
merchant profile may serve several currencies when the Provider supports the requested currency and
method combination. There is no installation-wide or profile-wide single-currency restriction.

`listMethods` is a current availability query, not a promise that a later creation must succeed. Core
checks availability again when executing. `methodKey: null` means provider-managed selection; it is
valid only when returned as an available option. Its advertised features are the intersection of the
methods the Provider can actually offer for that request. Method keys are opaque and profile-bound.

`get`, `getOperation` and `getRefund` read persisted state and make no external calls. `refresh` is an
explicit, bounded reconciliation operation: it may update Core state and emit an event after querying
the Provider. Its effect is not hidden in an ordinary read. The bound request/job signal limits calls;
a transport abort does not imply a financial rollback.

Validation or authority failures before reserving an operation use a typed error with an error code.
Once an operation is reserved, expected Provider outcomes are persisted and returned through the
command result, including `indeterminate`. Unexpected failures remain recoverable by the durable
operation key. Raw Provider errors are logged server-side with redaction, not returned as HTML or SDK
exceptions to a client.

`returnPath` is a path on the Site's configured public origin. Core canonicalizes it, rejects a
different origin, and constructs the return URL and payment correlation. Neither browser `Host` nor
an arbitrary callback URL selects the Site. Returning or closing the checkout does not call `cancel`.

Provider UI plans select a statically installed Module/adapter contribution. Parameters are explicitly
client-safe, short-lived checkout values; no merchant or webhook secret is permitted. There is no
remote script, arbitrary HTML or dynamic package import in a plan. The first Provider can implement
only redirect checkout; provider-ui is available only when its registered client contribution exists.

## 5. Payment, capture and refund semantics

| State | Meaning |
| --- | --- |
| `created` | Core reserved the attempt; remote creation is not yet established |
| `awaiting_customer` | A checkout/approval action is available |
| `processing` | The Provider has not confirmed a final result |
| `authorized` | Funds are authorized, with a provider-reported expiry where available |
| `captured` | The Provider confirmed collection of `capturedMinor` |
| `canceled` / `expired` / `failed` | The Provider or a confirmed local pre-submission result ended the attempt |

A successful command operation is not necessarily a captured payment. Creating a checkout can succeed
while its payment awaits the customer; an accepted refund can remain pending. `created` with an
indeterminate create operation does not prove that no external payment exists.

`automatic` authorizes and collects as part of the customer flow. `manual` authorizes first; only the
separate merchant-authorized `capture` can collect funds. `complete` can finish PayPal-style server
approval/capture for automatic mode, but leaves manual mode authorized. For a Provider whose customer
flow already completes everything, it reconciles the result without another charge.

V1 permits one final capture, optionally smaller than the authorization if the method advertises
partial capture. The uncaptured remainder is released and cannot be captured again under the same
payment. Multiple captures, incremental authorizations and increasing the agreed amount are outside
v1. Full Medusa integration can still use Medusa's own richer payment path independently.

Refunds are separate records. `refundedMinor` counts confirmed successful refunds, not merely accepted
requests. Pending and indeterminate refunds reserve their amount so concurrent calls cannot exceed
the captured balance. A failed/canceled refund releases its reservation only after an authoritative
result. A full refund does not turn the original payment into a failed or canceled payment.

Core enforces same currency, non-negative totals, captured amount no greater than the customer's total
(section 12; under the fixed-total policy that is the agreed amount), and successful plus reserved
refunds no greater than captured funds. Fulfilment remains the consumer's
decision: it checks the captured amount against its own amount due, not merely the state name.
Captured funds are not a claim of payout completion or immunity from later disputes. Payouts,
settlement accounting, subscriptions, saved cards, dispute workflows and platform commissions are
outside this initial execution contract.

## 6. Provider adapter

The factory receives validated profile configuration and a credential reader bound to that one
Provider/profile. A credential bundle can contain the API credential, client id and webhook secret
the integration needs. It cannot resolve another secret by name. Core checks that all references
belong to the selected Provider Add-on and Site before building the context.

```ts
export type PhisPaymentProviderConfigV1 = {
  profileKey: string;
  mode: "test" | "live";
  merchantIdentity: string | null;
};

export type PhisPaymentProviderContextV1 = {
  providerKey: string;
  readCredentials(): Promise<Readonly<Record<string, string>> | null>;
};

export type PhisPaymentProviderBinding = {
  reference: string;
  data: Readonly<Record<string, string>>;
};

export type PhisPaymentProviderProbe = {
  merchantIdentity: string;
  mode: "test" | "live";
  methods: readonly Omit<PhisPaymentMethod, "profileKey">[];
};

export type PhisPaymentProviderObservation = {
  binding: PhisPaymentProviderBinding;
  merchantIdentity: string;
  mode: "test" | "live";
  status: PhisPaymentStatus;
  amount: PhisPaymentMoney;
  authorizedMinor: string;
  capturedMinor: string;
  authorizationExpiresAt: string | null;
  checkout: PhisPaymentCheckoutPlan | null;
  refunds: readonly {
    operationId: PhisPaymentOperationId | null;
    binding: PhisPaymentProviderBinding;
    minor: string;
    status: PhisPaymentRefund["status"];
  }[];
};

export type PhisPaymentProviderCommand = {
  operationId: PhisPaymentOperationId;
  paymentId: PhisPaymentId;
  providerIdempotencyKey: string;
  signal: AbortSignal;
} & (
  | {
      action: "create";
      amount: PhisPaymentMoney;
      description: string;
      captureMode: PhisPaymentCaptureMode;
      methodKey: string | null;
      checkoutKind: PhisPaymentCheckoutKind;
      returnUrl: string;
      notificationUrl: string;
    }
  | { action: "complete" | "cancel"; binding: PhisPaymentProviderBinding }
  | { action: "capture"; binding: PhisPaymentProviderBinding; minor: string }
  | { action: "refund"; binding: PhisPaymentProviderBinding; minor: string; reason: string }
);

export type PhisPaymentProviderExecution =
  | {
      outcome: "applied" | "pending";
      observation: PhisPaymentProviderObservation;
    }
  | { outcome: "rejected"; code: PhisPaymentErrorCode }
  | { outcome: "unknown" };

export type PhisPaymentProviderNotification =
  | { outcome: "verified"; deliveryId: string; reference: string }
  | { outcome: "lookup-required"; reference: string }
  | { outcome: "irrelevant" }
  | { outcome: "rejected" }
  | { outcome: "unavailable" };

export interface PhisPaymentProviderV1 {
  probe(input: {
    amount: PhisPaymentMoney;
    captureMode: PhisPaymentCaptureMode;
    checkoutKind: PhisPaymentCheckoutKind;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderProbe>;
  execute(input: PhisPaymentProviderCommand): Promise<PhisPaymentProviderExecution>;
  observe(input: {
    binding: PhisPaymentProviderBinding;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderObservation>;
  recover(input: {
    command: PhisPaymentProviderCommand;
    binding: PhisPaymentProviderBinding | null;
  }): Promise<PhisPaymentProviderExecution>;
  verifyNotification(input: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<PhisPaymentProviderNotification>;
}

export interface PhisPaymentNotificationsCapabilityV1 {
  receive(input: {
    profileKey: string;
  }): Promise<{ outcome: "processed" | "duplicate" | "ignored" }>;
}
```

Provider bindings are opaque, server-only references and identifiers needed to resume the same remote
operation. They contain no credentials, card data or free-form request payload. Core stores them but
does not interpret Stripe/PayPal-specific identifiers. A Provider checks the remote merchant, mode,
amount and currency on its observations; Core validates the normalized facts against its binding.

`merchantIdentity: null` in configuration is allowed only while setting up an unprobed profile. The
probe reports the identity and mode actually reached with its credentials. Core pins them before
enabling the profile and refuses a mismatch on subsequent probes or observations. Provider idempotency
keys and correlation values are persisted before a call; the transient `AbortSignal` is reconstructed
from the current bounded request and is never persisted as a business argument.

A refund with `operationId: null` originated outside Core, for example in the merchant's Provider
dashboard. Core assigns it a refund identity using the stable remote binding, includes it in the
confirmed/reserved totals and emits the owning consumer's event. Absence of a local operation is not
permission to omit a known external refund or to create it again.

`applied` confirms execution of that operation, not that every resulting payment state is final.
`pending` means that operation is still awaiting an external result. `rejected` is a confirmed refusal,
not a network exception. A timeout, connection loss or unverifiable response after submission is
`unknown` unless the Provider can establish what happened.

`recover` establishes the result of the stored command by retrieving its remote object, using its
operation correlation, or safely replaying the identical provider idempotency key within its documented
retention window. If none is safe, it returns `unknown`. It must never create a replacement operation
with a new key, another merchant account or another Provider. Complete observations reconcile all
refund records for that payment, including external refunds; a Provider may make multiple bounded API
reads to obtain them. Observation and reconciliation never recreate a remote refund.

The factory has no database handle, general Core capability bag or unbounded secret accessor. Network
calls belong to its installed, trusted Provider code and honor the signal. Merchant identity is
established by a profile probe and must match subsequent credential rotations.

A Provider maps the complete checkout lifecycle, not an isolated unsuccessful charge. If its checkout
still allows another customer attempt, a declined card does not make the Core payment terminal or
release the business reference for a second checkout. Remote authorization/capture takes precedence
over checkout expiry. The concrete first-provider mapping is in [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md).

## 7. Notifications and consumer events

The Provider declares its external hook in its normal Add-on namespace, for example
`/api/hooks/phis/stripe/payments/{profileKey}` on the Site. Its handler calls only
`capabilities.paymentNotifications.receive({ profileKey })` and maps the result to an HTTP response.
Core binds this capability to the original hook method, headers, raw body, Site and declaring Add-on.
It is available for that hook context only, not an ordinary route, job or service factory.

Core verifies that the selected profile's Provider belongs to the declaring Add-on, resolves its
adapter through the service registry, and calls `verifyNotification`. No request-supplied verification
scheme, secret reference or factory name is accepted. This contract deliberately leaves the hook's
ambient actor unverified: successful payment reconciliation does not grant its handler write access
to unrelated Provider or consumer data.

For `verified`, Core accepts the delivery id only after signature validation. For `lookup-required`,
as with a classic Mollie notification, only a reference already bound to this profile's payment may
be retrieved. The body supplies no trusted state. In both cases Core asks the authenticated Provider
API for its current observation before updating payment records. A callback for an as-yet unknown
remote reference is not remembered as processed: Core answers a retryable error while a pending create
can be correlated, or the recovery path later establishes that payment's current result.

Malformed/signature-rejected notifications fail without mutation. Unavailable credentials, verification
services or Provider reads are retryable failures, not successful ignored deliveries. Unrelated events
may yield `irrelevant` only after they are safely identified as outside this payment contract. The first
implementation specifies exact HTTP status mapping and Provider retry behaviour.

Implemented delivery uses the existing after-commit outbox trigger: successful mutating capability
calls and committed notification reconciliation schedule an owner-event drain. An already processed
notification schedules another drain of any still-owed events before returning `duplicate`, covering
an earlier delivery attempt interrupted after the financial commit. Ordinary reads schedule no writes.
Consumer delivery failure leaves the event owed and does not turn a committed PSP observation into
a failed notification acknowledgement; the existing operator/job retry path remains available.

Payment notifications use a dedicated inbox lifecycle. The existing generic hook delivery claim, which
claims an id before the handler finishes, is not reused as a completed-payment receipt. A claim is
recoverable; only a successfully applied observation commits it as processed. A repeated notification
while the first is still processing is not acknowledged as a completed duplicate. State update and
consumer-event enqueue share a transaction. An HTTP success follows their durable commit, not the
consumer's later fulfilment.

The target v1 Core event is `payment.changed`. It is delivered only to the payment's owning consuming
Add-on, with a stable delivery id and `{ paymentId, reference, version, operationId, refundId }`, where
the last two fields are nullable. The consumer reads current state through its bound `payments`
capability and performs its own idempotent business update. The event is not a command to ship.

Existing Add-on events are thread-specific. Adding this event requires an explicit subject union,
owner-targeted recipient selection and outbox schema extension; a fake thread or generic broadcast is
not an alternative. Delivery is at least once after commit. Failed consumer delivery stays in the
outbox and is retried through the existing request/operator-driven mechanism, without a new in-process
scheduler. A payment may be captured while fulfilment is still pending.

## 8. Durable operations, concurrency and recovery

Every mutation requires an idempotency key. Its uniqueness is scoped to Site, consumer and action;
the persisted canonical request includes payment/profile binding and every business argument. Reusing
a key with different arguments is an `idempotency_conflict`, not a second operation. Keys and business
references are bounded strings without personal data. The durable Core command is the authoritative
identity; a fingerprint may compare arguments but does not replace it.

Creation reserves the payment and operation before contacting the Provider. Core derives one stable,
opaque provider idempotency key from the operation identity. A retry returns or recovers that same
operation. While a reference has an active or indeterminate attempt, creation of another attempt for
that same Site/consumer/reference is refused. Confirmed failed, expired or canceled attempts permit a
new attempt. A captured attempt requires a new explicit business reference for any further amount;
Core does not infer a new debt from a refunded payment.

Capture and refund reserve their amount under the payment lock before external execution. Core never
holds a database transaction open across a Provider HTTP call. After the call it applies the result
under the same payment's optimistic version/operation checks. Concurrent commands or observations must
not reuse a reservation or overwrite a newer captured/refunded state with a stale response. Where
ordering cannot be established, Core re-observes instead of guessing from event timestamps.

The local transaction and external API cannot commit together. A crash after remote acceptance leaves
an operation needing recovery, not a confirmed failure. `reconciliationRequired` is true while any
financial operation has an indeterminate result. Core forbids conflicting commands and a replacement
attempt until recovery establishes the outcome. Provider idempotency retention is finite; Core does
not blindly replay an old command beyond the adapter's safe recovery window.

Recovery is driven by a repeat of the same command, explicit `refresh`, an incoming notification or a
bounded operator-invoked maintenance operation. There is no new per-instance polling timer. A provider
read that is temporarily unavailable leaves the known state unchanged and reports that availability
failure. It never marks an unknown operation failed merely because time passed.

## 9. Minimum persistence and retention

Implementation needs Core-owned records for merchant profiles/grants, payments, command operations,
refunds and payment notification receipts. It also extends the existing event outbox for payment
subjects. All runtime SQL lives under `src/db/`; the concrete tables, constraints and migration DDL are documented in [DB.md](./DB.md#payment-execution).
Each record includes its Site binding and the relevant owner/provider identity.

Store the normalized execution facts, immutable merchant binding, request arguments, provider references,
operation correlation and versions needed for recovery. Do not store a catalogue, a tax engine, complete
order contents, card numbers, Provider secrets or entire webhook payloads by default. Short-lived
checkout parameters with client secrets are protected at rest and redacted from logs; their expiry does
not discard the underlying payment reference.

Deleting or disabling a commerce Add-on does not erase payment evidence or make unresolved funds disappear.
Profile retirement and Provider removal are checked against unresolved operations. A retained consumer
identity can be inactive without transferring its payment ownership to another Add-on. The precise
retention/export/purge rules require an explicit administrative design before destructive operations
are implemented; historical financial records are not silently included in a general Add-on purge.

## 10. Examples and Medusa boundary

```ts
declare const payments: PhisPaymentsCapabilityV1;

export async function beginExamplePurchase() {
  return payments.create({
    profileKey: "main",
    reference: "order/opaque-order-id",
    idempotencyKey: "checkout/opaque-attempt-id",
    amount: { currency: "CHF", minor: "1990" },
    description: "Purchase",
    captureMode: "automatic",
    methodKey: null,
    checkoutKind: "redirect",
    returnPath: "/de/shop/return",
  });
}

export async function refundExample(paymentId: PhisPaymentId) {
  return payments.refund({
    paymentId,
    idempotencyKey: "refund/opaque-refund-request-id",
    minor: "500",
    reason: "Customer return",
  });
}
```

The Shop checks its own order amount and guest access before the first example, and merchant authority
before the second. CHF 5.00 is reserved for refund and becomes part of `refundedMinor` only when
confirmed. No API field lets either caller assert that its payment is captured.

The Medusa Bridge is independent of the small Shop. Initially Medusa uses its own payment workflow.
A later Medusa-side Payment Provider adapter can call an authenticated Bridge operation that uses
this capability in the Bridge's consumer scope. External backend authentication and merchant-action
authority need a dedicated design; forwarding the installation-wide internal token to Medusa is not
the integration contract. Medusa keeps its order workflow and never executes the same charge through
both Medusa's native provider and the Phis Provider. Unsupported advanced Medusa operations stay on
the native path rather than being simulated by additional Phis charges.

## 11. Admission and implementation checks

The public types, capability catalogue ids and delivered context fields, service kind/version/digest,
payment event and execution support are implemented together. The consumer capability closes over
its Site/Add-on/actor; its object exposes exactly the documented methods, no engine, pool or recovery
handle. Notification ingress exists only in a bound hook context. A Provider registers its factory
through the existing static manifest. Profile probes record merchant identity, mode and supported
operations; enabling checks referenced credentials and the serving instances. The first end-to-end path is a redirect checkout with one Provider and one
consumer; further Providers must satisfy the same contract.

Before release, verify:

- Two Sites/consumers cannot read or operate each other's payment/profile/operation ids.
- A Site proxy's internal token does not grant merchant actions or guest order access.
- Concurrent identical commands perform one external operation; conflicting key reuse is refused.
- A timeout/crash after external acceptance is recovered without a replacement charge.
- A repeated or concurrent webhook is acknowledged only after its state is durable.
- Bad signatures, wrong merchant/mode/currency and forged unsigned status updates cannot settle payment.
- Delayed/out-of-order observations cannot regress captured/refunded amounts or trigger fulfilment twice.
- Concurrent partial refunds reserve balances correctly; pending failures do not release them early.
- Customer approval of a manual payment does not capture funds; a partial final capture cannot be repeated.
- Profile retirement/credential rotation preserves existing bindings; changing Provider never migrates them.
- A captured payment survives consumer-event failure and later drives one consumer business update.
- Invalid return URLs, unsafe UI adapter selection and logged credentials are rejected/redacted.

The first-provider execution plan, profile/grant configuration, merchant-action policies and exact
hook/event extension are target v1 in [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md). They complete the
approved first implementation scope. Deployment and external notification verification remain installation-specific.
Provider-specific public UI schemas and external Medusa backend exposure remain later contracts.
The first implementation retains financial records and offers no destructive purge; an administrative
retention/export policy is required before such an operation is introduced.

## 12. Pricing: provider-added tax, shipping and discounts

`amount` is the consumer's **base amount**. A pricing policy, stated on create and immutable afterwards,
says whether the customer pays exactly that amount or whether the Provider adds to it. The policy
types are in section 4; the vocabulary is provider-neutral, and each Provider documents its mapping
of the closed tax-category vocabulary to its own codes.

| `basis` | `tax` | Meaning | Customer's total |
| --- | --- | --- | --- |
| `final` | `none` | v1 behaviour; no line items; the default and the only policy every Provider must support | equals the base amount |
| `final` | `provider` | gross prices; the Provider reports the tax included | equals the base amount; tax additions are `inclusive` |
| `net` | `provider` | net prices; the Provider adds tax on top | base plus exclusive additions |
| any | `merchant-of-record` | the Provider is the legal seller and owes the tax | as above; tax additions are `collectedBy: "provider"` |

Every policy but `final`/`none` carries line items with a tax category each, shipping as a line of its
own, the consumer's stated discounts and whether the customer may enter a promotion code on the
Provider's page. The base amount then equals the lines' sum plus shipping minus the stated discounts;
Core refuses a create whose `amount` disagrees with its own lines. A tax category names what is sold,
never a rate; a consumer that needs a finer Provider code sets it in `providerTaxCodes` under that
Provider's key. `exempt` is a consumer assertion. Reverse charge is detected by the Provider from the
customer's tax ids and reported as a zero tax addition. Gift cards, store credit and loyalty balances
are consumer state: the consumer lowers a unit price or states a discount, and Core keeps no balance.

**Ownership does not move.** The consumer keeps catalogue, prices, tax categories, listing mode, orders
and receipts; it delegates the arithmetic under rules it states. Core stores policy, total and
additions and enforces the rules below. The Provider translates; its method features (`pricing`)
declare which bases, tax handlings, how many stated discounts and which promotion-code arrangement it
supports, and `listMethods` filters by them. On the Medusa path totals already contain tax and arrive
under `final`/`none` (design/COMMERCE_AND_PAYMENTS.md section 7).

**Create.** Core validates the policy's shape and bounds (at most 200 lines, 20 discounts, 8 tax ids,
8 Provider code overrides per line, texts of 200 characters), requires the selected method's features
to cover it (`method_unavailable` otherwise), stores it in the payment record and passes it to the
Provider's create command. The policy is part of the idempotent request.

**Observation.** `amount` must still equal the stored base amount; a Provider never changes it.
`totals` may be `null` only while nothing is authorized or captured and no total is bound yet; from
`authorized` or `captured` on it is required. When present, Core checks:

- Under `final`/`none` there are no additions and the total equals the base amount.
- A `tax` addition exists only when the policy's tax handling is not `none`; it is `inclusive`
  exactly under `basis: "final"`, and `collectedBy` is `provider` under `merchant-of-record` and
  `merchant` otherwise.
- A `shipping` addition is `inclusive`, appears once, and only with the policy's shipping line, whose
  amount it repeats.
- Every stated discount appears exactly once as a `discount` addition whose `code` is its reference
  and whose amount is the stated one. A further `discount` addition is admitted only under
  `promotionCodes: "provider"` and carries the customer's code. All discounts together are at most
  the lines plus shipping.
- The total equals the base amount plus exclusive `tax` additions minus the discounts that are not
  stated ones (those are already inside the base amount). Inclusive additions sum to at most the total.
- Authorized and captured minors are at most the total (the base amount while no total is known).

While a total is not bound, a later observation may replace it: a hosted page recomputes tax when the
customer changes the address. Core binds the total (`frozenAt`) the first time it stores an
observation in `authorized` or `captured`; afterwards a differing total, additions or customer
details fail the observation like a differing base amount does, and stored facts stay untouched.

**Refunds** are issued against captured money, which includes tax. A Provider that knows a refund's
tax or discount share reports it as the refund's `additions`; Core stores it, requires it to be at
most the refund's amount and never to change once reported, and derives nothing from it.

**Consumers** read `totals` from the payment after `payment.changed`, keep it verbatim next to their
own lines, and use `totals.total` rather than recomputing it. When a tax addition says
`collectedBy: "provider"`, the receipt names the Provider as the seller of record. An export order
whose import charges the carrier collects on delivery uses `final`/`none` and states that on the
order; the payment carries no tax.

**Persistence.** Policy and totals are members of the payment record; a refund's additions are
members of the refund record. The `phis.payments` check constraint measures captured funds against the
total when one is present and against the base amount otherwise ([DB.md](./DB.md#phispayments)).

Subscriptions, saved payment methods, multiple captures, platform commissions and disputes remain
outside this contract (section 5); they are other kinds of extension, not richer amounts. The first
Provider mapping is in [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md) section 8.

## References

- [Commerce and Payments direction](./design/COMMERCE_AND_PAYMENTS.md)
- [Server Add-on contract](./SERVER_ADDONS.md)
- [Authentication](./AUTHENTICATION.md) and [Authorization](./AUTHORIZATION.md)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- [Stripe authorization and capture](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Stripe checkout confirmation](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted)
- [PayPal idempotency](https://developer.paypal.com/api/rest/reference/idempotency/)
- [PayPal Orders API](https://developer.paypal.com/api/orders/v2)
- [Mollie payment observation](https://docs.mollie.com/reference/get-payment)
