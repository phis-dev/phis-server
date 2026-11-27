# Payment Service and Capabilities

**Status: approved v1 contract, Core execution implemented.** Approved on 2026-10-04;
the pricing extension of section 12 (provider-added tax, shipping and discounts) was approved and built on 2026-11-02.
The consumer and Provider types are exported from `@phis/contracts/payments` and `/addon`. Core now
binds both capabilities, resolves statically installed Providers, persists merchant profiles/grants,
payments, commands, refunds and verified receipts, and routes `payment.changed` to the owning consumer.
Stored payment methods and subscriptions on Core's own schedule (section 13) were approved by the owner
and built on 2026-11-10, as an extension of this contract in place.
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

Core owns payment execution records and the schedule of a subscription (section 13), not a product
catalogue, a cart, tax calculations, invoices, inventory, fulfilment or accounting. The consuming Add-on supplies the final amount and decides what
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
is not sufficient. Unverified external hooks cannot use these consumer methods, with two exceptions:
`profileFeatures` and `chooseCollection` read what Core recorded of a profile's declarations and name
nothing of a payment, a customer or the account, so a public hook may call them (section 14). Every other
operation, including every other one under the grant `read`, refuses a hook with `forbidden`.

`complete` is the customer-flow continuation: it can only advance the previously agreed payment,
using its stored provider binding and amount. It cannot change the amount, turn manual capture into
automatic capture or replace the payment source. The Provider verifies approval itself; browser
query parameters claiming success are not accepted as evidence.

## 4. Consumer capability

The following declarations are exported from `@phis/contracts/payments`. Runtime validation is
required in addition to these types. The capability and Provider interfaces are server-only in use;
a Site may import checkout-plan types without receiving a capability or merchant credentials.

