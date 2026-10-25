# First Payment Implementation: Stripe Hosted Checkout

**Status: approved v1 Provider and administration contract, implemented in the workspace.** Approved
on 2026-10-04. Core execution, merchant persistence, CLI profile/grant controls and the independent
`@phis/stripe` adapter are implemented. A real test-mode hosted checkout for CHF 19.90 passed through
the Core engine and bundled adapter, followed by a CHF 5.00 partial refund, an idempotent retry of that
refund, and refund of the remaining CHF 14.90. CHF/EUR/USD checkout creation and expiry also passed.
The sandbox driver used isolated database fixtures and the Provider factory directly; it did not
install a consumer or activate a Site. Subsequently, on 2026-10-04, Stripe was installed on a
separate compiled test installation and its Core was updated. That installation's
`stripe-sandbox` test profile is enabled with encrypted credential references and no consumer grants.
The public hook accepted a genuine Stripe `checkout.session.expired` event (HTTP 200, zero pending
webhooks) using the Dashboard endpoint's `2026-08-26.dahlia` event version. That Session carried no
Core Payment correlation and was correctly acknowledged as irrelevant; this verifies transport and
signature checking, not durable settlement or consumer fulfilment. Locally signed smoke requests
also returned 200, while missing, invalid and body-mismatched signatures returned 400.

The subsequent public settlement test used the installable `@phis/payment-probe` fixture through
authenticated operator HTTP routes. A CHF 19.90 hosted test purchase was settled solely by genuine
Stripe notifications: the consumer has no completion/refresh grant, and no `complete` operation was
created. The durable inbox and owner outbox were processed, and the consumer stored exactly one
fulfilment row. Three concurrent, freshly signed replays of one genuine Stripe event were acknowledged
as duplicates without changing the Payment version or fulfilment count. The full refund and its
idempotent repeat returned the same operation/refund identities. Concurrent reservation conflicts
returned retryable HTTP 503; re-signed genuine pending events subsequently processed successfully.
Both sandbox purchases from the test runs were fully refunded, with no pending Core receipts/events.
The test consumer was disabled, its profile grant removed and the temporary operator deleted.
Evidence: `/opt/projects/artifacts/phis-payment-settlement-test-20261004.json`. Remaining scenarios
are tracked in [TODOS.md](./TODOS.md).

## 1. Deliverable and ownership

The first deliverable is a complete test-mode purchase through a small test Consumer Add-on and
`@phis/stripe`, followed by a partial refund. Both use the target v1 Core Payment capability.
The test consumer owns one amount due and a paid/unpaid flag; it is not a catalogue or Shop engine.
The existing `@phis/shop` package is a Core-bound Site Module, not this server-side test consumer.

First-provider support is deliberately explicit:

- Hosted redirect checkout for one-time card payments, with automatic or manual capture.
- One final capture, full or partial; authorization cancellation and checkout expiry.
- Full or partial refunds, including observations of refunds made in the Stripe Dashboard.
- Independent test/live merchant profiles, signed notifications and durable recovery.

`methodKey: "card"` and provider-managed selection (`null`) both select the same bounded card-only
method set initially. Other methods are added only after their execution, expiry and refund semantics
are mapped. Stripe-hosted wallets that belong to the card path need no separate Phis card-entry UI.
Provider UI plans, subscriptions, Connect, saved cards and Medusa integration are later deliveries.

Core remains responsible for execution records and orchestration. The Provider owns Stripe API
translation; the consumer owns order access, amount calculation and fulfilment. A single generic
checkout line represents the consumer's final agreed amount; Core never imports order lines.

## 2. Merchant administration and grants

Profiles are Core-owned configuration rather than mutable consumer settings. The first control plane
is the operator CLI. No merchant settings page or browser profile-edit API is required for this slice.
The following types are exported by `@phis/contracts/payments` for persisted administrative values:

```ts
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

export type PhisPaymentProfileDraft = {
  key: string;
  providerKey: string;
  mode: "test" | "live";
  credentialReferences: Readonly<Record<string, string>>;
  grants: readonly PhisPaymentProfileGrant[];
};
```

Core binds the Site and configuration revision outside these values. A profile starts disabled.
Before enabling it, Core checks the Provider's installation, activation, interface digest, migration
and instance readiness, all referenced secrets, merchant identity/mode and operation support.
The Stripe adapter establishes the authenticated account identity and mode through read-only API
responses, rather than accepting an account id supplied by a browser. A successful probe does not
prove that the configured webhook endpoint is reachable; the sandbox notification test does that.

