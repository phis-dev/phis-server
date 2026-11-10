# Subscriptions: Recurring Payments

**Status: built on 2026-11-10.** What is built is normative in [PAYMENTS.md](../PAYMENTS.md) section
13; this document remains as the reasoning behind it, written before the build. Where the two differ,
PAYMENTS.md is right. Decided by the owner on 2026-11-10: subscriptions are part of `payments:v1` and
not a capability of their own; Core runs the schedule, a Provider only stores a payment method and
charges it; and whatever a Provider can or cannot do is a capability it declares per payment method.

- The first Provider's mapping: [phis-stripe/design/SUBSCRIPTIONS.md](../../phis-stripe/design/SUBSCRIPTIONS.md)
- The first consumer: [phis-shop/design/SUBSCRIPTIONS.md](../../phis-shop/design/SUBSCRIPTIONS.md)

Core names no Provider and no consumer below. A Provider is any Add-on that supplies
`@phis/server/service/payments`; a consumer is any Add-on granted a merchant profile, today the Shop,
later any Module that sells.

## 1. Why

A Site that sells a contract running until cancelled (a plan billed every quarter, a membership billed
every year) can today only take a one-time payment. Every renewal is then manual work, the customer has
to pay again each time, and nothing in the system says whether the contract still runs.

What is wanted: the customer pays the first period once on a hosted page, every following period is
charged to the same payment method without anybody doing anything, the customer can replace the payment
method or cancel inside the Site, and the consumer learns when a renewal fails or a contract ends.

## 2. Who owns which part

| Part | Owner | Reason |
| --- | --- | --- |
| **The schedule**: period boundaries, when the next charge is due | Core | The same rule for every Provider; three of eight compared Providers have no schedule of their own |
| **Retries and dunning**: what happens after a failed renewal | Core, within a policy the consumer states | A Provider's retry rules would otherwise become the merchant's policy |
| **The stored payment method** | the Provider holds it; Core holds an opaque reference and its observed state | Payment details never pass through phis |
| **The charge**: moving money for one period | the Provider executes, Core commands and records | Exactly the split of a one-time payment |
| **The price**: lines per period, one-time lines of the first period, tax policy | the consumer states it, Core stores the agreement | As PAYMENTS.md section 12 |
| **The service state**: is what was sold switched on | the consumer alone | "The event is not a command to ship" (PAYMENTS.md section 7) holds for every renewal |
| **The billing document**: the numbered invoice or receipt a customer receives | the consumer (section 9) | Numbering and layout are the merchant's accounting, not payment execution |

**Why Core runs the schedule.** Eight Providers were compared from their documentation on 2026-11-10
(Stripe, Mollie, PayPal, Adyen, Datatrans, Payrexx, Wallee, Worldline Saferpay). Five have a
subscription product, and the five disagree on everything a contract would have to fix: plan objects or
inline prices, invoices or none, how often a failed charge is retried and what happens afterwards,
whether cancellation at the period end exists, and which events are sent. Adyen, Datatrans and Saferpay
have no schedule at all. All eight do share one thing: store a payment method while the customer is
present, charge it later without the customer for a freely chosen amount, and answer paid, failed, or
"the customer has to come back". The contract is built on that, so a merchant's retry rules,
cancellation terms and document numbers are the same whichever Provider is behind the profile.

The cost is real: Core gains a scheduler, a retry policy and the flow that brings a customer back, and
gives up Provider-side features such as adaptive retry timing. A Provider-run schedule is not built. It
could be added later as one more declared capability if a Provider can only be used that way.

## 3. Three additions to `payments:v1`

Subscriptions add three things to the existing contract, and each stands on the one before it.

1. **A stored payment method.** A record Core keeps for a payer and a merchant profile, with the
   Provider's opaque binding behind it. It comes into being while the customer is present, either
   together with a payment or by a set-up without a payment.
2. **A merchant-initiated Payment.** An ordinary Payment that is created against a stored method instead
   of a checkout. It has no checkout plan, captures automatically, and otherwise obeys every rule of
   PAYMENTS.md: totals, refunds, operations, reconciliation, `payment.changed`.
3. **A subscription.** The agreement (payer, stored method, lines per period, interval, dunning policy)
   and its schedule. For every period Core creates one period record and the merchant-initiated Payment
   that settles it.

