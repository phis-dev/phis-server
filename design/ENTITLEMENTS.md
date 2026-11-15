# Entitlements

A design, not a contract. Built: the Core service `entitlements:v1` (the capability, the three tables, the
event `entitlement.changed` and the Core job `entitlements.expire`) and the `phis entitlement` operator
CLI (kinds, kind sources, entries by hand); see SERVER_ADDONS.md, DB.md and docs/CLI.md. Not built: an
admin HTTP route or UI for kind sources, the Shop as a source, and the `@phis/ui` access policy. It describes a Core service `entitlements:v1` -- who is
entitled to what, from when until when -- on the pattern of `support:v1` and `payments:v1`: Core owns the
tables and the rules, Add-ons talk only to Core. A later licence Add-on, downloads, courses and an App
Store reconciliation are meant to stand on it. The questions in section 8 are the operator's to decide
before any code.

## 1. Why Core

Today nothing says that somebody may use what they bought. The Shop keeps a `service` state per
subscription that "a clerk's button" moves, and emits `@phis/shop:subscription.changed` without the buyer;
a paid one-time order emits nothing (`phis-shop/design/SUBSCRIPTIONS.md` 92-99). Event facts of an Add-on
are untyped, `roles:v1` is read-only on purpose, and PAYMENTS.md says Core does no fulfilment
(PAYMENTS.md 42-43). So whoever provides what was sold has nothing to read and nobody to ask.

An entitlement is the missing neutral fact between the one who sells and the one who provides. It belongs
in Core for the reason payments do: several Add-ons write and read it, none may see another's tables, and
the Site's operator has to be able to say who may write.

## 2. Vocabulary

Neutral on purpose. Licence keys, devices, seats, prices, products and courses are not Core's words.

- **Kind.** What somebody can be entitled to. Declared in the manifest of the Add-on that *uses* it
  (`@phis/licenses:phidossier-pro`): Core keeps no table of kinds, the installed manifests are the
  catalogue, as they are for roles.
- **Subject.** Who is entitled: a reference Core issues, never a user id. An Add-on learns the subject of
  the acting user and can store it; Core alone knows whose it is.
- **Source.** The Add-on that wrote an entry (`@phis/shop`, later an App Store reconciler). Every source
  manages its own entries and nobody else's.
- **Entry.** One source's statement: subject, kind, source, the source's own reference (an order number),
  start, end or none, quantity or none, and flags.
- **Entitled.** A subject is entitled to a kind while at least one entry for it is valid: not revoked, not
  suspended, started and not ended. Where the kind counts, the quantity is the sum over the valid entries.

## 3. What Core stores

Three tables in `phis`, all Site-scoped, `CREATE` only:

```
entitlement_subjects      id, site_id, user_id (-> user_accounts, CASCADE), reference VARCHAR UNIQUE per Site
entitlements              id, site_id, subject_id, kind VARCHAR ('@scope/name:key'), source_addon_id,
                          reference VARCHAR, starts_at, ends_at NULL, quantity INT NULL, flags INT,
                          created_at, updated_at
                          UNIQUE (site_id, source_addon_id, kind, reference)
entitlement_kind_sources  site_id, kind, source_addon_id, granted_by_user_id, granted_at
                          PRIMARY KEY (site_id, kind, source_addon_id)
```

`flags` carries what is yes or no about an entry (`Revoked`, `Suspended`), as the schema does everywhere.
There is no status column: valid is derived from the flags and the two instants, so an entry that ends
tonight needs no write to stop counting. `kind` is text, not a foreign key -- the manifest is the catalogue,
and an entry whose kind is no longer declared is kept and not counted, as an orphaned role is.

## 4. The capability