Credential bundle slots for Stripe are `apiKey` and `webhookSecret`. Each slot references a declared
secret of `@phis/stripe` on that Site. Distinct named secrets allow several profiles of the same
Provider. No API key, webhook secret or payment token is a CLI argument or profile export. Secret
values enter through the existing protected secret-write mechanism. The adapter's bound
`readCredentials()` resolves only that profile's validated references.

`read` covers `listMethods`, `get`, `getOperation` and `getRefund`. Each remaining grant names its
capability operation. Grants are checked on stored payments as well as new ones. Removing a grant
stops the consumer's access; operator reconciliation remains possible without transferring ownership.
There is no implicit default merchant profile and no automatic grant to an installed consumer.

For capture, cancel and refund, an operation grant is necessary but not sufficient:

| Bound context | Additional merchant authority |
| --- | --- |
| Authenticated operator | Allowed on the explicitly selected Site |
| Authenticated Site Admin | Allowed within the granted consumer/profile |
| Ordinary Site user | One listed role of this consumer is required |
| Declared consumer job | Its job id must be explicitly listed for this action |
| Core-delivered consumer event | Its event id must be explicitly listed for this action |
| Internal transport actor or external hook | Refused |

Empty policy lists mean operator/Site Admin only. Role names are validated against the consumer's
manifest and evaluated through existing authorization, never against a supplied boolean or another
Add-on's role. Job/event entries must also exist in that consumer's manifest. A Core binding supplies
the actual context identity; request arguments cannot choose a job or event identity. Profiles cannot
grant consumers installation-wide administration. A customer's return route may call `complete`
after the consumer checks order access; it never inherits merchant authority.