**A renewal is a Payment, not a new kind of record.** Under a Provider-run schedule this was not
possible, because the Provider would have created charges that no consumer had commanded. With Core
running the schedule the objection is gone: Core creates the Payment under the consumer's stored
agreement, with a reference and an idempotency key derived from the subscription and the period. One
rule of PAYMENTS.md is widened to allow it: section 4 lets only a consumer call create a Payment; a
scheduled charge is created by Core on behalf of the consumer that owns the subscription, and is
recorded as such (`initiator: "schedule"`). Refunds, totals, receipts and the event need no second
implementation.

**Nothing is versioned.** Before v1 the contract is extended in place: the capability, the service kind
and the notification capability keep their names, and the tables are altered in the creation script and
by hand on existing databases (section 13).

**What the extension must not break.** A Provider built before it is still admitted, because admission
reads the names and not the shape. So Core never calls a new Provider command unless the Provider's own
probe has declared the feature for that method (section 4), and a consumer discovers support through
`listMethods` instead of assuming it.

## 4. Declared capabilities, per payment method

`PhisPaymentFeatures` gains one member. `null` means the method cannot be stored, and that is the
answer of every existing Provider build.

```ts
export type PhisPaymentStoredFeatures = {
  /** How a stored method comes into being with the customer present. */
  setup: readonly ("with-payment" | "alone")[];
  /** "notified": the outcome of a charge may arrive later; "immediate": only in the command's answer. */
  chargeResult: "notified" | "immediate";
  /** The stored method ends by itself; `expiresAt` is then set on the record. */
  expires: boolean;
  /** "single": a new stored method for the same payer replaces the previous one at the Provider. */
  perPayer: "single" | "many";
  /** Pricing policies a charge without a checkout supports; narrower than the method's checkout pricing. */
  pricing: PhisPaymentPricingFeatures;
};

export type PhisPaymentFeatures = {
  // ...existing members
  stored: PhisPaymentStoredFeatures | null;
};
```

- `listMethods` and the Provider's `probe` gain `usage: "one-time" | "recurring"`. For `recurring` a
  Provider lists only methods it can store and charge for that amount, currency and pricing, exactly as
  it filters by amount and capture mode today. Limits and "needs activation at the Provider" therefore
  need no fields: a method that is not usable is not listed.
- Whether a wallet method can be used for renewals is this declaration and nothing else. Core has no
  list of method names and no rule such as "cards only".
- `pricing` is separate because a hosted checkout can collect an address and compute tax, and a charge
  without the customer cannot. A Provider declares which tax handlings it can compute for a stored
  charge; where it declares none, renewals use prices the consumer has computed (`final`, tax `none`).

## 5. The contract extension

A sketch; names and bounds are settled at promotion. All types live in `@phis/contracts/payments`.

```ts
export type PhisPaymentStoredMethod = {
  id: string;
  profileKey: string;
  payerReference: string;            // chosen by the consumer, opaque to Core; never null
  methodKey: string;
  display: { title: string; hint: string | null };  // "Visa", "ends 4242"; nothing that identifies a card
  status: "pending" | "active" | "invalid" | "revoked" | "expired";
  expiresAt: string | null;
  version: number;
};

export type PhisPaymentInterval = { unit: "day" | "week" | "month" | "year"; count: number };

export type PhisPaymentDunningPolicy = {
  retryAfterDays: readonly number[];          // e.g. [3, 5, 7]; at most 8 entries, at most 30 days in sum
  onExhausted: "unpaid" | "cancel";
};

export type PhisPaymentSubscription = {
  id: string;
  reference: string;                          // the consumer's business reference
  profileKey: string;
  payerReference: string;
  storedMethodId: string | null;
  interval: PhisPaymentInterval;
  recurring: PhisPaymentPricing;              // the lines of every period
  dunning: PhisPaymentDunningPolicy;
  status: "pending" | "active" | "past_due" | "unpaid" | "canceled";
  customerActionRequired: boolean;            // a charge needs the customer; retries are paused
  period: { index: number; startsAt: string; endsAt: string } | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  endedAt: string | null;
  version: number;
};

export type PhisPaymentSubscriptionPeriod = {
  subscriptionId: string;
  index: number;
  startsAt: string;
  endsAt: string;
  amount: PhisPaymentMoney;
  status: "open" | "paid" | "failed" | "void";
  paymentIds: readonly PhisPaymentId[];       // every attempt; the paid one is last
};
```

