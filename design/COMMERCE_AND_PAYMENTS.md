# Commerce Add-ons and Payment Providers

**Status: agreed design direction, not implemented.** Recorded on 2026-10-04. This document describes
the intended separation between a small Shop, Payment Provider Add-ons and a future Medusa integration.
It does not introduce a runtime ABI, routes, database tables or a new manifest version.

[PAYMENTS.md](../PAYMENTS.md) is the approved target v1 Payment contract, including Provider
notification ingress, authority, durable operations, multi-currency execution and recovery.
Shared types exist; Core Payment execution and Provider registration remain pending.

Core already provides the Add-on lifecycle and internal Service Provider mechanism described in
[SERVER_ADDONS.md](../SERVER_ADDONS.md). The current service kinds are Media Storage, Directory and
Translation; there is no Payment service kind or Payment capability yet. The existing `@phis/shop`
package is a Core-bound Site Module, not an implemented server Shop Add-on.

## 1. Keep Core small

phis-server supplies general infrastructure. It is not intended to become a commerce engine or to
reimplement Medusa. Many Sites need only a few articles and a straightforward purchase flow, while
others need a full commerce backend. Both are supported through optional products.

Core owns identity, authorization, Site isolation, Add-on installation and activation, secret
resolution, service selection and a future provider-neutral Payment service. Product catalogues,
carts, commercial pricing rules, orders, inventory and fulfilment belong to the selected commerce
product. A Core Payment service does not imply Core Shop tables or a universal commerce workflow.

No comprehensive Core Commerce contract is introduced by this design. Such an abstraction needs a
concrete consumer and a separate design decision rather than anticipation of every Medusa feature.

## 2. Two independent commerce products

The small Shop and the Medusa integration are alternatives. A Site using Medusa does not need the
small Shop Add-on installed or enabled. An installation may serve different Sites using either
product. Each order has one authoritative commerce backend.

| Component | Responsibility |
| --- | --- |
| Core | Shared infrastructure and a minimal provider-neutral Payment boundary |
| Small Shop Add-on | Limited catalogue, cart, authoritative price calculation, orders and simple fulfilment |
| Payment Provider Add-ons | Provider APIs, SDKs, checkout execution, payment observations and refunds |
| Medusa Add-on | Bridge to a Medusa application and the associated Phis Site Modules |
| Medusa application | Its full commerce model, workflows, administration and data |

Each product follows the existing package boundary: one package may carry its Site Module half and
its server Add-on half, under one product name and version. A Module binds to exactly one Add-on or
Core. Shared UI primitives may be reused without making Medusa depend on the small Shop package.

Names such as `@phis/shop`, `@phis/stripe`, `@phis/paypal`, `@phis/mollie` and `@phis/medusa` are
illustrative here. The Shop's current Core binding would need an explicit change when its server
Add-on half is introduced.

## 3. A deliberately limited small Shop

The small Shop is a useful alternative for Sites that do not need a full commerce engine. Its initial
scope is a small catalogue of simple products, one currency per checkout, a cart, guest purchases, simple
shipping rules, order administration and refunds. It remains an optional Add-on with its own data.

Products may carry independent prices in CHF, EUR, USD or another supported currency. The Shop selects
the purchasing currency, validates that every item has a price in it and calculates the agreed total
on the server. Its own price lists and any conversion do not become Core Payment responsibilities.

Its order records retain the commercial facts agreed at checkout: item descriptions, quantities,
prices, tax and shipping amounts, currency and the relevant payment references. Prices and totals are
calculated on the server. A browser supplies product choices, not authoritative amounts.

Payment and fulfilment have separate states. An order may have several payment attempts, while
delivery or access is granted once. Even a small catalogue needs repeatable checkout creation,
reliable payment confirmation and a consistent refund path.

Complex variants, promotions, warehouse management, multi-region pricing and advanced fulfilment
are reasons to select Medusa rather than to keep growing Core or the small Shop towards Medusa.
Product count alone does not determine that choice.

## 4. Payment Providers are Add-ons

Stripe, PayPal, Mollie and other payment integrations each implement a Core-owned Payment service
kind through the existing Service Provider mechanism. Their manifests declare the provider identity,
interface digest and factory; normal installation, compatibility and Site activation checks apply.

The intended call path is:

```text
Shop Add-on -> Core Payment capability -> selected Payment Provider Add-on -> external provider
```

The Shop does not import another Add-on's runtime or resolve its factory itself. Core mediates the
call and selects the provider using a Site-scoped merchant profile. Provider SDKs, endpoints and
provider-specific interpretation stay in their Add-on. Core holds only the payment references and
lifecycle information needed for its general Payment service, not the Shop's commercial records.

A provider and a payment method are different things. Stripe or Mollie may offer cards, PayPal and
other methods through one integration. A Site may also configure separate providers. Available
methods are derived from the configured merchant profile and the provider's actual capabilities.

Merchant credentials are configured per Site and remain server-only under the existing secret
boundary. The initial model uses each merchant's own provider account, with payments going to that
merchant. Central platform onboarding, commissions and split payouts are a separate future scope.

The initial Payment boundary should cover available methods, starting a payment attempt, observing
its status and refunds including partial refunds. Authorization, later capture and cancellation need
explicit operation capabilities so consumers do not assume every provider supports every flow.
Exact method names, types, persistence and capability ids remain to be designed.

