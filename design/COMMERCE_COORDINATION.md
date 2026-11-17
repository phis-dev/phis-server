# Commerce Coordination: Products, Acquisitions, Sellers and Suppliers

**Status: design, 2026-11-17; the first step is built, 2026-11-17.** Built, as the sequence of section 15
step 1 begins: the product directory `products:v1` (section 4: the tables `products` and
`product_attributes`, the capability, the manifest field `products` and its registration per Site, the event
`product.changed`, the withdrawal and the return of a supplier's products, the operator's `phis product`),
and in `entitlements:v1` the entry's kind as a product, the operator's allowance per source (section 5
points 1 and 6) and the removal of `kinds()` and `entitlementKinds`. Not built: the subscription binding
and the grace time (section 5 point 2), delivery state (point 3), the resolving of bundles (point 4: a
grant on a bundle writes its one entry), the two fields on payment line items (section 6), the questions
between Add-ons and the seller interface (section 7), the Shop's split (section 8) and everything after
step 1. The state before a lock is not kept: `phis product unlock` takes a product to `withdrawn`. It was
written as a new design on the operator's word, not as a reading of the notes that exist; where it differs
from [ENTITLEMENTS.md](./ENTITLEMENTS.md), [SHOP.md](./SHOP.md) or
[COMMERCE_AND_PAYMENTS.md](./COMMERCE_AND_PAYMENTS.md), section 12 names the difference and the older
text stays right about what is built until this one is. Section 13 lists what the operator decided,
section 14 what is still theirs to decide; the body follows the recommendation where a decision is open
and says so.

## 1. What it is for

A Shop, a licence Add-on, a downloads Add-on, a marketplace, a payment provider and a Medusa bridge have
to work on the same goods without knowing each other. Today the Shop holds the only product table, and
anything that wants to sell through it or deliver for it can only listen to the Shop's own events. That
makes the Shop the centre, and every Add-on beside it a guest of one particular seller.

The goal is one arrangement in which

- an Add-on can supply goods that a seller it has never heard of sells,
- a seller can be replaced (the small Shop by Medusa) without any supplier noticing,
- Core can show every product of a Site, say who supplies it, who holds it and whether it is paid,
  and take it out of sale,
- and a marketplace, a licence Add-on or a payout model arrive later as Add-ons, **without a Core
  change**.

The last point is the measure for everything below: what goes into Core is what more than one Add-on has
to know, plus the one mechanism that lets Add-ons ask each other through Core. That a product exists,
who holds it and whether it is paid is known to seller and supplier alike. A price is needed only by
whoever sells; a licence key only by whoever delivers.

## 2. Roles

An Add-on takes one or more roles. A role is what it does towards Core, not a package.

| Role | Does | Examples |
|---|---|---|
| **Supplier** | registers products with Core and delivers what was acquired | licence Add-on, downloads Add-on, a hosting Add-on; the Shop for what a clerk provides by hand |
| **Seller** | sets prices, keeps catalogue, cart, checkout and orders; records the acquisition after payment | the small Shop, a Medusa bridge, an App Store reconciler |
| **Payment provider** | executes payments at an outside service and declares what it can do | Stripe |
| **Showcase** | reads products, asks for prices, sends the buyer to a seller; keeps no orders | a marketplace Module |
| **Core** | keeps the directories, checks who may write, runs the subscription schedule, relays events and questions | |

No Add-on calls another. There are three ways to speak, all through Core:

1. **A call to Core.** An Add-on reads or writes a directory. Core checks that it may: a supplier changes
   its own products, a seller its own acquisition entries.
2. **An event from Core.** A product, an acquisition or a payment changed; every Add-on it concerns
   learns of it through the existing outbox.
3. **A question Core relays.** Core calls an Add-on through a declared interface and returns the answer.
   Payments are executed this way today. Section 7 makes it available between Add-ons.

## 3. Four building blocks

| | Building block | State |
|---|---|---|
| 1 | **Product directory** (`products:v1`) | new |
| 2 | **Entitlements** (`entitlements:v1`), whose kind becomes a product | built; extended |
| 3 | **Payments** (`payments:v1`) | built; two optional fields |
| 4 | **Capabilities an Add-on supplies**, reachable by another Add-on through Core | designed in [ADDONS_PLANNED.md](./ADDONS_PLANNED.md) section 1; not built |