The declarations themselves are not copied here: `@phis/contracts/payments` (`src/payments.ts`) is the
contract, and a copy beside it drifted (owner, 2026-11-27). What this document states is what Core does with
them. Since phis-contracts 0.9 every yes/no fact of a record is a bit of a `flags` number, read against the
flag object named beside it, never a boolean (13.1 item 28 of the Shop's PLANS.md):

| Record | Flag object | Bits |
| --- | --- | --- |
| `PhisPayment.flags` | `PhisPaymentFlag` | `ReconciliationRequired` |
| `PhisPaymentFeatures.flags` | `PhisPaymentFeatureFlag` | `PartialCapture`, `Cancel`, `Refund`, `PartialRefund` (only with `Refund`) |
| `PhisPaymentStoredFeatures.flags` | `PhisPaymentStoredFeatureFlag` | `Expires` |
| `PhisPaymentPricingFeatures.flags` | `PhisPaymentPricingFeatureFlag` | `CollectsCustomerDetails`, `CollectsTaxIds` |
| `PhisPaymentAddition.flags` | `PhisPaymentAdditionFlag` | `Inclusive` (never on a `discount`) |
| `PhisPaymentSubscription.flags` | `PhisPaymentSubscriptionFlag` | `CustomerActionRequired`, `CancelAtPeriodEnd` |
| `PhisPaymentScheduleFeatures.flags` | `PhisPaymentScheduleFeatureFlag` | `IntervalChange`, `ChangedOutside` (prepared) |
| `PhisPaymentCurrencyFeatures.flags` | `PhisPaymentCurrencyFeatureFlag` | `SettlementRecords` |
| `PhisPaymentDocumentFeatures.kinds[].flags` | `PhisPaymentDocumentFeatureFlag` | `Fetchable`, `Delayed` |

A method's features (`probe`, `listMethods`) carry, beside capture modes, checkout kinds, pricing, `stored`
and `checkoutExpiry`: `collection` (which collection modes it can run under the probed policy, section 13),
`currency` (required: amounts, conversion, conversion currencies and cost, the merchant's settlement
currencies, `SettlementRecords`; section 15) and `documents` (the kinds the Provider issues, each `Fetchable`
and/or `Delayed`, and the issuer under the policy; section 16). Core validates each declaration and refuses
a probe with a bit or a key it does not know (`profile_unavailable`). `PhisPaymentObservedTotals.presentment`
is what the customer was shown in their own currency where the Provider converted; Core stores it with the
totals, never sums it, and refuses one in the payment's own currency. It may arrive after the total became
binding, which no other part of the totals may.

Error codes beyond those of a single payment: `rate_limited` (section 14) and `quote_outdated` (a change that
now costs more than the `expectedDue` the customer was shown, section 13).

The grant operations are `read`, `create`, `complete`, `refresh`, `capture`, `cancel`, `refund`,
`method-store`, `method-read`, `method-remove`, `subscription-read`, `subscription-create`,
`subscription-cancel`, `subscription-change` (preview, change, take back, list changes and read the credit;
the payment of `due` also needs `create`, and under `automatic` `method-store`), `document-read` (the
documents archived for this consumer's payments, through `billing:v1`) and `settlement-read`
(`listSettlements`, and only for an acting user with the Site role Admin or Accountant).

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
checks availability again when executing. It asks the Provider every time; what a profile sells as
Merchant of Record, and which collection mode a subscription would get, is also read from Core's
recording, without a Provider call, through `profileFeatures` and `chooseCollection` (section 14). `methodKey: null` means provider-managed selection; it is
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

**Checkout end.** `create` takes an optional `expiresAt`, an ISO 8601 instant with `Z` or an offset: until
when the customer can complete the payment, for a consumer that holds something for them only so long
(a Shop's stock reservation). A method states the ends its checkout can be given as
`features.checkoutExpiry: { minSeconds, maxSeconds }`, whole seconds after Core accepts the payment;
absent or `null`, it cannot be given one and a create with `expiresAt` answers `unsupported_operation`. An
end that is malformed, not ahead, or outside the method's window answers `invalid_input`: Core never moves
it, because the consumer chose it for a reason of its own. Core sends it in UTC as the create command's
`expiresAt`; the Provider ends the checkout then or, in a coarser unit, just before, never later, and
reports that end as `checkout.expiresAt`. When it comes, the payment becomes `expired` with
`payment.changed`, as any checkout that ran out. A retry with the same idempotency key is answered after
the end too, and a different `expiresAt` under the same key is an `idempotency_conflict`.
`createSubscription`, `settleSubscription` and `setupMethod` take no end: they hold nothing for the customer
that runs out, and gain one when a consumer needs it.

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
settlement accounting, dispute workflows and platform commissions are outside this execution contract.
Stored payment methods and subscriptions are section 13.

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

The listing above is the shape before 0.9; `@phis/contracts/payments` is the contract. Since 0.9 a Provider
also answers, where it declares what needs them: `listDocuments` and `fetchDocument` (required where a method
declares `documents` with a `Fetchable` kind; section 16), `observeSettlements` (required where a method
declares `SettlementRecords`; section 15), and observations whose totals carry `presentment`. Core calls
each only for a payment whose method declared it under the payment's policy, and checks every answer.
`executeSubscription`, `observeSubscription` and the notification subject `subscription` are prepared for
`provider-managed` and not called: Core ignores a `subscription` notification until the mode is built.

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

Every refusal leaves a line in Core's log, `payment.notification.refused` at `warn`, with its reason and
what the delivery named: the Provider rejected its signature or shape; the Provider could not verify it
now; no payment of this profile has the reference it names (`reference`, `subject`); the same delivery is
being processed by another call (`reference`, `deliveryId`); the Provider did not answer the reconciliation
the notification started, or its answer could not be applied (`paymentId`). A Provider Add-on answers these
as 400 or 503, and without the line the status in the Site's log was all there was to go by.

A verified notification that meets a payment another call holds (the payer's return, a refresh, the order
page asking, another notification of the same payment -- a Checkout payment brings two or three within one
second) is not refused. It is a knock: Core reads the truth from the Provider itself, and answering "done"
would be wrong, since the call holding the payment may have asked the Provider before the event. The knock is
remembered on the payment (`payments.notified_generation`, the lease generation it met), the delivery's receipt
is finished in the same transaction, and the Provider is answered `processed` -- which is true because the
knock is owed an observation: the holder looks at the payment under the same row lock that releases its lease
when it applies its result, and when a knock met its own claim it observes the Provider once more (up to
`PHIS_PAYMENT_KNOCK_REPEATS`, 3, repeats; each repeat leaves the info line `payment.reconcile.repeated` with the
payment and the count). A knock that meets a command (create, capture, refund) is answered the same way after
the command. A reconciliation that claimed after the knock and observed the Provider clears it. If the repeats
run out, or the holder crashes (its lease runs out unanswered), the knock stays and the bounded maintenance
reconciliation (`maintain --task payments`) selects the payment, as does any later reconciliation; no timer or
waiting is involved. A repeat of the same delivery finds its finished receipt and is `duplicate`. A payment
nobody holds is reconciled at once as before, one observation. A refresh, the operator and the maintenance run
still meet a held payment as `provider_unavailable`; only a notification is remembered. A remembered knock
leaves the info line `payment.notification.remembered`.

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
an operation needing recovery, not a confirmed failure. the `ReconciliationRequired` bit is set while any
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
operations, per currency (section 14); enabling checks referenced credentials and the serving instances. The first end-to-end path is a redirect checkout with one Provider and one
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
| `final` | `provider` | gross prices; the Provider reports the tax included | equals the base amount; tax additions carry `Inclusive` |
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
- A `tax` addition exists only when the policy's tax handling is not `none`; it carries `Inclusive`
  exactly under `basis: "final"`, and `collectedBy` is `provider` under `merchant-of-record` and
  `merchant` otherwise.
- A `shipping` addition carries `Inclusive`, appears once, and only with the policy's shipping line, whose
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

Multiple captures, platform commissions and disputes remain outside this contract (section 5); they
are other kinds of extension, not richer amounts. A stored-method charge and a subscription period
follow the same arithmetic as any payment (section 13). The first
Provider mapping is in [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md) section 8.

## 13. Stored payment methods and subscriptions

Part of `payments:v1`, extended in place: no further capability, service kind or notification ingress.
The reasons for each choice are in [design/SUBSCRIPTIONS.md](./design/SUBSCRIPTIONS.md) and, for collection
modes, grace and changes, in the Shop's design (`phis-shop/design/PLANS.md`, sections 5 and 7, decided
2026-11-27); this section is what is built. The types are in `@phis/contracts/payments`, the tables in
[DB.md](./DB.md#phispayment_stored_methods).

**Who owns what.** Core owns the schedule, the retries, the requests and the end of a subscription. A
Provider stores a payment method while the customer is present and charges it later without them, or
offers a checkout for a period the customer is asked to pay; it runs no schedule and decides no retry. The
consumer states the price and owns the service state. Payment details never reach phis.

**Declared per method and policy.** `PhisPaymentFeatures.stored` says whether a method can be stored and
how: `setup` (`with-payment`, `alone`), `chargeResult` (`notified`, `immediate`), the `Expires` bit,
`perPayer` (`single`, `many`) and the `pricing` a charge without a checkout can carry. `collection` says,
per collection mode, which interval units and the longest period the method runs under the probed policy:
`automatic` (requires `stored`; Core refuses a declaration of it without), `paymentRequest`, and
`providerManaged` (prepared, below). `listMethods` and `probe` take `usage: "recurring"` and then answer
only the methods that can collect a subscription in a mode Core runs: stored with `collection.automatic`,
or with `collection.paymentRequest`. Core holds no list of method names.

**Stored methods.** `create` with `store` stores the method the customer pays with (`with-payment`);
`setupMethod` opens a hosted page on which a method is stored and nothing is charged (`alone`). Either
way the record exists at once as `pending` and becomes `active` when the Provider reports the method,
or `invalid` when the payment or the page ended without one. `invalid`, `revoked` and `expired` are
final. `removeStoredMethod` revokes at the Provider first and records it second, and is refused while a
subscription that has not ended is charged to the method. Where a Provider keeps one method per payer,
a new one revokes the others and takes over their subscriptions. Storing needs the grant
`method-store`, which `create` does not imply.

**A charge without the customer** is an ordinary payment with `initiator` `schedule` or `merchant`, no
checkout, and operation action `charge`. It is not a consumer method: Core makes it for a subscription
period under `automatic`, idempotent on a key derived from the subscription, the period and the attempt.
Its answer is one of three: paid (or pending where `chargeResult` is `notified`); failed with
`payment_declined`; or failed with `customer_action_required` or `stored_method_unavailable`, after which
no retry can succeed without the payer. An unknown outcome is recovered, never sent again.

### 13.1 Collection modes

`PhisPaymentSubscriptionCreateInput.collection` says how the periods after the first are paid; it is
recorded on the subscription and never changes by itself. The consumer derives it from what the profile
declares (`chooseCollection`, section 14); `createSubscription` confirms it with a live `listMethods`
(`usage: "recurring"`): the method must collect in that mode for the interval, and carry the recurring
pricing -- `stored.pricing` under `automatic`, the method's checkout `pricing` under `payment-request`.

| Mode | Who runs the schedule | How a period is paid | Built |
| --- | --- | --- | --- |
| `automatic` | Core | Core charges the stored method; a decline is retried by `dunning.retryAfterDays` | yes |
| `payment-request` | Core | `leadDays` before the paid period ends Core opens the next one and asks the customer to pay it on a checkout (`settleSubscription`), as a one-time payment; nothing is stored | yes |
| `provider-managed` | the Provider | the Provider charges and retries; Core would mirror it | prepared only: refused with `unsupported_operation`, recorded as not usable, never answered by `chooseCollection`; a notification with `subject: "subscription"` is ignored |

The first payment stores the method only under `automatic`. `replaceSubscriptionMethod` is only for
`automatic` (`unsupported_operation` otherwise).

### 13.2 Grace, lead and the end

- **`graceDays`** (every mode, whole days 0 to 30, below the shortest period of the interval; the Site-wide
  `entitlement_grace_days` is gone): an entitlement bound to the subscription counts until the latest paid
  period's end plus `graceDays` while the subscription has not ended, until the period's end once it has.
  Each period records `graceEndsAt` (its start plus the grace). **A period still unpaid when its grace ends
  has failed, and the subscription ends (`canceled`)**, in every mode. There is no `unpaid` state.
- **`leadDays`** (`payment-request` only, 0 to 30, below the shortest period): the next period is opened
  that many days before the paid period ends. Paying early moves no boundary.
- **Dunning** (`automatic`): `retryAfterDays`, at most 8, strictly later each time, counted from the day
  the period fell due, and none past `graceDays` (refused otherwise). With a grace of 0 a declined renewal
  ends the subscription at once. Without a further attempt the customer may still settle the open period
  until the grace ends. Where the customer has to return (`CustomerActionRequired`), no attempt is made
  and the grace's end is the end; `replaceSubscriptionMethod` clears the bit and the schedule tries again.

| Status | Means |
| --- | --- |
| `pending` | the first payment is open |
| `active` | the latest period is paid; under `payment-request` a requested period may be open (`CustomerActionRequired`) |
| `past_due` | the paid period ended and the next is unpaid: retried under `automatic`, waited for under `payment-request`, until the grace ends |
| `canceled` | final: cancelled, ended at once, the first payment never captured, or a period unpaid at the grace's end |

**A `payment-request` period.** With E the paid period's end, L the lead and G the grace, each moment is
said once, as `payment.changed` with the subscription subject and its `moment`:

| When | What Core does | `moment` |
| --- | --- | --- |
| E − L | opens period n+1 (`requestedAt`), sets `CustomerActionRequired`; a scheduled change is applied first | `requested` |
| E − 3 days, only where it lies after the request | nothing but the fact | `reminder` |
| E, still unpaid | `past_due` | `due` |
| E + G − 1 day, only where G ≥ 2 | nothing but the fact | `grace-ending` |
| E + G, still unpaid | the period `failed`, the subscription `canceled` | -- |

No payment is opened at E − L (a checkout cannot stay open for weeks): the customer pays through
`settleSubscription`, which is allowed for a requested period while the subscription is `active` and for
any `past_due` period, until its grace ends, and stores nothing under `payment-request`. On capture the
period is paid, the subscription is `active` without `CustomerActionRequired`, and `nextChargeAt` is the
next request date (E′ − L). `nextChargeAt` is always when Core next acts on its own: a renewal or a retry
under `automatic`, a request, a reminder or the grace's end under `payment-request`.

**Terms.** Boundaries are computed from the start of the current term (`term.startsAt`, the column
`anchor_at`) and the period index less `term.firstIndex` (`term_first_index`), never from the day a charge
happened to succeed, so neither a late charge nor a short month moves them. A subscription that never
changed has one term from its first period; an applied change starts a new one. Each period is one row,
settled in the transaction of the payment that pays it; the payment carries `subscriptionId` and
`periodIndex` and is referenced `<subscription reference>#<index>`.

### 13.3 Changes of terms

A subscription changes what its periods cost, how long they are, its grace and (under `payment-request`)
its lead with `changeSubscription`, under the grant `subscription-change` (and `create` for the payment of
`due`). Only an `active` subscription without `CancelAtPeriodEnd`, a pending change or an open period
changes, in its currency, at its profile and in its collection mode; the new recurring pricing must be one
the stored method can carry under `automatic`.

- **Quote (`previewSubscriptionChange`), one rule:** `credit = floor(R × (periodEnd − at) / (periodEnd −
  periodStart))` by the second, rounded down in the customer's favour, summed over the paid periods that
  have not ended by `at` (the running one and, under `payment-request`, a requested one paid early). `R` is
  the recurring amount the period was charged under less what was refunded of its payment; period 0 counts
  the subscription's `recurring` at the start, never the one-time part of `first`. `charge` is the first
  period under the new terms plus `oneTime`; `due = charge − credit`. A credit beyond the charge is
  refused (`invalid_input`): that is a downgrade, which goes at the period end. No credit balance is kept.
  `period-end` quotes credit and due 0 and the boundary as `effectiveAt`.
- **`period-end`** stores the change `scheduled`. The schedule applies it before it charges or requests
  the next period: a new term starts at the boundary and the period costs the new terms.
- **`now` with nothing due** is applied at once. **With something due** the change is `awaiting_payment`
  and Core creates its payment (`<subscription reference>~<change reference>`, `initiator: "customer"`, with
  `store` under `automatic`) on the checkout the consumer names; the credit is a stated discount "Credit for
  the unused part of the current period" where the pricing carries line items. On capture, in that
  payment's transaction, the paid period ends there (`endedEarlyAt`), a new term starts with a paid period
  under the new terms (`changeId` on it), the stored method becomes the one the payment stored under
  `automatic`, and the renewal or request date moves to the new period's end. An entitlement bound to the
  subscription follows by itself.
- **`expectedDue`**: the due the customer was shown; a quote that now costs more, or a subscription that
  moved between quote and change, answers `quote_outdated`. Idempotent on `idempotencyKey`.
- **Void:** the payment of `due` ends unpaid, `cancelSubscriptionChange` takes it back (and Core ends its
  checkout where the method can be cancelled), a renewal falls due or a period is requested first, the
  subscription is cancelled at the period end or ends. A voided change changed nothing; a payment captured
  after its change was void is the consumer's to refund. `CancelAtPeriodEnd` voids a scheduled change and
  resuming does not bring it back. `changeSubscriptionPrice` is refused while a change is pending.
- `listSubscriptionChanges` answers newest first; `subscriptionCredit` the credit now, for a consumer that
  ends the subscription for a purchase. Each change, schedule, application and void is `payment.changed`
  with the subscription subject and its `changeId`.

**Ending.** `cancelSubscription` at `period-end` charges or requests nothing further and ends the
subscription with the paid period; `resumeSubscription` takes it back until then. A subscription with
nothing paid ahead ends at once. `now` ends a paid subscription at once and is a merchant action under
`merchantActions.subscriptionEnd`; it refunds nothing. `changeSubscriptionPrice` replaces what every later
period costs, under `merchantActions.subscriptionPrice`, in the same currency and, under `automatic`,
within what the stored method can carry; a period that already exists keeps its amount.

**The schedule** is the Core job `payments.subscriptions.advance`, every five minutes: it takes what is due
under a lease, acts as nobody with the consumer's scope and grant, and never charges while an earlier
payment for the same period is unresolved. A charge that could not be made at all (a disabled profile, a
withdrawn grant) uses no attempt; it is logged and looked at again in an hour.

**Events.** `payment.changed` has two subjects: a payment, and a subscription with the period it concerns,
the change (`changeId`) and the moment of a requested period (`moment`) where it is about one. A renewal
produces both, and a handler narrows on `subject.kind`.

**Grants.** `method-store`, `method-read`, `method-remove`, `subscription-read`, `subscription-create`
(also needs `create`, and `method-store` under `automatic`; it is also what a price change asks for),
`subscription-cancel` (cancel at the period end, resume, settle, change the method) and
`subscription-change`.

**Not built:** trials, pauses, a cancellation at a chosen date, `provider-managed`, and a notice when
several periods are overdue after an outage (they are charged one per run).

## 14. Profile features and the collection mode

Part of `payments:v1`, extended in place (phis-contracts 0.9: `profileFeatures`, `refreshProfileFeatures`
and `chooseCollection` replace `profileReach` and `refreshProfileReach`, owner 2026-11-27). A consumer has
to know what a profile can do where no payment is being made: which countries a Shop sells to under
Merchant of Record, which collection mode a plan would get, who issues the documents, whether a currency
is converted. Asking the Provider there means a probe per page view from a hook.

**The recording.** `phis.payment_profiles.features` holds, per uppercase currency, a
`PhisPaymentProfileFeatures`: `{ currency, probedAt, policies }`. Core asks the Provider with 100 minor units
of the currency, `automatic` capture, a `redirect` checkout, no stated discount and no promotion code, first
under `final`/`none` -- which every method supports, so the Provider answers every method it has -- and then
once per further pricing policy the methods declare (`pricing.bases` × `pricing.tax`, `merchant-of-record`
only where declared), each policy in both usages (one-time and `recurring`). Each `PhisPaymentPolicyRecording`
is the union over the methods a hosted payment could use: capture modes; `collection` per mode (every unit,
the longest `maxDays`; `providerManaged` always recorded `null` until built); `currency` (the strictest
conversion and who bears it, the union of conversion and settlement currencies, the bits OR-ed); `documents`
(each kind once with its bits OR-ed, the first method's issuer); `merchantOfRecord` (countries, categories,
business tax id handling). `probed_at` is the last time Core asked about the profile in any currency. Three
things record: `phis payment profile probe|enable --currency CHF,EUR` (each named currency, after all were
answered), `refreshProfileFeatures`, and `phis addon migrate|reconcile` when it registers a new release of the
Provider Add-on (docs/CLI.md). A currency not asked keeps its recording; `profile set` clears all of it.

**`profileFeatures`** reads the recording and never asks the Provider; `null` where the profile was never
asked in that currency. **`chooseCollection`** answers, from the recording of the currency and the policy of
`pricing`, the first mode in Core's order -- `automatic`, then `provider-managed` (never answered until
built), then `payment-request` -- that the consumer allows and that runs the interval (its unit, and its
longest possible period, months as 31 days and years as 366, within `maxDays`); `null` where none. Both need
the grant `read` and an enabled profile that is not retired (`profile_unavailable` otherwise), and are the
operations a hook may call (section 3). A single payment may still be refused, which `create` and
`createSubscription` decide when it is made.

**`refreshProfileFeatures`** asks the Provider again, per currency (1 to 16, each once) and per policy, and
records and answers each recording. It is a merchant action under `merchantActions.profileRefresh`
(operator, Site Admin, a listed role, job or event); absent means nobody, and a hook is always refused. At
most once a minute per profile, counted from `probed_at` and claimed in the same statement that moves it;
sooner answers `rate_limited`. A Provider that fails answers `provider_unavailable`; a currency recorded
before it stays recorded.

**The profiles a consumer may choose from.** Where a seller picks a profile -- a Shop's destination -- it
is chosen from `listProfiles()` (`PhisPaymentProfileSummary`: key, provider key and Add-on, mode, and `state`
`enabled` | `disabled` | `retired`), the Site's profiles whose grant for the calling consumer holds `read`,
read in one statement. No credentials, grants or merchant identity are named. A hook is refused.

**Before v1** the recording has no other shape. A profile recorded before 0.9 held `methods` (a probe per
currency); the column goes by hand (DB.md) and every profile is probed again in its currencies.

## 15. Records: what was settled

Beside the documents (section 16) Core records per captured payment and per succeeded refund what the
Provider settled on the merchant's balance (`PhisPaymentSettlement`: gross, settled, fee, withheld tax, net,
exchange rate, available and booked at), where the payment's method declared
`PhisPaymentCurrencyFeatureFlag.SettlementRecords` under the payment's policy.

- **Collecting.** The transaction that records a capture or a succeeded refund writes a task per kind the
  method declared (`phis.payment_record_tasks`: `settlements`, and `documents` where a declared kind is
  `Fetchable`). The Core job `payments.records.collect` (every five minutes, bounded per run) asks
  `observeSettlements` and records each record once by its reference per profile, never rewritten (a
  correction is a further record). The task is done once the Provider answers `complete` and the capture
  or refund it stands for has a record; otherwise it is asked again after 5 minutes, 15 minutes, 1 hour,
  6 hours, then daily, for 14 days from the fact, and then given up (`failed`). A Provider that cannot be
  reached uses no attempt; an answer that is refused does.
- **Checked.** Gross in the payment's currency; settled, fee, withheld tax and net in one settlement
  currency; `net = settled − fee − withheldTax`; an exchange rate a positive decimal string that never enters
  Core arithmetic; a refund's record named by a refund Core has observed (another waits for the next
  attempt). An inconsistent answer is refused (`provider_unavailable`).
