# Payment integration probe

This installable test consumer owns one agreed base amount per pricing policy and one durable
fulfilment row per Payment. The checkout body's `policy` selects it: `fixed` (CHF 19.90, v1), `net`
and `gross` (two CHF 10.00 widgets, CHF 5.00 shipping, a stated CHF 5.00 discount, Stripe Tax on top
of or inside the price) or `code` (no stated discount, the customer may enter a promotion code). It is a test fixture, not a Shop implementation. Its manifest uses only approved Core
Payment/data capabilities, a declarative schema/query catalog and `payment.changed`. It receives no
credentials, SQL connection or direct Provider access. Its Checkout, read and refund HTTP routes all
require an authenticated operator. The `drain` job lets the existing operator retry path deliver owed
events.

Since 0.3.0 it also declares one asked-for occasion, `payment-captured`, and requires
`@phis/server/notifications:v1` and `@phis/server/settings:v1`: when the setting `notify-contact` holds
an address, a captured payment is confirmed to it as a contact recipient (no account, locale `en`),
deduplicated by payment id, and the `notify` job sends the same occasion without a payment so the mail
path of a stage can be verified from the CLI. Unset, nothing is sent.

Build with the workspace toolchain:

```bash
pnpm exec esbuild fixtures/payment-probe/addon.ts --bundle --platform=node --format=esm --target=node24 --outfile=/opt/projects/artifacts/phis-payment-probe-0.3.0.mjs
```

Install/reconcile/migrate and activate the artifact using the target installation's CLI. For the test,
the Site-local `stripe-sandbox` profile grants `@phis/payment-probe` only `read`, `create` and `refund`;
merchant policy role/job/event lists are empty so financial administration still requires an operator
or Site Admin. It has no completion or refresh grant, which keeps the browser return from acting as
the settlement path. The fixture's primary key prevents duplicate durable fulfilment; a conflicting
insert fails delivery and its eventual retry observes the existing row.

On 2026-10-04, a separate compiled test installation settled a genuine test Checkout through the
public Stripe hook, delivered its owner events and stored one fulfilment. Three concurrent re-signed
copies of one actual Stripe event were acknowledged as duplicates without changing Payment version
or fulfilment count. A full refund and identical retry reused their Core identities. Genuine events
delayed by concurrent reservations processed when re-signed and replayed, leaving no pending Core
receipts or consumer events. All test purchases were fully refunded. The temporary operator was
deleted, the consumer disabled and its profile grant removed; financial and fulfilment evidence was
retained. The detailed sanitized report is
`/opt/projects/artifacts/phis-payment-settlement-test-20261004.json`.
