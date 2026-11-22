# Small Shop: Planned Design

**Status: Add-on half built, Module half not.** `@phis/shop` 0.2.0 carries the Add-on half designed
below (`src/addon/`): the schema and query catalog of section 4, the destination pricing of section 5,
the checkout, order lifecycle, cancellation and refunds of section 6, the `order-paid` occasion of
section 7 through `@phis/server/notifications:v1`, the roles and settings of section 9, and the
`orders.expire` job; the Module's binding moved from Core to the Add-on. Not built: everything of
section 8 -- the storefront pages, the Providers, the Forms, the checkout machine and the management
surface -- and product pictures in the public catalogue answer. The Add-on is installed on the dev
stage with a grant on `stripe-sandbox`; no sandbox checkout has been run through it yet, because that
needs a manager to create a destination and a product first. The Core Payment service it consumes is
normative in [PAYMENTS.md](../PAYMENTS.md); the direction is
[COMMERCE_AND_PAYMENTS.md](./COMMERCE_AND_PAYMENTS.md) sections 2 and 3; the Add-on contract every rule
below is read against is [SERVER_ADDONS.md](../SERVER_ADDONS.md).

## 1. What it is, and what it is not

The small Shop sells a limited catalogue of simple products from a Site that does not want a commerce
engine: a product with a description, pictures, one price per currency and one tax category; a cart in
the browser; guest checkout with an address; a hosted payment through the Core Payment service; an
order with its agreed facts; simple shipping rules; order administration, cancellation and refunds.

It is one Add-on, not three. Catalogue, cart and orders stay together because the price a customer
agrees to is computed from all of them at once, and because an Add-on reaches another only through a
Core capability -- a separate cart Add-on would need a Core "cart" service with exactly one
implementation. Payment is the part that stays apart, and it already is: the Shop is a consumer of
`@phis/server/payments:v1`, never of a Provider.

It is also not Medusa. Variants, bundles, warehouse stock, multi-region price lists, customer groups and
advanced fulfilment are reasons to choose the Medusa Bridge instead (COMMERCE_AND_PAYMENTS.md section 6).
What the two share is the presentation: Widgets and item renderers of the Module half that draw a
product, a cart or an order without knowing which backend answered (section 8).

## 2. One package, two halves

`@phis/shop` keeps its name and gains an Add-on half under the `addon/` prefix, as SERVER_ADDONS.md
section 3 prescribes:

```text
@phis/shop                   Module half: ".", "./server", "./client", "./authoring-client"
@phis/shop/addon/manifest    Add-on half, inspectable without starting anything
@phis/shop/addon/runtime     Add-on half, bundled into the installed artifact
```

The Module's server binding changes from Core to the Add-on id `@phis/shop`, with no required
capabilities of its own -- the explicit change COMMERCE_AND_PAYMENTS.md section 2 reserved. The manifest
lists the Module under `modules`, so enabling the Add-on on a Site can tell the Site has the surface. The
Module id becomes `@phis/shop/modules/shop`, the form every other two-half package uses.

```text
Package:             @phis/shop
Site Module:         @phis/shop/modules/shop
Server binding:      @phis/shop
Add-on entrypoints:  @phis/shop/addon/manifest, @phis/shop/addon/runtime
Core requirements:   @phis/server/payments:v1, data:v1, assets:v1, settings:v1, roles:v1, authorization:v1
Provided capability: none
```

The Add-on provides no capability. Nothing else on a Site needs to call the Shop; whoever needs to charge
for something calls the Payment service itself with its own line items.

## 3. Four callers, four doors

Every decision about routes, tables and queries follows from who is asking. The Add-on dispatcher knows
four authentication policies (`internal`, `site-user`, `site-admin`, `operator`) and one unauthenticated
door (a hook); it does not know a customer without an account. The Shop therefore does not get a
"guest" actor from Core. It gets a transport and builds the rest itself, which PAYMENTS.md section 3
already assumes: "a guest's opaque order-access token is checked by the Shop".