Checkout is represented as a typed plan: initially a hosted checkout URL, with room for provider-owned
embedded fields or approval steps. Card details are collected by the payment provider. The same
Payment service may later serve bookings, services or paid features independently of either Shop.

## 5. Provider events and authority

Returning from checkout is not proof of payment. The authoritative result comes from a verified
provider event or an authenticated provider status query. Events can arrive late, repeatedly or out
of order. Payment creation, state changes, refunds and fulfilment triggers require idempotency and
durable references. A delivery must not be considered processed merely because its id was observed
before the actual state change succeeded.

External requests use the existing Site hook proxy and Add-on hook namespace. Site identity comes
from the Site runtime's configuration; external hooks do not acquire the internal token. Core mediates
write authority rather than allowing a Provider to access another Add-on's tables directly.

The present hook verifier supports HMAC-SHA256 over the raw body only. Stripe's timestamped signature,
PayPal's verification flow and payment-status retrieval for classic Mollie hooks need an explicit
extension of the verification and authorized event-processing contract. SDK installation alone does
not make these flows compatible with the current contract. Generic HMAC must not be treated as if it
already verified these different schemes.

## 6. Medusa is a separate backend behind a Bridge Add-on

The Medusa Add-on is the integration package. The Medusa application runs as a separate backend with
its own deployment, database, workers and administration. Installing the Bridge does not embed or
start a Medusa application inside a phis request handler or Service Provider factory.

The Bridge uses Medusa's Store and Admin APIs, directly or through its JavaScript SDK. It owns the
connection configuration, authorization of Phis-facing operations, stable external bindings and
event exchange. Medusa remains authoritative for its products, prices, inventory, carts, orders,
fulfilment and commerce workflows. Any Phis projection is a scoped view with an external identity,
not a second writable copy of those business records.

The associated Site Modules can provide product, variant, category, cart and checkout widgets,
customer and order views, and access to administration. Phis identities and Medusa customers need an
explicit account-binding design; a Phis session does not automatically establish a Medusa session.
Medusa Admin can initially remain the administration surface rather than rebuilding its features in
Phis. Deeper administration integration can follow as needed.

Full integration must preserve access to Medusa-specific capabilities. Its API and Modules are not
restricted to the small Shop's feature set. Common presentation components can be shared while each
product retains its own server binding and richer operations.

## 7. Medusa payment ownership

There are two possible payment paths:

```text
Small Shop -> Core Payment service -> Stripe / PayPal / Mollie Add-on

Medusa Bridge -> Medusa commerce workflows -> Medusa Payment Provider
```

The initial Medusa integration lets Medusa lead its payment workflow using its own Payment Providers.
Phis receives the relevant results through the Bridge. It does not independently charge or refund the
same order through a second payment workflow.

A later Medusa-side Payment Provider adapter may delegate payment execution to an authenticated Phis
Payment interface, reusing the installed Phis Payment Provider Add-ons. The adapter translates
Medusa's payment lifecycle into the Phis contract; a Phis Bridge Add-on alone does not implement that
Medusa-side adapter. Medusa still leads its order workflow, with a single defined payment execution
path and explicit event routing.

Provider-neutral payment interfaces should account for authorization, capture, cancellation and
partial refunds from the outset. This prepares for Medusa without requiring Medusa, its dependencies
or its full commerce model on small-shop Sites.

## 8. Implementation sequence and unresolved contracts

1. Define the minimal Core Payment service kind, provider interface, consumer capability and merchant
   profile boundary in `@phis/contracts`, with provider loading owned by Core.
2. Define provider verification, event processing and failure/retry behaviour, including the authority
   for updating payment records and notifying a consuming Add-on.
3. Implement one Provider Add-on and the small Shop product as a complete first consumer. Stripe is
   the initial candidate; additional providers are independent additions.
4. Implement the optional Medusa Bridge and Site Modules against a separately deployed Medusa backend,
   using Medusa's native payment workflow first.
5. Add the Medusa-side adapter for shared Phis payment execution only when that integration is needed.

Guest checkout authority, order-access tokens, profile and secret resolution, normalized payment
states, event delivery, account binding, data migration between commerce backends and the scope of
administration integration need concrete designs before implementation. Selecting Medusa does not
automatically migrate small-Shop orders or promise transparent backend interchangeability.

No additional in-process scheduler, arbitrary cross-Add-on imports, shared Shop/Medusa tables or
comprehensive Core Commerce engine are introduced by this direction. Settled implementation contracts
will move into their owning root documents and typed interfaces when built.

## References

- [Server Add-on contract](../SERVER_ADDONS.md)
- [Authentication and account linking](../AUTHENTICATION.md)
- [Authorization](../AUTHORIZATION.md)
- [Medusa Store API](https://docs.medusajs.com/api/store)
- [Medusa Admin API](https://docs.medusajs.com/api/admin)
- [Medusa deployment](https://docs.medusajs.com/learn/deployment/general)
- [Medusa Payment Provider integration](https://docs.medusajs.com/resources/integrations/guides/paypal)
- [Stripe webhook verification](https://docs.stripe.com/webhooks)
- [PayPal webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/)
- [Mollie classic webhooks](https://docs.mollie.com/reference/webhooks)