Added to `PhisPaymentsCapabilityV1`:

| Method | Who may call | Effect |
| --- | --- | --- |
| `createSubscription` | consumer, customer present | Stores the agreement as `pending` and creates the first Payment: one-time lines plus the first period, with `store` set. Returns the checkout plan. The subscription becomes `active` when that Payment is captured |
| `getSubscription`, `listSubscriptionPeriods` | consumer | Read |
| `cancelSubscription({ at })` | `period-end`: consumer on the customer's or staff's behalf; `now`: merchant action | `period-end` sets `cancelAtPeriodEnd`; no further charge is created. `now` ends it at once and refunds nothing by itself |
| `resumeSubscription` | consumer | Clears `cancelAtPeriodEnd` before the period ends |
| `settleSubscription` | consumer, customer present | Creates a customer-present Payment for the open period with `store` set; on capture the period is paid and the new method replaces the old one |
| `setupMethod` | consumer, customer present | A set-up without payment: returns a checkout plan; the stored method becomes `active` when the Provider confirms |
| `replaceSubscriptionMethod` | consumer | Points the subscription at another active stored method of the same payer and profile |
| `getStoredMethod`, `listStoredMethods({ payerReference })` | consumer | Read |
| `removeStoredMethod` | consumer | Revokes at the Provider; refused while a subscription that is not ended uses it |

`create` (the existing method) gains `store: { payerReference: string } | null`. A one-time purchase can
therefore store a method too, which is all a later "pay with the saved method" needs; no consumer has to
use it.

Rules:

- **One interval and one currency per subscription**; quantity is part of the lines. Period boundaries
  are computed from the start of the first period and the period index, never from the previous charge
  date, so a late charge does not move the schedule. A day that a month lacks is clamped to its last day.
- **The first period starts when the first Payment is captured.** A subscription whose first Payment
  expires or fails ends as `canceled` without a period.
- **A price change is an explicit merchant command** that replaces `recurring` from the next period on,
  with no proration; the consumer tells the customer. It is cheap because Core owns the schedule, and it
  is a structural question whether it belongs to the first build (section 14).
- **Not in the first build**: trials, pauses, proration, plan changes within a period, cancellation at a
  chosen date, several subscriptions settled by one charge.

## 6. A renewal

When a period is due, Core:

1. creates the period record for index `n` (unique per subscription and index);
2. creates a Payment with `initiator: "schedule"`, reference `<subscription reference>#<n>` and an
   idempotency key derived from subscription id, `n` and the attempt number;
3. commands the Provider to `charge` the stored method;
4. applies the answer.

| Answer | Subscription | Period | What the consumer sees |
| --- | --- | --- | --- |
| captured | `active`, next period scheduled | `paid` | `payment.changed` for the Payment and for the subscription |
| pending (`chargeResult: "notified"`) | unchanged until the notification or a `refresh` | `open` | nothing yet |
| declined | `past_due`; the next attempt is scheduled by the dunning policy | `open` | event |
| the customer must return | `past_due`, `customerActionRequired`; automatic attempts stop | `open` | event |
| the stored method is no longer valid | as above, and the stored method becomes `invalid`, `revoked` or `expired` | `open` | event |
| unknown | the existing recovery of PAYMENTS.md section 8; no second charge until it is resolved | `open` | nothing until resolved |

**The customer must return.** A Provider can answer that the payer has to authenticate or register the
method again. No retry can cure that, so Core stops attempting and flags the subscription. The consumer
tells the customer and offers `settleSubscription`, which is an ordinary hosted checkout for the open
period that stores the method anew. The deadline is the end of the dunning window.

**Dunning.** After a decline Core retries on the days the policy names, counted from the due date. When
the attempts are used up or the window has passed, the period becomes `failed` and the subscription
`unpaid` (no further charges; staff or the customer decide) or `canceled`, as the policy says. Core
sends no message to the customer; it emits the event, and the consumer owns the wording, as for every
other occasion.

**A stored method that ends by itself.** Where a method declares `expires`, Core knows the date. It
flags the subscription ahead of the first period that the method will not outlive, so the consumer can
ask the customer to renew it instead of finding out through a failed charge. Revocation outside phis
(the payer withdraws a mandate in their banking app) reaches Core as a notification or as the answer to
the next charge.