| Who | Door | Actor Core sees | May, through `data:v1` |
| --- | --- | --- | --- |
| Anybody reading the catalogue | hook, `siteScoped`, rate-limited `public-read` | none | read |
| A guest buying | API route `auth: "internal"`, reached through the Site's `/api/addons` door | `internal`, no user | insert and read; never update or delete |
| A customer with an account | API route `auth: "site-user"` | the user | insert and read; their own rows through the owner column |
| Somebody running the shop | API route `auth: "site-user"` plus a declared role | the user, with a role | role-guarded writes |
| Core telling the Shop (`payment.changed`) or a job the operator runs | event or job | none, with system authority | everything the declarations allow |

Three consequences, each the reason for a table shape in section 4:

- **The cart is the browser's.** An internal caller cannot update a row, so a server-side cart would be
  a row that is written once and then replaced on every change. The Basket widget already keeps a count
  in the browser; it keeps the product choices there too (local storage, keyed by Site), and the server
  meets the cart for the first time at checkout, where it prices it from the catalogue. "A browser
  supplies product choices, not authoritative amounts" is already the rule.
- **An order is inserted once and changed only by authority.** The guest inserts it and never touches it
  again. Everything that happens to it afterwards is done by the `payment.changed` handler with system
  authority, or by a person with a role. There is no path on which an anonymous caller changes an order,
  which is a property of the doors rather than a check in a handler.
- **An order is reached by a token, or by its owner.** The checkout answer carries an opaque order-access
  token, generated by the Add-on, whose hash is stored in the order row. The guest's reads present it in
  a header and the declared query compares the hash. A customer with an account gets the same row with
  `owner_user_id` written by Core, and reads it through a query bounded to `{ kind: "actor" }`. One table,
  two ways in, and a guest order whose owner is nobody is exactly the row the ladder says "belongs to
  nobody".

The Site's `/api/addons` proxy forwards the session cookie and attaches the internal token; the
`/api/hooks` proxy attaches nothing. A Site that mounts the Shop needs both doors, which the skeleton has.

## 4. Data

All tables are `siteScoped`. None is `groupScoped`: nothing in a small shop is shared at different
depths, and a group would admit a customer to everybody's rows. `orders` is `ownerScoped` for the one
reason above, and `order_lines` with it. There are no joins in the query vocabulary, so every row carries what a
page about it needs.

