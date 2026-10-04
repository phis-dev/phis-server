# Designs

The documents in this directory are designs and plans, not contracts. They record how something is meant
to work before it is built, and each one states at the top how much of it exists. Code must not be read
against them as if they were normative; the contracts are the documents in the repository root. When a
design is built, its settled parts move into the owning contract and leave this directory.

- [ADDONS_PLANNED.md](./ADDONS_PLANNED.md) -- capabilities supplied by Add-ons, mediated Module Storage,
  sidecar Add-ons, Add-on desired state in the database, and delegated installation.
- [AUTHENTICATION_PLANNED.md](./AUTHENTICATION_PLANNED.md) -- passkeys, email and SMS one-time codes, the
  first-Admin setup token, and CLI emergency recovery.
- [COMMERCE_AND_PAYMENTS.md](./COMMERCE_AND_PAYMENTS.md) -- a small optional Shop, Payment Provider
  Add-ons behind a minimal Core service, and an independent Medusa Bridge with its own Site Modules.
- [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md) -- external user and group Directory Providers behind
  the provider-neutral `groups:v1` facade.
- [DISTRIBUTION.md](./DISTRIBUTION.md) -- package sources, the listing format, provenance, update checks,
  and delegated installation authority.
- [GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) -- custody and audience, Asset transfer
  between Spaces, audience validation at publish, signed delivery URLs, the Storage migration job, and
  a ceiling that knows which path an object takes.
- [NEWS.md](./NEWS.md) -- News as a Core content type whose read path is built and whose write path is
  not: who may draft and publish one, the first-party Module that contributes only the address and the
  page, and why scheduling and expiry need no scheduler.
- [NOTIFICATIONS.md](./NOTIFICATIONS.md) -- a Core notification service an Add-on may ask for without
  holding an address, who owns the words of an occasion, the outbox that replaces sending inside a
  request, and the unsubscribe link Core owes every circular.
- [PAYMENTS.md](./PAYMENTS.md) -- approval record pointing to the normative Payment contract;
  shared types exist, execution remains pending.
- [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md) -- approval record for the first hosted-checkout path,
  merchant/grant control, notification receipts and event changes; runtime implementation is pending.
- [PUBLIC_ADDRESSES.md](./PUBLIC_ADDRESSES.md) -- Site Page against Module address collisions, a standing
  list of Public addresses, and durable redirects.
- [SUPPORT.md](./SUPPORT.md) -- the requester route and the types it offers, how a Module declares rows
  a Site needs written rather than made available, and how a Site administers them afterwards -- all
  built; what a submission brings with it, and who pays for it, is not.
- [THREADS.md](./THREADS.md) -- threads beyond Support: Staff, group and cross-group threads on Site
  groups, message confidentiality, attachments and who may read one, actorless Add-on access through
  owned and linked threads, verified hooks, events to Add-ons, and the two-way GitHub Add-on.