The target CLI command group is `phis payment profile`, with `list`, `add`,
`set`, `probe`, `enable` and `retire`. `add`/`set` accept a validated profile/grant file containing
secret references. `set` cannot replace provider/account/mode on an established profile. Exact flags and a credential-reference example are documented in [docs/CLI.md](./docs/CLI.md#payment-profiles). A bounded recovery command belongs in the
existing `phis maintain` registry and supports dry-run, concurrent runs and repeated invocation.
There is no profile delete, payment purge or live-charge smoke test in this slice.

## 3. Checkout creation and remote binding

1. The consumer checks its business record and the caller's access. It supplies a final amount,
   stable reference and attempt-specific idempotency key.
2. Core validates currency/minor units, grants, profile and same-reference attempts. In one
   transaction it reserves the payment and create operation, pins configuration/merchant binding
   and stores the canonical command and stable provider idempotency key.
3. Outside that transaction the Stripe adapter creates a payment-mode Checkout Session with one
   fixed quantity/amount line, card methods, the agreed capture mode and Core's return URL. Promotions,
   adjustable quantities, automatic tax and additional shipping charges are disabled: the agreed
   total cannot change inside Checkout.
4. Session and PaymentIntent metadata carry only opaque Core payment/create-operation identities.
   No guest access token, email or full order record is copied into correlation metadata.
5. Core commits the normalized observation and returns the hosted redirect URL. A transport failure
   after submission persists an indeterminate operation; it does not create a replacement checkout.

Stripe's Session API supplies inline line-item pricing, payment-mode intent configuration and hosted
redirect URLs. See [Session creation](https://docs.stripe.com/api/checkout/sessions/create).

The opaque Provider binding uses the Core payment identity as its stable reference and records the
Session id, then the associated PaymentIntent id when available. The adapter uses those identifiers
for authenticated reads. Core need not understand Stripe object prefixes. Metadata on a verified
notification is only correlation: the retrieved object must still match the pinned merchant, mode,
amount, currency and stored Session/intent relation before an observation is admitted.

Hosted success and cancel URLs both use Core's canonical Site-local return URL. The consumer displays
the actual persisted/reconciled result. A Stripe query parameter or visiting the cancel URL proves
neither collection nor cancellation. Core payment ids in URLs are correlation, not order-access
credentials. No Stripe frontend SDK is necessary for the initial hosted redirect.

## 4. Stripe observations and commands

The adapter retrieves the Session, its PaymentIntent/charge where present and all refunds for that
intent. Every API read is bounded. Refund pagination must finish before emitting a complete
observation; reaching the read budget returns an availability failure rather than truncated totals.
Reconciliation never stores an incomplete refund list as if it were authoritative.

The normalized state considers both Session and PaymentIntent:

| Observed facts | Core state |
| --- | --- |
| Session open, awaiting method/customer action, no collected funds | `awaiting_customer` |
| Intent processing, including a completed but unpaid Session | `processing` |
| Intent `requires_capture`, confirmed capturable funds | `authorized` |
| Intent succeeded, confirmed amount received | `captured` |
| Intent canceled, no captured funds | `canceled` |
| Session expired, no unresolved authorization/processing/capture | `expired` |
| Confirmed terminal failure, customer cannot retry that Session | `failed` |

A recoverable card failure while the Session remains open stays `awaiting_customer`. PaymentIntent
states are not a single monotonic numeric rank. Core uses immutable financial facts, current remote
observations and operation/version fences. An expiry event cannot erase confirmed authorization or
collection. Card authorization expiry is reported from Stripe when available, never a fixed Core
duration. See [Session state](https://docs.stripe.com/api/checkout/sessions/object) and
[authorization holds](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method).

`complete` on this adapter is authenticated observation only; Stripe already drives customer
confirmation. For manual mode it returns authorization without capture. `capture` invokes the intent
capture endpoint with the agreed amount and final-capture semantics. A smaller final capture releases
the rest; the consumer decides whether that reduced amount fulfils its business obligation.
See [capture](https://docs.stripe.com/api/payment_intents/capture).

`cancel` expires an open Checkout Session. For a confirmed manually authorized intent it instead
cancels that authorization. It cannot cancel collected funds, and a processing result is not guessed
to be cancelable. A race with payment success is resolved by retrieving the actual result. An explicit
merchant expiry of an unpaid Session maps to `expired`, not an invented Stripe canceled state.
See [Session expiry](https://docs.stripe.com/api/checkout/sessions/expire) and
[Checkout intent cancellation](https://docs.stripe.com/api/payment_intents/cancel).

`refund` creates a refund against the bound intent for the reserved minor amount and carries the opaque
Core refund-operation id in metadata. Consumer reason strings are not passed blindly into Stripe's
finite reason enum. Core retains the reason; the adapter maps a supported reason or omits that API
field. Pending refunds reserve balance, and unsuccessful refunds release it only on confirmed status.
External dashboard refunds get stable Core refund identities without invented local commands.
See [refund creation](https://docs.stripe.com/api/refunds/create) and
[refund listing](https://docs.stripe.com/api/refunds/list).

Core serializes its own amount reservations. A merchant can still refund directly in Stripe between
an observation and a command; Stripe remains the final authority over that external race. The adapter
reconciles a refusal/current balance rather than assuming a local reservation controls the Dashboard.

## 5. Notification ingress and durable acknowledgement

The Provider manifest specifies a Site-scoped `POST` hook at
`/api/hooks/phis/stripe/payments/{profileKey}`. It requests `payment-notifications:v1`; its handler
calls the bound `receive({ profileKey })` and does no consumer data mutation.
The generated Site proxy preserves original body bytes and `Stripe-Signature`, stamps the configured
Site key, and forwards without an internal token. Signing cannot tolerate JSON parse/reserialization.

The adapter verifies the raw bytes with the official Stripe SDK and that profile's webhook secret,
including timestamp tolerance. The verified event's id is the delivery id. Supported events include
Session completion/expiry, intent success/processing/capturable/cancellation/payment failure, and
refund/charge-refund changes. An async Session event is reconciled correctly even though broader
payment methods are not advertised initially. Unsupported event types may be ignored only after
signature verification. See [Stripe webhooks](https://docs.stripe.com/webhooks) and
[event types](https://docs.stripe.com/api/events/types).

Refund and charge events resolve the parent intent and its correlation through authenticated API
reads. A supported event about an unrelated Stripe payment with no Phis correlation is irrelevant.
An event claiming a Phis identity that has not yet been correlated is retryable, never an authority
to create a local payment. The signed event's `livemode` must match the profile. Core reads the latest
Provider state instead of applying an old event body's payment state.

Required HTTP mapping:

| Result | HTTP response |
| --- | --- |
| Observation/inbox/outbox durably committed | `200` |
| Previously processed delivery | `200` |
| Authenticated irrelevant event | `200` |
| Malformed body, rejected signature/mode/correlation | `400` |
| Body exceeds declared hook limit | `413` |
| Hook rate limit reached | `429` |
| Active receipt claim, unknown pending correlation, unavailable credentials/API/database | `503` |

Typed notification failures distinguish rejected input from retryable unavailability. Responses
contain no raw Provider errors or secrets. Existing generic hook verification is omitted for this
hook because its raw-body HMAC scheme cannot implement Stripe's timestamp/composite signature.
The hook's actor remains unverified; `receive` is a narrow Core-controlled ingress, not a general
write capability. The hook contract permits this verified Core ingress while preserving the
prohibition on ambient writes by an unverified hook; its Payment implementation is the bound Core ingress described here.

Inbox uniqueness is `(Site, profile, Provider delivery id)`. A bounded claim has a fencing token;
an expired claim can be reacquired. The final state transaction requires that token, applies the
observation, enqueues any consumer event and marks the receipt processed together. A crash leaves a
retryable claim. A live competing claim gets `503`, not a premature successful duplicate response.
Different event ids about the same payment reconcile under the payment lock. An unchanged
observation does not increment its payment version or enqueue an extra event.

Checkout fulfillment requires webhook handling and an idempotent consumer; the browser return is
only an additional opportunity to reconcile. See
[Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted).

## 6. Event contract extension

The outbox and `PhisAddonEventContext` use a
discriminated subject and event-specific context union; it does not encode a payment as a thread.
The following facts form the target context union:

```ts
export type PhisAddonEventFacts =
  | {
      event:
        | "thread.message.created"
        | "thread.message.updated"
        | "thread.status.changed"
        | "thread.link.removed";
      subject: { kind: "thread"; threadId: number; messageId: number | null };
    }
  | {
      event: "payment.changed";
      subject: {
        kind: "payment";
        paymentId: string;
        reference: string;
        version: number;
        operationId: string | null;
        refundId: string | null;
      };
    };
```

The typed context intersects that union with existing Add-on/Site/delivery/capability/signal fields.
Thread delivery supplies `kind: "thread"`; payment delivery supplies `kind: "payment"` and selects the
owning consumer. Both use the checked outbox subject and delivered event catalogue.
Thread handlers narrow their event and receive thread facts. All existing producers, dispatchers and
handlers change together; there is no optional kind or runtime legacy fallback.

The outbox has a checked subject kind and payment reference; `thread_id` is nullable only for
payment rows. A database constraint requires exactly the subject selected by the kind. Concrete table
DDL, indexes and foreign keys are documented in [DB.md](./DB.md#payment-execution). Thread recipient selection
continues to use synced links. Payment recipient selection is solely the stored consuming Add-on on
that Site, and requires its declared `payment.changed` handler. No thread link is necessary.

Changes to public payment facts, operation outcomes or refunds cause a versioned event. A no-change
read does not. The consumer reads current Core state and compares confirmed collection to its own
amount due. Its paid/fulfilment update commits with its own delivery/business idempotency record;
external fulfilment side effects use its own durable mechanism. Core only owes durable event delivery.
An inactive consumer retains pending delivery for later activation. Consumer failure cannot roll back
already collected funds or make the Provider notification require fulfilment before acknowledgement.

## 7. Recovery and implementation order

Core records the first possible submission time and the stable provider key before calling the PSP.
Stripe's finite idempotency retention cannot justify replaying an old financial request. The approved
v1 Provider command deliberately carries no durable submission timestamp; this adapter therefore
uses read-only recovery for every repeated/indeterminate command. It retrieves known objects or
correlates lost creation bindings through a bounded Session scan. It never submits a financial POST
from `recover`. An unresolved result stays indeterminate, including outside Stripe's retention window.
The canonical return URL remains in the stored command. See
[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

The reviewed implementation order remains:

1. The Payment, hook/event/profile contracts and shared types are approved. Implement their Core
   execution support before admitting the Payment capabilities, service kind and event in catalogues.
2. Implement minimal Core persistence, reservations, scoped authority, typed Provider registry binding,
   notification inbox and transactional owner-directed event production.
3. Implement operator profile/probe/grant control and bounded recovery; no automatic live charges.
4. Implement the independent `@phis/stripe` Add-on through static CLI installation/activation.
5. Implement the minimal test consumer and validate with a real Stripe test-mode account.
6. Build the small Shop consumer only after the complete path passes. Additional Providers and Medusa
   remain separate packages and follow their own scoped verification.

Required verification combines fake-provider fault/concurrency tests, PostgreSQL transactional tests
and a real Stripe sandbox checkout. Cover successful collection without browser return, a recoverable
card decline, manual authorization/partial final capture, unpaid expiry, partial/external refunds,
wrong signature/mode/Site/owner, duplicate/concurrent notifications, failure after remote acceptance,
failure after state commit, API replay-window expiry and consumer outbox failure. Assert one remote
financial operation and one business fulfilment despite retries. Sandbox credentials are a prerequisite
for the external test, not for implementing Core and its automated fault tests.

Published Sites and parallel `phis-server`/`phis-ui` development stay separate.
No production/live merchant setup, deployment, Site restart or change to a published installation is
implied by this implementation design.