Block 4 is the lever. With it every later question between Add-ons -- a price, "add this to the cart",
"can this be delivered to this account" -- is a contract between Add-ons that Core relays without
knowing its content. Without it each of them is a Core change.

## 4. The product directory

### What a product is in Core

The identity of something that can be acquired, and nothing about how it is sold or delivered.

```ts
/** The supplier's Add-on id and its own key: `@phis/licenses:phidossier-pro-1y`. */
export type PhisProductId = `@${string}/${string}:${string}`;

export type PhisProductState = "draft" | "active" | "withdrawn" | "locked";
/** Who sells: the Site itself, the publisher at an address of their own, or the Site with a payout. */
export type PhisProductSale = "own" | "referral" | "payout";

export type PhisProduct = {
  id: PhisProductId;
  /** The Add-on that registered it and delivers it. */
  supplier: string;
  /** The supplier's reference for whose product it is; opaque to Core, `null` for the Site's own. */
  publisher: string | null;
  /** The supplier's own word for what it is (`addon`, `download`, `plan`); not a Core list. */
  type: string;
  title: string;
  summary: string;
  /** A Media Asset of the Site, or none. */
  image: string | null;
  /** The quantity of an acquisition counts (seats, hours); otherwise holding it is yes or no. */
  counted: boolean;
  sale: PhisProductSale;
  /** Where the publisher sells it, for `referral`. */
  referralUrl: string | null;
  /** Acquired without a payment; the supplier may record the acquisition itself (section 5). */
  free: boolean;
  /** Only with an account (a licence, a subscription), or by a guest as well. A flag, the supplier's to say. */
  accountRequired: boolean;
  /** A bundle's parts. Acquiring the bundle acquires them. */
  parts: readonly PhisProductId[];
  state: PhisProductState;
  /** What other Add-ons attached, keyed by the Add-on that wrote it. */
  attributes: Readonly<Record<string, unknown>>;
  version: number;
};
```

Deliberately absent: price, currency, tax, stock, category, long description, gallery, files, versions,
keys. The first group is the seller's, the second the supplier's.

Also absent: whether it is paid once or as a subscription, and for how long it is held. A product is
*what somebody holds*; how it is sold is a **listing**, and a seller may keep several for one product --
"PhiDossier Pro" by the month, by the year, and once for good. The acquisition carries the difference: an
end, a subscription, or neither. What takes several products to say is a bundle.

Title, summary and picture are in Core so that a product can still be named when its supplier is
switched off (operator, 2026-11-17).

`type` is free text of the supplier and `attributes` is open, so a new kind of product (an Add-on package,
a course) and a new mark on one (`signed`, a rating) need no Core release. Core reads neither. An
attribute is written by one Add-on under its own id and read by all; it is display and filtering data,
never authority -- whether a package is signed is decided where the signature is checked, not by what
the directory says.

Title and summary are in the Site's source language and translated through the Site's store like any
Module text.

### Who writes