## 7. The scheduler

A Core job, registered like the existing delivery jobs. On each run it claims subscriptions whose
`nextChargeAt` has passed, with a fencing token, and performs section 6 for each.

- **Exactly one charge per period.** The period row is unique per subscription and index, and the
  Payment's idempotency key is derived from it; a run that dies between the two steps is repeated
  without a second charge, by the same reservation rules as any Payment (PAYMENTS.md section 8).
- **While phis is down nothing is charged.** After recovery the overdue periods are charged oldest
  first, one per subscription per run, on their original boundaries. A subscription more than one period
  behind is flagged rather than silently charged several times in a row; the default is to charge the
  oldest open period only and leave the rest to the dunning policy (section 14).
- **A withdrawn grant stops the schedule.** Authority for a scheduled charge is the profile grant that
  allowed `createSubscription`. If the grant or the profile is gone when a period is due, no charge is
  created and the subscription is flagged.
- **Test and live** follow the profile, as for every Payment.

## 8. Cancellation and refunds

- The customer cancels inside the Site. The consumer checks that the subscription belongs to the person
  asking and calls `cancelSubscription({ at: "period-end" })`. Core does not know accounts; it knows
  the consumer and the payer reference the consumer stated.
- Ending a subscription at once is a merchant action under the profile's action policy, like capture
  and refund today. It refunds nothing; a refund is the existing `refund` on the period's Payment, full
  or partial, by whoever is allowed to refund.
- A subscription that ends keeps its records. Its stored method stays until the consumer removes it or
  the payer has no other use for it; the retention rule is a structural question (section 14).

## 9. Billing documents and tax

Core records what was charged for which period, with the totals of PAYMENTS.md section 12. It issues no
document and owns no number range.

**The consumer issues and numbers the document.** The consumer already owns the order, the seller's
identity, the customer's address and the wording, and a number range is part of the merchant's
bookkeeping. A Provider-issued invoice would differ per Provider and would not exist at all for three
of the eight compared. The consumer renders its document from the period record and the Payment totals.

**Tax on a renewal** follows the pricing policy of the charge. Where the Provider declares a tax
handling for stored charges, it computes tax from the customer details observed at the first Payment;
where it declares none, the consumer states final prices and the tax it contains.

## 10. Provider interface

`PhisPaymentProviderV1` keeps its five functions. The command union gains actions, and Core sends them
only for a method whose probe declared `stored`:

| Command | Meaning | Answer |
| --- | --- | --- |
| `create` with `store: { payerReference }` | a hosted payment that also stores the method | the observation carries the stored method's binding, display and expiry once known |
| `setup` | a hosted set-up without payment | a checkout plan; the stored method is observed afterwards |
| `charge` | charge a stored method; `sequence: "scheduled" \| "unscheduled"`, amount, pricing, description | the existing execution outcomes, plus the two rejections below |
| `revoke` | remove a stored method | applied or rejected |

Two error codes are added to `PhisPaymentErrorCode`: `customer_action_required` and
`stored_method_unavailable`. The Provider's observation gains an optional stored-method part, `observe`
accepts a stored-method binding, and the notification answer gains `subject: "payment" |
"stored-method"` so Core looks the reference up in the right family. `receive({ profileKey })` is
unchanged. A Provider needs no second endpoint, secret or credential slot for this.

## 11. Events

`payment.changed` keeps its name. Its subject becomes a union: the existing payment subject, and
`{ kind: "subscription"; subscriptionId; reference; version; periodIndex: number | null }`. A renewal
therefore produces two facts: one for the Payment, one for the subscription. A handler written for
payments has to narrow on `kind` when it is rebuilt.

## 12. Authority

`PhisPaymentGrantedOperation` gains `method-read`, `method-setup`, `method-remove`,
`subscription-read`, `subscription-create`, `subscription-cancel` (at the period end, resume, settle,
replace the method) and `subscription-manage` (price change). The merchant action policies gain
`subscriptionEnd` for ending at once. Existing grants gain nothing: `cancel` and `refund` keep their
payment meaning, and an operator grants subscriptions explicitly.

## 13. Persistence

- New: `payment_stored_methods`, `payment_subscriptions`, `payment_subscription_periods`.
- Altered: `payments` (`initiator`, `stored_method_id`, `subscription_id`, `period_index`),
  the operations table (actions `setup`, `charge`, `revoke`; subject may be a stored method or a
  subscription), the notification inbox and receipts (subject kind), the event outbox (subject kind).