- **Read.** `listSettlements(paymentId)`, oldest first, under the grant `settlement-read` and only for an
  acting user with the Site role Admin or Accountant (`forbidden` otherwise, and for a job, an event, the
  operator and a hook). The customer sees only what they paid (`totals`) and, where converted,
  `presentment`.

## 16. Billing documents (`billing:v1`)

Core keeps every billing document of a Site in one place -- the Provider's, fetched after a payment, and the
merchant's own, issued by Add-ons -- and shows a person all of theirs and Admin and Accountant all of them
(`@phis/contracts/billing`, `@phis/server/billing:v1`; owner, 2026-11-27). The tables are in
[DB.md](./DB.md#phisbilling_documents); the Add-on contract in [SERVER_ADDONS.md](./SERVER_ADDONS.md).

- **The Provider's documents.** A `documents` task (section 15) asks `listDocuments` for the payment's
  binding, records each document of a declared `Fetchable` kind once by its reference (unique per Site and
  source) as `pending`, fetches what is `ready` with `fetchDocument` into Core's private store -- counting
  the bytes against the Site's largest object and hashing them -- and marks it `available`. The task of a
  capture waits for every declared kind but the credit note, the task of a refund for the credit note. The
  document belongs to the payment's `documentSubject` and is listed by its `documentLabel` (`create` and
  `createSubscription` take both; a subscription's payments inherit them), its sale's reference is the
  subscription's number for a subscription's payments and the payment's reference otherwise. A task given up
  after 14 days leaves its documents `failed`; Accounting's **Retry** (and `phis billing documents retry`)
  starts it again.
- **Issued documents.** An Add-on the Site's operator allowed as a source (`phis billing source allow`, for
  kinds its manifest declares in `billing.issues`) issues for its own sales, or for an Add-on whose manifest
  names it in `billing.issuedBy`. `issue` writes the document and, for an invoice, credit note or reminder,
  takes its number from the open series of the key it names (a series that lists the source and the kind),
  in the same transaction: the counter row per series and reset period is advanced under its row lock and
  rolls back with the document -- gap-free, never a sequence; a voided document's number is a used number.
  With `file: "follows"` the document is `pending` until `attachFile` streams its PDF (size and sha256
  checked while it is stored, once); a receipt or confirmation may be issued with `file: "none"` and is
  `available` at once, served as Core's page of its content. From `issue` on nothing of it changes but the
  file, the status, `paymentState`, `Credited` and `Detached`. A credit note names its invoice and is refused
  where the credited total would pass the invoice's; one that reaches it sets `Credited`. `void` withdraws a
  document still `pending`; the job `payments.records.collect` voids an issued one still `pending` after 24
  hours (reason "not completed"). `setPaymentState` is its issuer's, for an invoice or reminder. Idempotent on
  the source's `idempotencyKey`: the same request answers the same document, another `idempotency_conflict`.
