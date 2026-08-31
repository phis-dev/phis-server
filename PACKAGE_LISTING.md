# Package Listing v1

**Status: planning. Nothing here is built.** This is the format `DISTRIBUTION.md` refers to when it
speaks of "the list". It is written down so the shape can be argued with before it exists, and so the
decisions that are still open are visible as open rather than as oversights.

## Why a format at all

A source and a consumer must be able to be built by different people who never meet. Whoever offers
packages decides what is in their catalogue; whoever installs decides what to do with it. The format
is the whole of the agreement between them, which is why it has to be small enough to implement by
accident and generic enough that our own use is not privileged.

## A source is a URL

Nothing more. A `GET` returns JSON. The consumer does not know and must not care whether a program
generated the answer from a database or a web server read a file somebody wrote by hand — both are
valid sources, and any rule that only one of them can satisfy is a rule that excludes the small case
for the benefit of the large one.

Sources are configured in the runtime config, asked at bootstrap, switchable by CLI, and ordered. The
default is `cdn.phis.dev`.

## The request

```
GET <source url>
GET <source url>?q=…&category=…&kind=phis.package
                &cursor=…&limit=25&profile=full
```

The bare `GET` must be answered. **Every parameter beyond it is a wish.** A source may honour it,
ignore it, or honour half of it; the consumer re-applies its own filters to whatever comes back, which
on an already-filtered answer changes nothing and on an ignored one does the right thing.

`If-None-Match` is sent whenever the consumer holds a copy, and `304` is the expected answer.

## The envelope

```json
{
  "listVersion": 1,
  "source": "cdn.phis.dev",
  "generatedAt": "2026-08-31T09:12:00Z",
  "profile": "index",
  "rows": [],
  "cursor": "eyJhZnRlciI6IkBhY21lL2NybSJ9",
  "total": 4812,
  "facets": { "category": { "commerce": 41 } }
}
```

`cursor`, `total` and `facets` may be omitted by a source that does not know them.

**One promise binds: a present `cursor` means there is more, an absent one means that was everything.**
It is the only thing in the format the consumer can neither detect nor repair on its own. A filter that
was ignored can be re-applied; rows that were never sent cannot be recovered, and a truncated answer is
indistinguishable from a complete one unless the answer says so. A hand-written file never carries a
cursor and thereby says "complete", which is true.

## The row is an offering, not a package

The listing is generic. What makes an entry a phis package is a field, not the structure.

```json
{
  "id": "acme-crm",
  "kind": "phis.package",

  "name": "Acme CRM",
  "description": "Contacts, companies, activities.",
  "version": "2.1.0",
  "url": "https://acme.example/crm",
  "provider": { "name": "Acme GmbH", "url": "https://acme.example" },
  "updatedAt": "2026-08-20",
  "categories": ["crm"],
  "licence": "proprietary",
  "media": [{ "role": "icon", "url": "…" }],

  "prices": [
    { "currency": "EUR", "amount": 4900, "model": "one-time",
      "url": "https://acme.example/crm/buy?c=eur" },
    { "currency": "EUR", "amount": 490, "model": "subscription", "period": "month",
      "url": "https://acme.example/crm/subscribe" }
  ],
  "rating": { "value": 4.6, "count": 128 },

  "asset": {
    "url": "https://dl.acme.example/crm-2.1.0.tgz",
    "digest": "sha256-9f2c…",
    "bytes": 184320,
    "mediaType": "application/gzip",
    "signature": { "keyId": "…", "alg": "…", "value": "…" }
  },

  "restricted": ["asset"],

  "attributes": {
    "phisVersion": ">=1.2 <2",
    "contributes": ["addon", "module"],
    "acquisition": "transported",
    "addonId": "@acme/crm",
    "moduleIds": ["@acme/crm/modules/contacts"],
    "eligibleAreas": ["app", "admin"]
  }
}
```

`id`, `kind` and `name` are required. Everything else is optional, including the fields we ourselves
care most about — a free internal catalogue with no prices and no ratings is a legitimate marketplace.

**`kind` is the hinge.** It is a namespaced string anyone may define — `phis.package`, `acme.dataset`,
`foo.font` — and it says two things: whether a consumer understands the entry at all, and what
`attributes` means. Core filters on `kind === "phis.package"` and reads `attributes`; a marketplace
selling fonts has rows Core simply steps over. Everything phis-specific lives under `attributes`, which
is why the same format serves a catalogue that has nothing to do with us.