- **The supplier** registers, changes and withdraws its own products, by key; idempotent on the key.
  Products fixed in a package are declared in the manifest and synchronised at install and update, as
  Module media are. Products made at runtime (a software title added in the licence Add-on's admin) are
  registered through the capability. This is what the manifest-only kinds of ENTITLEMENTS.md could not do.
- **Any Add-on** attaches and changes its own `attributes` entry.
- **The Site's operator**, through an admin route and `phis product ...`: withdraw or lock any product,
  or all of one supplier or one publisher; unlock.
- **Core itself**, when a supplier Add-on is disabled or removed: its products are withdrawn (section 9).

Reading is open to every Add-on that requires the capability. A list is filtered by supplier, publisher,
type and state and is paged.

### States

| State | Can be acquired | Holders keep access | Set by |
|---|---|---|---|
| `draft` | no | -- | supplier |
| `active` | yes | yes | supplier; a publisher's product only after the Site operator released it |
| `withdrawn` | no | yes, as it was | supplier, operator, Core |
| `locked` | no | no | operator only |

The release is given once per product. After it the publisher delivers updates -- new versions, new
files -- without another release; that is delivery, and the directory does not see it. A change of what
the release was given for (`sale`, `free`, `parts`) needs it again; a change of title, summary or picture
does not (operator, 2026-11-17).

A product that was ever acquired is never deleted. Its row stays so that an order page, a licence page
and a download page can go on naming it. Deletion is possible only while no entitlement entry refers to
it.

### The event

`product.changed`, subject `{ kind: "product", productId }`, without state, to every enabled Add-on that
declares a handler. A seller takes a withdrawn product out of sale on it.

## 5. Entitlements: the kind is a product

`entitlements:v1` keeps its tables, its rules and its event. What changes:

1. **The kind of an entry is a product id.** The shape is already the same (`@scope/name:key`). `kinds()`
   is answered from the product directory; the manifest's `entitlementKinds` become manifest products.
   One word instead of two, and a new product needs no new package.
2. **An entry's end is a date or a subscription.** `grant` takes an optional `subscriptionId` of
   `payments:v1`. The entry is then valid while that subscription's paid period lasts, derived, not
   written: a renewal needs no call. When a period stays unpaid the entry goes on counting for a grace
   time after the paid period's end and then stops by itself. The grace is a Site setting of Core, in
   days, at most 14 (operator, 2026-11-17); assumed default 14, and 0 ends it with the period. A seller
   that runs its own subscriptions (Medusa) writes `endsAt` and extends it, as today, and its grace is
   its own. Both ways stay.
3. **Delivery state.** The supplier of the entry's product -- and nobody else -- reports per entry
   `pending`, `delivered` or `failed`, with an optional link: a Site path and a label ("Show licence").
   The seller's order page shows it without knowing who delivered. `entitlement.changed` is emitted on
   it.
4. **Bundles.** Granting a product with `parts` makes Core write one derived entry per part under the
   same source and reference; revoking the bundle's entry takes them back. Each part's supplier delivers
   its own.
5. **Free products.** A supplier may grant its own product without the operator's row where the product
   says `free`; this is decision 4 of ENTITLEMENTS.md applied to products.
6. **Who may write.** A row per kind does not scale to a catalogue. The operator allows a source for the
   Site -- for every product, or for the products of named suppliers. Locked and draft products are
   refused; withdrawn ones are refused for new entries and left alone for existing ones.

Unchanged: one subject per Site, issued by Core and never a user id; with an account only; entries by
hand with Core as the source; quantity as a sum, and Core counts no use. Binding an entitlement to
installations or devices stays the licence Add-on's, on top of the subject.

## 6. Payments

`payments:v1` stays. Two optional fields keep later doors open:

- **`product` on a line item**: the product id the line sells, or `null`. It lets a statement, a payout
  or a report be made from payments without asking the seller.
- **`payee` on a line item**: whose money the line is, as the seller's reference, or `null` for the
  Site's own. A provider that can split a payment declares it as a feature, as stored methods and
  TWINT renewals are declared; where it cannot, the field is carried and nothing else happens.

A payout itself -- balances per payee, statements, transfers -- is not in this design (section 11). It is
meant to be an Add-on standing on these two fields. What it needs beyond them is to learn of payments
it did not create; who besides the consumer receives `payment.changed` is the open contract question
there.

A seller is not obliged to use `payments:v1`. Medusa collects through its own providers; what a seller
owes Core is section 8's two things only.

## 7. Questions between Add-ons

The mechanism is ADDONS_PLANNED.md section 1: an interface id minted in a scope with published
declarations, any number of implementations under their own provider keys, Core building the bound
object from the provider's runtime closed over the caller's Site and actor. This design adds what
commerce needs of it:

- **The choice is per Site.** Which provider answers an interface is the Site operator's setting, not
  the installation's. Two Sites on one Core may sell through different sellers.
- **One or all.** For an interface whose members are questions (they answer now and hold no state), the
  operator names one provider **or lets Core ask all of them**; the caller then receives one answer per
  provider, each marked with its provider key. With a single provider installed there is nothing to set.
  Work-shaped members are never fanned out.

The first interface is the seller's, minted by `@phis/contracts`:

```ts
/** `@phis/commerce/seller:v1` */
export type PhisSellerV1 = {
  /** What this seller would charge now; `null` where it does not sell the product. */
  quote(input: {
    product: PhisProductId; quantity?: number; currency?: string; country?: string;
  }): Promise<PhisSellerQuote | null>;
};

export type PhisSellerQuote = {
  amount: PhisPaymentMoney;
  taxIncluded: boolean;
  /** For a recurring product. */
  interval: PhisPaymentInterval | null;
  /** Charged once with the first period. */
  setup: PhisPaymentMoney | null;
  /** The Site path where it is bought. */
  path: string;
};
```

A quote is a display. The binding price is the one at the seller's checkout. Later members of the same
kind -- "add to the cart", and on a supplier's interface "can this be delivered to this account" and
"what must the buyer state at checkout" -- are new interfaces or a `:v2`, and none of them is a Core
change. Caching a relayed answer is the caller's concern; a bridge that answers over the network makes
it one.

## 8. What a seller owes Core, and the small Shop

A seller does two things towards Core: it **reads products** from the directory, and it **records the
acquisition** as an entitlement entry once an order is paid, taking it back on a refund. Everything else
-- prices, tax, stock, categories, promotions, cart, checkout, orders, documents -- is its own.

A product with `sale: "referral"` is no seller's: it is shown with the publisher's address and nothing is
recorded unless the publisher reports it.

**The small Shop is one package with two halves** (operator, 2026-11-17):

- a **seller half**: listings (per product: price per currency, tax category, category, stock, long
  description, gallery, published), promotions, carts, orders;
- a **supplier half** for what nobody else delivers: products made by hand in the Accounting Area, and
  the clerk's "provide" button as their delivery.

The rule that makes the halves separable later: **the seller half never reads the supplier half's
tables.** It reads products through `products:v1` and learns of delivery through the entitlement, as it
would for a foreign supplier. The supplier half becomes its own Add-on when goods with stock and shipping
arrive, or when a second seller is to sell the same hand-made products; nothing else has to move then.

The Shop's `products` table is split accordingly: identity (key, title, summary, picture) goes to the
directory; the listing stays and gains what was the product's: whether it is sold once or recurring. Before v1 the test data is re-entered, not migrated.

## 9. The flows

**Set up.** The licence Add-on registers "PhiDossier Pro, one year". The Shop's Accounting page lists it
among the products not yet offered; the operator gives it a price and a category and publishes it.
Nothing reaches a catalogue by itself.

**Purchase.**

1. The Shop creates the order and asks Core for a payment; the lines name their products.
2. Core has the payment provider execute it.
3. `payment.changed`: paid. The Shop marks the order and sends the confirmation.
4. The Shop grants: this subject holds this product, reference the order line; for a subscription, bound
   to it.
5. `entitlement.changed` reaches the product's supplier.
6. The supplier delivers and reports `delivered` with its link.
7. `entitlement.changed` again; the order page shows the link.

**Subscription.** Nothing is written on a renewal. An unpaid period ends the entitlement after the Site's
grace time; the supplier learns of it through the event Core's expiry job already emits.

**Refund.** The seller revokes its entry; the supplier learns of it and takes back what it delivered.

**Withdrawal.** The product goes to `withdrawn`. Sellers stop selling it, showcases stop showing it,
holders keep what they have. A subscription on it is not renewed past its paid period -- the seller
cancels it at period end on `product.changed`.

**Lock.** As withdrawal, and every entry for the product stops counting while it is locked.

**A supplier Add-on is disabled or removed.** Core withdraws its products and keeps them and their
entries, marked as without supplier; nobody can deliver until it returns. `phis` states the number of
holders before removing it.

## 10. Medusa

A Medusa bridge is a seller. It is not a payment provider towards Core: Medusa leads its own payment
workflow. It registers Medusa's products in the directory as projections with their Medusa identity
(supplier: the bridge; the truth stays in Medusa), creates or links listings in Medusa for products of
other suppliers, and records the acquisition when Medusa reports a paid order. Subscriptions Medusa runs
are written with `endsAt`. It answers `quote` like the Shop does.

Open there, and not solved here: an acquisition belongs to a phis account. Medusa customers and phis
accounts need a binding, and a guest order entitles nobody until it is claimed.

Two separate shops on one Site are Medusa's territory (operator, 2026-11-17); the small Shop is one per
Site.

## 11. Marketplaces, and what stays out

A marketplace is a showcase, usually together with a supplier, and two marketplaces know nothing of each
other (operator, 2026-11-17): one for phis Add-ons, started first; one for software downloads later.

For the Add-on marketplace the design holds as follows.

| Case | `sale` | File | Entitlement |
|---|---|---|---|
| Free Add-on on GitHub or npm | `referral`, no price | elsewhere | none |
| Own paid Add-on | `own` | with us | yes |
| Third party sells itself | `referral` | theirs | none |
| Third party, sold by us | `payout` | with us | yes |

A publisher is an ordinary account with a role; `publisher` on the product is the marketplace's reference
to it. An uploaded package and a link to a public repository are two kinds of delivery, the supplier's
matter; a mark such as "signed" is an attribute. Versions, the Core version a package fits, checksums and
screenshots are the marketplace's own data, which is why showcase and supplier are one Add-on there.

Not in this design, and not blocked by it:

- **How a package is signed and checked.** Decided later (operator, 2026-11-17). One part of it cannot be
  an Add-on: verifying a signature at install runs in `phis` before any Add-on does. That is a small
  place of its own in the installer ([DISTRIBUTION.md](./DISTRIBUTION.md)) and touches none of the four
  blocks.
- **A foreign installation as the buyer.** An Add-on runs on the buyer's server while the entitlement
  belongs to an account on ours. Binding installations, and the public interface a foreign Core asks,
  loads and installs through, are the licence Add-on's and the marketplace's.
- **A lock reaching installed copies.** `locked` acts on this Site. A revocation list foreign Cores fetch
  is distribution work.
- **Payout.** Balances, statements and transfers; and before any of it the question whether the Site
  sells in its own name or as an agent, which decides invoice, VAT and liability and is the accountant's.
- **Checking deliverability before the sale, and statements the buyer makes at checkout** (a domain name
  for a hosting plan): supplier interfaces through block 4.
- **A guest's acquisition.** An entry belongs to a subject, and a subject to an account. What a seller
  delivers itself needs no entry, so a guest buys it as today. What another Add-on delivers to a guest --
  a download -- needs a subject without an account: issued for the order, bound to its e-mail address,
  reached through the order page's link, and taken over by an account that later proves the same
  address. Built with the first supplier that delivers to guests; until then a seller records an
  acquisition where the order has an account.
- **Core counting use** of a consumable: ENTITLEMENTS.md section 9, unchanged.

## 12. What this changes in the older notes

- ENTITLEMENTS.md section 2, "Core keeps no table of kinds" and "products are not Core's words", and
  decision 3 of its section 8 ("product -> kind is the source's own setting"): replaced by section 5.
  The product is the kind; the mapping disappears.
- ENTITLEMENTS.md section 4, the per-kind source row: replaced by section 5, point 6.
- SHOP.md section 4: the product table is split (section 8).
- COMMERCE_AND_PAYMENTS.md sections 6 and 7 stand; section 10 says where the bridge meets the
  directories.
- ADDONS_PLANNED.md section 1 stands; section 7 adds the per-Site choice and "ask all".

## 13. Decided (operator, 2026-11-17)

1. This is a new design; Core may hold products so that they can be withdrawn and read by every Add-on.
2. Other Add-ons ask Core for a price and Core relays the question to the seller; the seller is
   replaceable.
3. The operator sets one shop per Site to answer, or lets all be asked.
4. A third party's product states whether the third party sells it itself (a link to its own shop) or
   the Site sells it and pays out.
5. Two marketplaces as separate Add-ons that do not know each other; the one for phis Add-ons first.
   A package is uploaded and signed, or a public GitHub repository is linked.
6. How signing works is decided later; the design must allow it without a Core change.
7. Two separate shops on one Site are Medusa's; first a usable shop system that Core coordinates.
8. The Shop stays one package with a seller half and a supplier half.
9. Title, summary and one picture of a product are in Core, so that a product can be named when its
   supplier is switched off.
10. Bundles are kept in Core.
11. `withdrawn` and `locked` are two states.
12. An unpaid subscription period: the entitlement lasts at most 14 more days; the number is a setting.
13. A third party's product is released by the Site operator. Once released, the third party delivers
    updates for it without another release.
14. Product and entitlement kind are one: an entry says that an account holds a product, and the Shop
    keeps no mapping from products to kinds.
15. Who may write acquisitions is allowed per seller and Site -- for every product, or for the products
    of named suppliers -- not per product.
16. On a released product a publisher changes title, summary and picture freely; a change of `sale`,
    `free` or `parts` needs the operator's release again.
17. A guest can buy what needs no account. Whether a product needs one is the supplier's to say, per
    product, kept as a flag in Core; a checkout asks for the sign-in where a product in the cart says so.

## 14. Open, the operator's to decide

Nothing at present.

## 15. Sequence

1. `products:v1`, and the Shop moves: its supplier half registers the hand-made products, its seller half
   reads the directory and grants on a paid order. Nothing changes for a visitor.
2. Block 4 with the per-Site choice, and `quote` as the first interface.
3. Delivery state, the subscription binding, bundles, withdrawal and lock; the licence Add-on as the first
   foreign supplier, which is what tests the contract.
4. The marketplace for phis Add-ons, free ones first.