| Table | Scope | Holds |
| --- | --- | --- |
| `products` | site | `slug` (unique in the Site), `title`, `description`, `status` (`draft`, `published`, `retired`), `tax_category` (the closed vocabulary of PAYMENTS.md section 12), `prices` (JSON: minor units per currency), `stock` (integer, nullable: null means untracked), `sort_order`; asset slots `image` (`many`, public delivery) |
| `destinations` | site | a shipping zone and its pricing policy: `countries` (JSON list of ISO codes, `*` for the rest of the world), `currency`, `profile_key` (the merchant profile that serves this zone), `basis`, `tax` (the policy pair of section 5), `shipping_minor`, `free_shipping_from_minor` (nullable), `import_charges_by_carrier` (boolean), `enabled` |
| `promotions` | site | `code` (unique in the Site), `label`, `kind` (`percent` or `fixed`), `value`, `currency` (for `fixed`), `valid_from`, `valid_until`, `max_uses`, `uses`, `enabled` |
| `orders` | site, owner | `number` (the customer-facing order number, unique in the Site), `status`, `fulfilment`, `currency`, `destination_id`, `country`, `address` (JSON), `email`, `shipping_minor`, `discounts` (JSON: the stated discounts with their promotion codes), `base_minor`, `totals` (JSON, the payment's `totals` verbatim once bound, else null), `seller_of_record` (`merchant` or `provider`), `import_charges_by_carrier`, `access_token_hash`, `attention` (nullable text: why a person must look), `flags` (bits of what was done once and of what the order holds: `PromotionsCounted`, `PaidAfterClosingNoted`, `EntitlementsGranted`, `StockHeld`), `placed_at`, `hold_until` (nullable: the end of the hold, the payment's `expiresAt`, written when it is placed holding units), `paid_at`, `fulfilled_at`, `canceled_at` |
| `order_lines` | site, owner | one row per agreed line, written with its order in one transaction: `order_id` (cascade), `position`, `listing_id` (nullable, `setNull`: a deleted listing leaves the line), `product_id` (the Core product the entitlement names), `reference` (the listing's address when bought), `title`, `kind`, `tax_category`, `quantity`, `unit_minor`, `line_minor` (before the order's discounts), `currency`, `refunded_quantity` (default 0), `held_quantity` (default 0, at most `quantity`: the units taken for the line when the order was placed, 0 again once released or paid), `placed_at`, `paid_at`, `paid_on` (`YYYY-MM-DD` in the Site's time zone; declared, not written until Core hands an Add-on the zone) |
| `payment_attempts` | site | `order_id` (reference to `orders`, cascade), `payment_id`, `attempt` (the idempotency suffix), `status` (the payment status last seen), `created_at` |
| `refunds` | site | `order_id`, `refund_id`, `minor`, `reason`, `status`, `requested_by` (a `core.user` reference, `setNull`) |

The lines were a JSON list on the order until 2026-11-22: nothing read them without their order, but Core can
neither filter nor sum over a document, so "how often was this sold" could not be asked. They are rows of their
own now, with no copy on the order; `order_lines_sold_by_listing` counts the paid units less those given back per
listing, grouped by the nullable `listing_id` with its nulls left out. A subscription sells periods instead: it
names the listing it was bought from (`subscriptions.listing_id`), each billing document of a paid period copies it
(`subscription_documents.listing_id`, with `paid_on` declared beside it and not written either), and
`documents_sold_by_listing` counts the paid periods per listing -- gross, a document knowing no refund.

What is deliberately not here: a cart table (section 3), customer records (a customer is a Site
user or an address on an order), tax rates (the Provider computes them; the Shop keeps the result), and
anything that looks like a ledger.

Constraints go into the first version of the descriptor: `status`, `fulfilment`, `kind`, `basis` and
`tax` are enumerations; minors are non-negative; `valid_until` is not before `valid_from`.

### Queries, and who may run which

- Public reads (`products.published`, `products.bySlug`, `destinations.forCountry`) have no role and run
  on the hook. `products.bySlug` is also what the Module's record Provider calls on the server, so a
  product page can answer its title and its 404 before anything is drawn.
- Guest and customer inserts (`orders.place`, `order_lines.place`, `payment_attempts.record`) have no role.
  Guest reads (`orders.byToken`) compare the hash; customer reads (`orders.mine`, and the lines of a page of
  them) are bounded to the actor. One order's lines are read by its id once the token, the owner or a role
  opened the order; every order's lines, and the count of what was sold, are a clerk's.
- Every `update` on `orders`, `products`, `destinations` and `promotions` declares `requiresRole`. These
  tables carry no owner or group authority except `orders`, so the role is the whole of the authority,
  which the manifest validation already demands of such tables. On `orders` the role sits in
  `alsoAllowedByRole`, so the ladder answers the owner first and the role stands in for everybody else --
  though no customer-facing route offers an update, so in practice the role is what is used.
- The `payment.changed` handler runs the same role-guarded updates with system authority, which answers
  `hasRole` with yes. That is the mechanism by which a payment can change an order and a guest cannot.
- What a guest or a customer sets off and only the Add-on may write -- the units and the code's use an order
  holds, and their release -- are guarded updates under the Add-on's own authority (`authority: "addon"`), each
  doing its one thing once; `phis addon check` lists them.

Two roles, declared in the manifest:

```ts
roles: [
  { name: "manager", description: "Runs the shop: catalogue, destinations, promotions, refunds.", grantableBy: { siteAccess: "site-admin" } },
  { name: "clerk",   description: "Sees and fulfils orders.",                                       grantableBy: { role: "manager" } },
]
```

A `clerk` updates `fulfilment`; a `manager` does everything a clerk does and also changes the catalogue,
the destinations and the promotions, cancels an order and asks for a refund. The Payment service's own
merchant-action policy names `manager` for `cancel` and `refund`, so Core enforces the same line
independently of the Shop's routes.

## 5. Pricing: the destination decides

The customer's country is known before any price is final, and everything that depends on the country
hangs on one row: the destination. A destination names which countries it covers, the currency it sells
in, the merchant profile that takes the money, how tax is handled, and what shipping costs. This is the
"country to profile" rule asked for in the conversation that led here, and it is Shop configuration, not
Core's: Core sees a `profileKey` per payment and nothing about countries.

| Destination says | Policy the Shop states | Who computes tax | Typical use |
| --- | --- | --- | --- |
| `basis: final`, `tax: provider` | gross prices, Provider reports the included tax | Provider | domestic sales with gross listing |
| `basis: net`, `tax: provider` | net prices, Provider adds tax on top | Provider | domestic or EU sales with net listing, B2B |
| `basis: net`, `tax: merchant-of-record` | the Provider is the seller of record | Provider, and owes it | international digital sales through Paddle, Polar or Stripe Managed Payments |
| `basis: final`, `tax: none` | the amount is what the customer pays | nobody | export of goods whose import charges the carrier collects (`import_charges_by_carrier`), or a Site without a tax engine |

Two choices a Site makes once, as settings: `listing` (`gross` or `net`) says whether catalogue prices
are shown with or without tax, and `currency` is the fallback when no destination is chosen yet. A
product's `prices` must contain the destination's currency, or the product is not purchasable there;
the checkout says so rather than converting.

The price a product shows before an address is known is the Site's listing for the fallback currency.
Under `gross` listing the shown price is the agreed unit price and the destination must use
`basis: final`; under `net` listing the checkout adds "plus VAT, computed at payment" and the
destination uses `basis: net`. A destination whose basis contradicts the Site's listing is refused when
it is saved, not discovered by a customer.

Shipping is one fixed amount per destination, free above a threshold, stated to Core as the policy's
shipping line with its own tax category. Two parcels, weight classes and carrier rates are Medusa's.

### Promotions

A promotion code is the Shop's: the customer enters it in the Shop's checkout, the Shop validates it
against `promotions`, computes the reduction and states it to Core as a **stated discount** with the
code as its reference. The base amount is therefore known before the hosted page opens and is the same
under every Provider, and the order keeps the discount with its code. Provider-side promotion codes
(`promotionCodes: "provider"`) stay off: the Shop would not know its own total until the Provider
reported it. Percent promotions are applied to the lines, never to shipping; `uses` is counted when the
order is paid, by the event handler. Gift cards and store credit are not offered.

## 6. Checkout and the life of an order

```text
browser cart -> address -> destination -> priced order -> payment created -> hosted page -> return -> event -> paid
```

1. **Address.** The checkout form collects email, name, the shipping address and optionally a billing
   address and a tax id. The country is required first because everything after it depends on it.
2. **Destination.** The Shop picks the enabled destination covering the country, or tells the customer
   it does not ship there. The destination fixes currency, profile, policy and shipping.
3. **Price.** The Shop reads every product in the cart from the catalogue, refuses an unpublished one or
   one without a price in the currency, applies the promotion code, adds shipping and arrives at the
   base amount. Under `net` listing the page says the tax comes at payment.
4. **Place.** One internal route inserts the order (`awaiting_payment`, with the base amount, the
   destination's facts and the token hash) and its agreed lines (`order_lines`) in one transaction, then
   calls `payments.create` with
   `reference = order number`, `idempotencyKey = order number + attempt`, the policy from the
   destination, the lines with their tax categories, the shipping line, the stated discounts,
   `customer` (country, postal code, `addressSource: "shipping"`, tax ids) and a `returnPath` on the
   Shop's order page, then inserts the `payment_attempts` row. The answer to the browser is the order
   number, the access token and the checkout plan. The browser sends an `attempt` id of its own, so a
   repeated submit reaches the same payment through Core's idempotency rather than creating a second.
5. **Hosted page.** The checkout plan is a redirect today; a `provider-ui` plan would mount the
   Provider's Module, which the Shop passes through without interpreting.
6. **Return.** The order page is the return address. It calls the Shop's `complete` route (internal,
   token-checked), which calls `payments.complete` and shows the payment's current status -- "paid",
   "being confirmed" or "not completed, try again". A return is not proof; the page says so and polls.
7. **Event.** `payment.changed` reaches the Shop for payments it owns. The handler reads the payment,
   finds the order by reference, and applies the idempotent transition below. If the `payment_attempts`
   row is missing because step 4 died between the create and the insert, the handler inserts it: the
   reference is the order number, so nothing is lost.

| Payment status | Order status | Also |
| --- | --- | --- |
| `captured` | `paid` | in one transaction and once (only an order still `awaiting_payment` is marked): copies `totals` verbatim, sets `seller_of_record` from the tax addition's `collectedBy`, ends the order's hold (bit `StockHeld` of `orders.flags`: the units it holds since it was placed are its own, nothing more is taken) or -- for an order that holds none, its hold given back before or placed before holds -- takes the quantity from tracked stock, from the listing each line was bought from (`listing_id`, not its address), and counts the promotion use where placing did not (once per order, bit `PromotionsCounted`), sets `paid_at` on the order and on each of its lines; a shortfall in stock or a `totals.customer.country` that is not the order's country sets `attention` instead of undoing anything, because the money is already taken. After that transaction, never before, the entitlements are written and bit `EntitlementsGranted` set, only while the order is still paid (what was written for an order canceled or refunded meanwhile is taken back); a delivery whose writing throws is delivered again and writes them then for the order paid without the bit |
| `authorized` | `paid` with `attention` | manual capture is not a Shop flow; a person captures, or releases the authorization from the Orders page (`manage/orders/:number/release`, `payments.cancel`), which cancels the order it paid |
| `failed`, `expired`, `canceled` | stays `awaiting_payment` | what the order holds -- its units, its code's use -- is given back in one transaction and once; the customer may try again from the order page, which creates a new attempt that holds nothing; a Site job (`orders.expire`) moves orders nobody paid after a configured number of days to `abandoned`, all of them page by page along the cursor up to 5,000 a run, each only while it is still `awaiting_payment` so an order paid meanwhile is not overwritten |
| `captured` or `authorized` on an order already `canceled` or `abandoned` (never paid) | stays | `attention` says the payment came in after the order was closed and to refund it or fulfil the order; once, by bit `PaidAfterClosingNoted` of `orders.flags`, also where the order was closed between reading it and marking it paid. Once that payment holds no money any more (refunded in full, authorization canceled) the sentence is taken off and the bit cleared |
| refund observed | `refunded` or `partially_refunded` | from `refundedMinor` against the total; `refunded` gives every unit of the lines back (`refunded_quantity`) in the same transaction, a refund in part none, being an amount that names no line |

`fulfilment` is a second axis (`pending`, `shipped`, `delivered`, `granted`, `not_required`) and a
person's act: a clerk marks an order shipped from the management surface. Nothing in the Shop ships or
grants access on a payment event by itself, because "the event is not a command to ship" and a digital
good needs a delivery path that does not exist yet (section 10).

**Cancellation and refunds** are a manager's act through routes that require the role: cancel an unpaid
order (no payment call needed; a pending attempt is left to expire; what it holds is given back with the
cancellation), cancel a paid order with a full refund -- an authorization nobody captured is released
(`payments.cancel`) rather than left standing, whatever the order's status -- or refund part of an order with a reason -- of any order whose payment was captured and is not
refunded in full, a canceled or abandoned one a payment came in for after all among them; its status stays
(a canceled order refunded in full is still `canceled`), and an order still `awaiting_payment` or without
captured money is refused. A paid order canceled gives every unit of its lines back with the cancellation.
Each refund is one `payments.refund` with the
order's refund row inserted first and its id recorded after, so a refund that was issued and not
recorded is found again through the payment's refunds rather than issued twice. Refunds are against
captured money, which includes tax, as PAYMENTS.md section 12 says; the Shop shows the refund's
`additions` where the Provider reports them and derives nothing from them.

**Stock** is what is free to sell, and an order holds what it takes. Placing an order takes the units of its
counted lines from the listings, and the use of its promotion code, in the transaction that writes the order and
its lines, each only while there is enough (`add` beside a `where`, SERVER_ADDONS.md) and under the Add-on's own
authority (`authority: "addon"`), since a guest or a customer places it: of two buyers of the last unit or use one
gets the order and the other `out_of_stock` (with `product`, the line's title, beside the code) or
`promotion_unavailable`, with nothing written. Each line records what was taken for it (`held_quantity`), so what
goes back is what was taken, whatever the listing's counting did since. The order holds them for the setting
`stock-hold-minutes` (default 60, 32 to 1440, read and checked when the order is placed and only then, never moved
into range), until `hold_until`, written on the order, and its checkout ends then too (`payments.create` with that
instant as `expiresAt`, by a method whose `checkoutExpiry` keeps it; none, and the order is refused before anything
is written). Paid, the hold ends and the units are the order's; what a line did not hold is taken then. Given up,
each line's held units go back once, to a listing still counted, in one unit of work with what ends the order's
wait: its payment failed, expired or was canceled, a manager canceled it, `orders.expire` abandoned it, its payment
could not be created, or the job `orders.release-holds` (every 15 minutes) found its `hold_until` 5 minutes past
with no payment in progress -- a payment confirmed later (`processing`) keeps the units. A payment that comes after
the release takes its units at payment, as every order did before, and a shortfall then wears `attention`.
phis-shop README.md, "An order's hold".

Stock is never written as a number read earlier, only added to by the database on the row it changes: a clerk
adds or takes a delta, starts counting a shipped listing not counted (`where stock IS NULL`) or stops counting
one (`POST manage/listings/stock`, one act per request); editing a listing does not touch it. Every write of the
paid transition -- the order marked, the hold ended or the stock taken, the code counted -- is one unit of work, so
an event delivered again after a failure part way does none of it twice.

## 7. The order page is the receipt

The order page, reached by the token link or from the customer's account, shows the agreed lines, the
discounts with their codes, shipping, the tax additions as the Provider reported them (rate,
jurisdiction, inclusive or exclusive) and the total -- all read from the order row and its lines, never
recomputed.
When the tax was collected by the Provider as seller of record, the page says so and names the Provider,
which is the receipt wording PAYMENTS.md section 12 asks of a consumer. An export order says that
import charges are collected by the carrier on delivery.

The confirmation mail is an occasion the Shop declares -- `order-paid`, with the order number and the
path of the order page as parameters -- and asks Core to send through `@phis/server/notifications:v1`
from the `payment.changed` handler, with the order number as the dedupe key so a redelivered event writes
no second mail. A guest is a **contact** recipient: the address from the order and the locale of the
checkout page; a customer with an account is a **user** recipient and Core resolves the address. Core
writes the salutation, the frame and the sender; the Shop's words are in its manifest. A PDF invoice is
out of scope; the order page prints.

## 8. The Module half

The Module contributes to the Public and App Areas what a visitor and a customer use, and to the
Accounting Area what a manager uses. Addresses in Public follow the collision rules of
[PUBLIC_ADDRESSES.md](./PUBLIC_ADDRESSES.md); the defaults are:

```text
/shop/products          catalogue (Public); `/shop` is a folder and leads nowhere
/shop/products/<slug>   product page, bound to the product record Provider (Public)
/shop/categories/<slug> one category's products (Public)
/shop/cart              the cart (Public)
/shop/checkout          address, destination, promotion code, summary, "pay" (Public)
/shop/order/<number>    order page, token in the link (Public)
/phis/shop/orders       a customer's orders (App)
/phis/shop/cart         the cart once more (App)
/phis/shop/checkout     the checkout for the signed-in customer (App)
/phis/shop/order/<number>  order page, read as the customer's own, no token (App)
/phis/shop              catalogue, destinations, promotions, orders, refunds (Accounting)
```

A Page is never a folder (REFERENCES.md, "A Page is never a folder"): the catalogue stands beside the cart,
checkout and order Pages rather than above them, its products directly beneath it as a list's entries. The
header's "Shop" entry is a link to the catalogue, so `/shop` answers 404.

Cart, checkout and order page exist in both Areas so that a purchase is finished where it began: a
customer who opens the Basket in the App is not sent out of it to pay. An order remembers the Area it
was placed in (`orders.area`, `public` or `app`), because the links to its page are made long after the
request that placed it -- the payment's `returnPath`, a retry, the confirmation mail -- and each of them
leads to the page in that Area. Only an account's order can be an App order: the App's order page reads
the order as the caller's own (`account/orders/<number>` and its `complete` and `retry`), so no token
stands in an App address, and a guest, who has only the token, has no way into the App.

Providers and Forms, in the vocabulary of [phis-ui MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/MODULES.md):

- a `collection` Provider `@phis/shop/products` with resources `published` (through the hook) and
  `managed` (through the role-guarded route);
- a `record` Provider `@phis/shop/product`, read on the server by slug, which is what makes the product
  page's title, description and 404 right before render;
- a `client` Provider `@phis/shop/cart` that owns the browser cart and emits the count the Basket widget
  shows;
- Forms `checkout`, `product`, `destination`, `promotion`, `refund`, each with record-oriented
  validation and a submit that reaches one Add-on route;
- Widgets: the existing Basket, a product card renderer, a product list, a product detail, a cart, a
  checkout summary, an order summary, and the management tables built on the generic Table Widget.

**Two state machines, both declared, neither invented here.** The checkout (address, destination,
summary, pay, return) is a flow with a named current state, and
[phis-ui design/STATE_MACHINES.md](https://github.com/phis-dev/phis-ui/blob/main/design/STATE_MACHINES.md) already lists "checkout and
payment" as a candidate under composed authority: the Shop Module declares the `checkout` machine and its
Controller hosts a `PhiStateMachineBinding`, with the stages as Forms placed side by side. The order page
hosts a second, `server`-authority projection whose reader is the order-status route -- `awaiting_payment`,
`paid`, `attention` -- the way the Auth Controller reads the authentication workflow. A step counter or a
phase string in a Widget is not an allowed substitute, which that design says in as many words. The Shop
is thereby the second Module to declare a machine, and the first with composed authority; where the
binding or the diagnostics fall short of it, the Foundation is extended first (the generalization gate in
[phis-ui MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/MODULES.md)), not worked around in the Shop.

On the server there is no machine to host. The order's `status` and `fulfilment` are columns under an
enumeration constraint, and the transitions of section 6 are a small table in the Add-on that the event
handler and the role-guarded routes consult before every update -- the same shape the Payment engine
uses for its own statuses. Core offers no server-side state-machine facility, and this design does not
ask for one.

**The storefront interface is the item shapes, not the Providers.** A product item, a cart line, an order
summary are declared once as renderer contracts in the Module half. The Medusa Bridge's Modules supply
their own Providers (Medusa's products, Medusa's cart) that answer in those shapes, and reuse the Widgets.
Nothing in a Widget names the Shop Add-on; the Provider binding is chosen where the Widget is placed,
which is already how a Collection is bound. A Site runs one or the other; the Widgets do not care which.

## 9. Operator setup

The Add-on half is installed and enabled with the Add-on commands of `phis-cli`; the Module is selected
in the Site's Modules workspace. What is specific to the Shop:

```text
phis addon config --addon @phis/shop --site <key> --name listing --value gross
phis addon config --addon @phis/shop --site <key> --name currency --value CHF
phis addon config --addon @phis/shop --site <key> --name abandon-after-days --value 7
phis addon config --addon @phis/shop --site <key> --name stock-hold-minutes --value 60
phis payment profile set --site <key> --file <profile.json>
phis addon role --site <key> --addon @phis/shop --user <user id> --grant manager
```

The profile file carries the Shop's grant and the merchant-action policy, in the shape the profile
draft already has:

```json
"grants": [{
  "consumerAddonId": "@phis/shop",
  "operations": ["read", "create", "complete", "cancel", "refund"],
  "merchantActions": {
    "capture": { "roles": [], "jobs": [], "events": [] },
    "cancel":  { "roles": ["manager"], "jobs": [], "events": [] },
    "refund":  { "roles": ["manager"], "jobs": [], "events": [] },
    "profileRefresh": { "roles": ["manager"], "jobs": [], "events": [] }
  }
}]
```

`profileRefresh` lets a manager have Core ask the Provider again for what the profile sells as Merchant of
Record ("Refresh provider countries" on the Destinations tab); without it only the operator's `phis payment
profile probe` does.

A destination is created in the management surface by a manager and names an enabled, probed merchant
profile; saving one whose profile's methods do not support the chosen policy (`listMethods` with the
policy as selector answers nothing) is refused with the reason. Under `merchant-of-record` its countries are
checked against the profile's recorded reach in its currency (`profileReach`, PAYMENTS.md section 14), the
same recording the public `destinations` hook reads, so what was accepted at saving is what the hook offers. A Swiss Site with Stripe for domestic
sales and a Merchant of Record for the rest has two profiles and two destinations: `CH` on
`stripe-ch` with `net`/`provider`, and `*` on `paddle-intl` with `net`/`merchant-of-record`. A Site that
sells only in Switzerland has one destination and never sees the second profile.

A destination whose profile the operator switched off or retired (`profileReach` refuses it as
`profile_unavailable`) sells nowhere: the public `destinations` hook leaves it out, named countries and `*`
alike, and the quote, the order and a subscription pass over it to the next destination covering the
country (phis-shop design/MARKETS.md section 5).

The jobs `orders.expire` (daily) and `orders.release-holds` (every 15 minutes) are run by Core's scheduler, as
every scheduled Add-on job is.

## 10. What needs Core, or someone else, first

- **Delivering a digital good.** A file a paying guest may fetch is a delivery rule the asset slots do
  not have: `delivery` knows public and role-bound readers, not "whoever holds this order's token". A
  download Add-on route that checks the token and streams the object would need a capability that hands
  a handler the object, which `assets:v1` does not offer. Digital goods are therefore listed with
  `fulfilment: granted` as a person's act and the file sent outside the Shop, until that exists.
- **`complete` from an internal route.** PAYMENTS.md section 3 says `complete` is the customer-flow
  continuation; the consumer checks its business access first, which the token is. Core's grant check
  admits `complete` for an internal request today; the design relies on that and says so here so that a
  tightening of the rule is noticed.
- **Address changed on the hosted page.** Stripe's hosted page lets a customer enter a different address
  and recomputes the tax. The Shop cannot forbid it through the contract; it detects it after capture
  (section 6) and leaves the money where it is. A `customer` passed as the policy's details is what the
  Provider should present as fixed; whether it does is the Provider mapping's business
  ([PAYMENTS_STRIPE.md](../PAYMENTS_STRIPE.md) section 8).
- **The checkout machine.** `PhiStateMachineBinding` has one consumer (Auth, `server` authority). The
  Shop's `checkout` machine is composed from Forms and the first of its kind; the binding, the condition
  source for reading it from a page, and the diagnostics may need work in `@phis/ui` before the Shop
  can declare it. That work precedes step 3 of section 11.
- **Public address collisions** are handled by the Modules workspace dialog as designed in
  PUBLIC_ADDRESSES.md; `/shop` is a likely collision with a Site Page.

## 11. Implementation sequence

1. Add-on half with the schema, the catalogue queries, the hook, the management routes and the two
   roles; the Module's binding change; the product Providers and the management surface. A Site can
   maintain a catalogue and show it. No orders yet.
2. Destinations and promotions, with the policy validation against `listMethods`.
3. Checkout: the browser cart, the checkout Form, the place route, the event handler, the order page
   with the token, the expiry job. Sandbox run against `stripe-sandbox` for each policy row of section 5,
   the way the payment probe is run.
4. Management of orders: fulfilment, cancellation, refunds, the customer's own orders in App.
5. The `order-paid` occasion, which belongs to step 3 and needs nothing further from Core.

When steps 1 to 4 are built, the settled parts move into the package's own contract documents and this
file leaves the directory.

## References

- [COMMERCE_AND_PAYMENTS.md](./COMMERCE_AND_PAYMENTS.md) -- the two commerce products and the Payment boundary
- [PAYMENTS.md](../PAYMENTS.md) -- the consumer capability and the pricing policies (section 12)
- [PAYMENTS_STRIPE.md](../PAYMENTS_STRIPE.md) -- the first Provider mapping
- [SERVER_ADDONS.md](../SERVER_ADDONS.md) -- doors, tables, queries, roles, events
- [phis-ui MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/MODULES.md) -- Providers, Forms, Widgets, presets
- [NOTIFICATIONS.md](./NOTIFICATIONS.md) -- the outbox and `notifications:v1`; [PUBLIC_ADDRESSES.md](./PUBLIC_ADDRESSES.md)