`acquisition` is the front door from `DISTRIBUTION.md`: `transported` (fetched and verified against the
digest), `resolved` (a package manager fetched it, the lockfile is the claim), `built-in` (nothing to
fetch, only to switch on). The fourth door, `local`, appears in no listing — that is its definition.

## Prices

`prices` is an array so a catalogue can quote several currencies and several billing models, and the
purchase link belongs to the entry rather than to the row because currency and billing model are
usually different tills. An entry is identified by `currency` + `model` + `period`; two one-time EUR
entries are an error on the producer's side.

Three states are kept apart: `prices` absent says nothing, `prices: []` says free, and an entry with a
`url` but no `amount` says price on request. Which entry to show is the displaying side's business —
the format does not sort.

## Public or gated

`restricted` names the fields this caller did not get although they exist.

Without it, a missing `asset` would mean either "there is none" or "not for you", and a UI could not
tell them apart — it would offer a free download for a package that is merely unpurchased, or show
"free" for a price that is simply hidden. With it, the same route and the same code answer both callers
and the difference is one array. What is public and what is not remains entirely the producer's policy;
the format prescribes none.

## The signature is on the package, not on the envelope

Signing the envelope would put a signing key inside every running marketplace process, because a
response assembled per request must be signed per request. Whoever takes the process takes the key, and
that is the attacker the signature was supposed to be about.

So the publisher signs once, offline, at release, and the signature travels in the row. The listing may
then pass through any mirror, cache and foreign marketplace without any of it touching integrity.

**What is signed is `packageName` + `version` + `digest` together, not the digest alone.** A signature
over the bytes by themselves can be reused on a different row: an attacker offers `@acme/crm` and ships
the genuine, correctly signed archive of `@acme/backup-tool`. Binding the identity into the signed
payload closes that.

The signature is verified by the installer, not by the listing. Which publisher key an installation
trusts is the open question below.

**One risk stays and is not solved by any of this:** a compromised or hostile source can *withhold* an
update. It keeps serving 2.1.0 while 2.1.1 closes a hole, and nothing in the answer is forged. A signed
envelope would not have helped either — a replayed old answer is validly signed. The only mitigation in
the format is that rows carry a date, so a source that has gone quiet for a long time is at least
visible as such.

## The rules

1. The bare `GET` is answered.
2. Every parameter is a wish; the consumer re-applies its filters.
3. Incompleteness is visible, or there is none.
4. Unknown fields are ignored, never rejected.
5. A missing optional field means "not available here", not "error".
6. The same `id` from two sources: source order decides, and the consumer records where a package came
   from.
7. **The listing decides what is fetched; the package decides what it is.** Capabilities, migrations
   and routes live in the manifest inside the package and are checked there. The one claim of the
   listing that installation enforces is `asset.digest` and its signature.

Rules 4 and 5 are the ones the Add-on manifest already follows, recorded in
`src/lib/addons/manifest-tolerance.test.ts`. They are why one format can carry the narrow Core list and
the full marketplace catalogue: a field added after a document was written is optional and defines what
its absence means, and everything Core does not understand it steps over rather than refusing.

## The consumer

Core holds one copy per source with its ETag, refreshes on a schedule and on CLI demand, and installs
nothing by itself. An Add-on that needs the list asks Core for it as a capability — read-only, kept
separate per source so provenance can be shown.

## Open

- **Which publisher key an installation trusts.** The proposal on the table is to pin the key a package
  was first installed with and to require an explicit operator confirmation for a change. It costs
  nothing the first time and catches exactly the case in question: somebody takes over a name or a
  source and pushes a version.
- **Who paginates for a browsing UI** — through Core's copy, which then has to pass the cursor along, or
  straight against the source, which gives an Add-on a second connection outward and duplicates the
  source configuration.
- **The capability name**, frozen from the first public release. `@phis/phi-server/package-listings:v1`
  is the current suggestion.
- **Whether `attributes.phisVersion` is a range or a minimum.** A range is only worth its ambiguity if
  something filters on it; a dynamic endpoint that answers "newest compatible version for the caller"
  is exactly that something, and a static file is not.
