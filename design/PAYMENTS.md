# Payment Service and Capabilities

**Status: approved and promoted to a normative v1 contract on 2026-10-04.**

The owning contract is now [PAYMENTS.md](../PAYMENTS.md), with first-provider and administrative
requirements in [PAYMENTS_STRIPE.md](../PAYMENTS_STRIPE.md). Shared types are implemented in
`@phis/contracts/payments` and re-exported by `@phis/contracts/addon`. Core Payment execution,
Provider registration, merchant administration, notification handling and owner-directed event delivery
are implemented in the workspace. Runtime deployment and real webhook verification are tracked
separately; type exports alone never announce availability.

The general commerce direction remains in [COMMERCE_AND_PAYMENTS.md](./COMMERCE_AND_PAYMENTS.md).
Approved implementation work is tracked in [TODOS.md](../TODOS.md#payments). This file retains the
original design address; it does not maintain a second copy of the contract.
