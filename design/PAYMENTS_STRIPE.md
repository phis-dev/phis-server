# First Payment Implementation: Stripe Hosted Checkout

**Status: contract approved and promoted on 2026-10-04; Core and Provider implemented.**

The owning first-provider and administrative contract is [PAYMENTS_STRIPE.md](../PAYMENTS_STRIPE.md).
The shared execution contract is [PAYMENTS.md](../PAYMENTS.md). Follow [TODOS.md](../TODOS.md#payments)
for Core persistence, profile/grant administration, notification inbox, owner-directed events and
Stripe Provider delivery.

The first executable verification is a minimal test consumer with a real Stripe test-mode checkout,
manual authorization/capture, partial refunds and failure/retry checks. The small Shop follows that
verification. Additional Providers and the independent Medusa Bridge remain separate packages.

A real test-mode Core/Stripe checkout, partial refund, idempotent refund retry and remaining refund
passed using isolated fixtures. The public Site webhook and installable consumer fulfilment remain
to be verified. No live merchant setup or compiled Site deployment is implied by this work. This file retains the original design address without a second contract copy.
