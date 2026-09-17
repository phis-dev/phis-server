# Designs

The documents in this directory are designs and plans, not contracts. They record how something is meant
to work before it is built, and each one states at the top how much of it exists. Code must not be read
against them as if they were normative; the contracts are the documents in the repository root. When a
design is built, its settled parts move into the owning contract and leave this directory.

- [ADDONS_PLANNED.md](./ADDONS_PLANNED.md) -- capabilities supplied by Add-ons, mediated Module Storage,
  sidecar Add-ons, Add-on desired state in the database, and delegated installation.
- [AUTHENTICATION_PLANNED.md](./AUTHENTICATION_PLANNED.md) -- passkeys, email and SMS one-time codes, the
  first-Admin setup token, and CLI emergency recovery.
- [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md) -- external user and group Directory Providers behind
  the provider-neutral `groups:v1` facade.
- [DISTRIBUTION.md](./DISTRIBUTION.md) -- package sources, the listing format, provenance, update checks,
  and delegated installation authority.
- [GROUPS_AND_STORAGE_PLANNED.md](./GROUPS_AND_STORAGE_PLANNED.md) -- custody and audience, Asset transfer
  between Spaces, audience validation at publish, Support teams on general groups, signed delivery URLs,
  and the Storage migration job.
- [PUBLIC_ADDRESSES.md](./PUBLIC_ADDRESSES.md) -- Site Page against Module address collisions, a standing
  list of Public addresses, and durable redirects.
- [THREADS.md](./THREADS.md) -- threads beyond Support: Staff, group and cross-group threads on Site
  groups, message confidentiality, actorless Add-on access through owned and linked threads, verified
  hooks, events to Add-ons, and the two-way GitHub Add-on.