```ts
export type PhisEntitlementsCapabilityV1 = {
  /** The kinds the installed Add-ons declare, for a source's settings page. */
  kinds(): Promise<readonly PhisEntitlementKind[]>;
  /** The acting user's subject; null when nobody is acting. */
  subject(): Promise<PhisEntitlementSubject | null>;
  /** Whether a subject is entitled now; without a subject, the acting user. */
  check(input: { kind: string; subject?: PhisEntitlementSubject }): Promise<PhisEntitlementState>;
  /** The entries behind an answer, of every source. */
  list(input: { subject?: PhisEntitlementSubject; kind?: string }): Promise<readonly PhisEntitlement[]>;
  /** This source's statement. Idempotent on (kind, reference): a second call answers the first entry. */
  grant(input: { subject: PhisEntitlementSubject; kind: string; reference: string;
    startsAt?: string; endsAt?: string | null; quantity?: number | null }): Promise<PhisEntitlement>;
  /** Changes this source's own entry: a renewed period, a suspended one. */
  update(input: { kind: string; reference: string; endsAt?: string | null;
    quantity?: number | null; suspended?: boolean }): Promise<PhisEntitlement | null>;
  /** Takes this source's own entry back. An entry of another source is not found, not refused. */
  revoke(input: { kind: string; reference: string }): Promise<PhisEntitlement | null>;
};

export type PhisEntitlementState = { kind: string; entitled: boolean; quantity: number | null; until: string | null };
```

Reading is open to every Add-on that requires the capability. Writing needs a row in
`entitlement_kind_sources` for the calling Add-on and the kind; without one `grant` answers
`not_permitted` and writes nothing. An unverified hook reaches none of it, as with `support:v1`.

Kinds are declared in the manifest, optional like every later field (absent: the Add-on uses none):

```ts
entitlementKinds?: { key: string; title: string; description?: string; counted?: boolean }[];
```

## 5. Who decides what

- **The Add-on that uses a kind** declares it and reads it. It decides what being entitled *means* -- a
  licence key, a download, a course -- in its own tables.
- **A source** states that a subject is entitled, with its own reference, and takes its own statements
  back. The Shop writes on a paid order and on what `payment.changed` says about a subscription; it knows
  kinds only as catalogue ids.
- **The Site admin** decides which source may write which kind, and which of a source's items stands for
  which kind. The first is Core's (`entitlement_kind_sources`, an admin route and `phis entitlement ...`
  in the CLI). The second is the source's own setting -- a product's "entitles to" field, offered from
  `kinds()` -- because Core does not know products.

## 6. The event

Core emits `entitlement.changed` when a subject's answer for a kind changes: an entry is written, changed
or taken back, or one ends. The subject is typed, as `payment.changed`'s is, and carries no state:

```ts
{ event: "entitlement.changed"; subject: { kind: "entitlement"; subject: PhisEntitlementSubject; entitlementKind: string } }
```

A handler reads the current answer through the capability; delivery is the existing outbox, at least once.
An entry that ends without a write is found by a Core job, which emits the event once per ended entry.

On an existing database the outbox's subject check gains a fifth shape by hand.

## 7. Not in this step

- Signing a desktop app in (device flow, app tokens): a design of its own.
- Licence keys, devices, seats: the licence Add-on's.
- Reconciling App Store purchases: a later source Add-on.
- Using a quantity up. `support_allowance_grants` counts consumption because Core owns the request it is
  spent on; here Core does not know what is spent.
- An access policy in `@phis/ui` ("shown to whoever is entitled to ..."): after the capability exists.

## 8. Decided (operator, 2026-11-15)

1. **One subject per Site.** The Shop's buyer and the licence Add-on's holder are the same reference.
2. **With an account only.** What entitles is bought with an account, as a subscription is; a claim by
   e-mail is a later step.
3. **"Product -> kind" is the source's own setting**: a field on the Shop's product, offered from
   `kinds()`. Core keeps no such table.
4. **The declaring Add-on may write its own kind** without the admin's row; every other source needs it.
5. **`entitlement.changed` goes to every enabled Add-on that declares a handler.**
6. **Entries by hand**, with Core as the source, by CLI first.

7. **Quantity is a sum, and Core counts no use.** Where a kind counts, the answer is the sum over the
   valid entries; how much of it is used is known to whoever provides the thing.

## 9. Kept for later: Core counting use

Not built, and not ruled out. A shared balance that several Add-ons draw on -- ten course hours the Shop,
the course Add-on and an app all have to see -- would need Core to count: a `consumed` per entry, a
`consume({ kind, subject, amount, reference })` that is idempotent on its reference, and a `remaining` in
the answer. It adds to the capability without changing what is there. What it has to settle first is what
`support_allowance_grants` settled for itself: which of two entries is spent first, what a revoked entry
does to what was already spent, and that Core believes a use it cannot see.