- **Number series.** Defined by Admin and Accountant in Accounting (`/api/site/accounting/billing-series`) or
  by `phis billing series`. The template is literal text (`A-Z a-z 0-9 - _ / .`), exactly one serial `{x…}`
  whose number of `x` is a minimum width that keeps counting past it, and at most once each `{YYYY}`, `{YY}`
  and `{MM}` (the issue date in the Site's time zone; a month never resets). `reset: "yearly"` needs a year in
  the template; the number at the serial's minimum width fits 40 characters. Once a series numbered a
  document (`Used`) its key, template and reset never change and its kinds only grow; a new template is a new
  series of the same key that closes the old one in the same step (`replaces`). At most one open series per key.
- **Access.** The person reads and opens their own documents, never a detached one; Admin and Accountant
  (the Site roles, never the Site access `accounting`, which also admits a Maintainer) every document of the
  Site; a Supporter the list of an open ticket's requester (`/api/site/support/tickets/:id/billing-documents`),
  without content and without opening; a Maintainer nothing. An Add-on reads what it issued and what documents
  its own sales; across issuers by `subject` only for an acting person who is that subject, or Admin or
  Accountant; it opens a file only through `open`, for an acting person who may open it.
- **Opening.** `open` answers a signed address on the Site's origin (`/api/site/billing-documents/:id/file`),
  for one document and one disposition, valid 300 seconds by default and at most 900, served
  `Cache-Control: private, no-store`. The signature is an HMAC under the installation's
  `auth.transactionEncryptionKey`, which no Site runtime holds. A document not `available` is refused.
- **Storage.** Core's own private store on the Site's Storage Provider under
  `core/billing-documents/<site>/<year>/<id>`, never a Media Space's and never an Add-on's, with a quota of its
  own (`phis site set --billing-quota-bytes/--billing-quota-objects`; none by default).
- **Retention.** `retainUntil` is the end of the calendar year of the issue (in the Site's time zone) plus ten
  years, for every issuer (OR art. 958f, MWSTG art. 70); the daily job `billing.documents.retain` removes the
  file and then the record. Deleting a person's account detaches their documents (`Detached`, subject gone)
  in the same transaction; staff reach them through the sale's reference. A Site purge removes them with it.
- **Events.** `billing-document.changed` (issued, available, voided, credited, payment state changed, given
  up) reaches the document's source Add-on and, where different, its consumer Add-on, where they declare the
  handler; it carries no state.

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