- Stored-method bindings are Provider data and are kept like payment bindings; no payment detail is
  stored.
- The creation script changes in place. It creates tables only where they are missing, so every existing
  database, the production Core included, gets the altered tables by hand SQL recorded in DB.md.

## 14. Open questions, each with the default this design builds on

1. **Billing documents**: issued and numbered by the consumer; Core keeps period records only. *Default:
   yes.*
2. **Price change in the first build**: effective from the next period, no proration, merchant action.
   *Default: include.*
3. **Several periods overdue after an outage**: charge the oldest open period and leave the others to
   dunning, or charge all. *Default: the oldest only, flagged.*
4. **Default dunning policy** where the consumer states none: attempts 3, 5 and 7 days after the due
   date, then `unpaid`. *Default: yes.*
5. **Stored methods outside subscriptions** (`create` with `store`, later one-click payment): the
   contract allows it; no consumer uses it yet. *Default: keep in the contract, build only what
   subscriptions need.*
6. **Retention of a stored method** after the last subscription ended: revoke automatically or keep
   until the consumer removes it. *Default: revoke automatically after 30 days.*
7. **`perPayer: "single"`**: a new stored method replaces the old one at the Provider. *Default: Core
   marks the old record `revoked` and moves the payer's subscriptions on that profile to the new one.*
8. **Start of the first period**: at capture of the first Payment, or at a date the consumer states.
   *Default: at capture.*
9. **A Provider-run schedule** as a further declared capability. *Default: not built.*

## 15. Build order: the base structure first

1. **phis-contracts**: the types of sections 4, 5, 10, 11 and 12. Types alone announce nothing.
2. **phis-server**: tables and hand SQL; stored methods; merchant-initiated Payments; subscriptions,
   periods and the scheduler job; dunning; notification and event subjects; grants and
   `phis payment profile` support; tests against a fake Provider that can decline, demand the customer,
   answer late and lose a method.
3. **The first Provider** implements `stored` for its methods; sandbox run.
4. **The first consumer, Add-on half**, then its **Module half**.
5. **Site setup** (products, prices, terms, live profile) comes last and is not part of this structure.

dev.phisys.com runs on the production Core. Steps 1 and 2 therefore reach the production Core before a
sandbox test can run there, and are deployed without any grant until the sandbox run has passed.

## 16. Sentences in existing documents that change at promotion

Nothing outside this file is edited by this design. At promotion these statements stop being true:

| Document | Where | Says today | Change |
| --- | --- | --- | --- |
| PAYMENTS.md | status and title | the one-time contract only | subscriptions and stored methods are part of it |
| PAYMENTS.md | section 1 | "Core owns payment execution records, not a product catalogue, a cart, tax calculations, invoices, inventory, fulfilment or accounting." | add: and the schedule of a subscription; it still issues no invoice |
| PAYMENTS.md | section 3 | merchant actions are capture, cancel, refund | add ending a subscription at once |
| PAYMENTS.md | section 4 | only a consumer call creates a Payment | a scheduled charge is created by Core for the owning consumer |
| PAYMENTS.md | sections 4 and 6 | capability, record, command and observation types | the additions of sections 4, 5 and 10 |
| PAYMENTS.md | section 5 | "... subscriptions, saved cards ... are outside this initial execution contract." | remove both |
| PAYMENTS.md | section 7 | `payment.changed` has a payment subject | the subject union |
| PAYMENTS.md | section 9 | the Core-owned records | add stored methods, subscriptions, periods |
| PAYMENTS.md | section 12 | "Subscriptions, saved payment methods ... remain outside this contract" | remove both; a renewal follows the same arithmetic |
| PAYMENTS_STRIPE.md | sections 1, 2, 5, 6 | subscriptions and saved cards are later deliveries; grant listing; event list; one event subject | point to the Provider's own document |
| DB.md | "Payment execution" | the payment tables | the new and altered tables, with the hand SQL |
| design/COMMERCE_AND_PAYMENTS.md | section 1 | Core must not become a billing engine | Core runs a schedule and a retry policy; it still owns no catalogue, cart or invoice |
| design/SHOP.md | sections 1, 4, 6 | the Shop sells one-time payments only | point to the Shop's subscription design |
