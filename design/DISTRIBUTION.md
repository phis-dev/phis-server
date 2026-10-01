# Package Distribution and Updates

## Status

This is a design. Acquisition from sources, lists, and packages is not built; what exists is listed in
the implementation checkpoint below.

This document defines how a phis package reaches a machine, how an instance learns that a newer one
exists, and what is recorded about where an installed thing came from.

It sits beside two documents and does not restate them. What may install code, and what an installed
Add-on physically is, belong to [SERVER_ADDONS.md](../SERVER_ADDONS.md) sections 6 and 7. How a Module
reaches a Site build without patching the Skeleton belongs to `THIRD_PARTY_MODULES.md` section 9 in
`phis-ui`. This document covers only the step before both: acquisition.

The terminology is strict:

- A **source** is a place an instance may fetch a package list from.
- A **list** is the document a source serves.
- A **package** is what is delivered: one archive, one version, one digest, containing an Add-on
  and/or a Module.
- An **artifact** is what an installed Add-on is on disk, unchanged from SERVER_ADDONS.md section 7.

A marketplace is not part of this contract. A storefront is a product that sells things and happens to
be able to serve a list; Core consumes lists and must not know that storefronts exist. The two meet in
the list format and nowhere else.

### Implementation checkpoint

What exists:

- `phis addon install --artifact <path to addon.mjs>` and `phis addon upgrade` -- one local ESM file,
  no other shape
- the artifact digest in the desired state and the manifest digest binding descriptors to it
- `phis.server_addons` holding identity, version, ABI, migration version, and both digests
- the Module half's build state: `phis module add|del|sync` keeps the per-Site Module desired state in
  `config/phis-modules.json` and writes the projection a Site build imports --
  `src/generated/site-modules.ts`, one `site-modules-client-<area>.ts` per Area, and
  `site-modules-authoring-client.ts` in the Site source (`src/cli/modules.mts`), placing each Module by
  the `eligibleAreas` its `package.json#phis` declares. Each entry records the package name, its door as `origin`
  (`local`, `resolved`, or `source`), and the requested spec. Scaffold reconcile preserves the projection.

What does not exist:

- any notion of a source, a list, or a package containing two halves
- any record of where an installed Add-on came from
- any way to ask whether a newer version exists
- the provenance section 7 asks of a Module entry beyond its door: the resolved version, the lockfile
  integrity, and the package digest a list stated

## 1. Three front doors

Every half of every product arrives one of three ways. What separates them is who performed the
acquisition and what claim, if any, can be checked against the result -- not whether the thing is
public or for sale. A company serving twelve of its own servers from an internal source is not
publishing anything and still has a supply chain; a Module built in a working directory for one Site
has none, even if its author later sells it.

- **Local.** Built on this machine, installed from a path. Unverifiable by nature: there is no external
  claim to check it against. This is the ordinary shape for in-house business logic and for a Module
  that ships presets and never leaves the building.
- **Resolved.** An ordinary dependency of the Site build, fetched by the package manager -- typically a
  company's own Module from a private registry. Core performs no acquisition here and holds nothing of
  its own to check it against, but the delivery is not unchecked: the lockfile integrity is the claim,
  and it belongs to the package manager. Update handling belongs there too, and Core's list will not
  report such a Module.
- **Transported.** Named in a list, fetched from a source by `phis-cli`, verified against the digest the
  list states.

The middle door is open to the Module half only, and for a structural reason rather than a policy: an
Add-on artifact must arrive at the derived address in the install root with its digest recorded in the
desired state, and a package manager does not put things there. The install root is deployment state
and never part of a build.

The difference lies entirely in acquisition. Afterwards all three lead to the same place -- an artifact
plus a desired-state entry for an Add-on half, a build-manifest entry for a Module half -- and nothing
downstream of a door may behave differently, or the quieter path becomes the one that is forgotten when
the busier one is changed.

## 2. Sources

Sources are operator state. They live in `config/phis-runtime.json` beside `database` and `api`,
because a source is a property of the machine and not of a Site. The bootstrap asks for them, and
`phis-cli` can change them afterwards on a running installation.

`cdn.phis.dev` is the default value, and a default value is not a decision. A fresh installation must
not reach any source until an operator has said so. An instance that phones home from the moment it
starts is a promise that cannot be withdrawn later.

An instance fetches the **whole list and compares locally**. It must not ask a source a question about
itself. A source that is asked "do I have an update for `@scope/x` at `1.2`?" learns which installations
exist, under which address, and in what state; with the shipped default, that party would be us.
Fetching a document and comparing it here reveals only that somebody read a file, and it lets a source
be a static file rather than a service. A storefront generating a list per entitlement changes nothing
about this: it still serves a document.

When a source cannot be reached, the previous list is kept and marked stale. An emptied list would read
as "no updates available", which is the one answer that must never be guessed.

## 3. The list

The wire format is drafted in section 10, which generalises this section: an entry is an offering of
any kind, and what makes one a phis package is a field rather than the structure. What follows is what
our own consumption of such a list needs from it.

A list describes products. One entry is one product, and a product is delivered as exactly one package:
one version, one URL, one digest. An entry states:

- the product id, its display name, and the provider link
- the version and its release date
- the package URL and the package digest -- absent for a built-in
- which halves the package contains, and for each the compatibility it requires: `serverAbi` for an
  Add-on half, a minimum `phisVersion` for a Module half

The digest is the reason the list matters. A digest derived from the bytes that were just downloaded
confirms only itself; a digest stated by the list makes the list the trustworthy channel and reduces
the delivering host to a byte pump that cannot substitute anything unnoticed. An operator therefore
never types a digest, and `phis-cli` never accepts one on the command line for a transported package.

Compatibility is checked here, not after unpacking. `serverAbi` is compared against the running server
and the minimum `phisVersion` against `config/phis-instance.json`; a version that does not fit is not
reported as an available update at all. Offering an update that cannot be applied is worse than
offering none.

A **built-in** entry carries no URL and no digest. Core skips it, and a storefront may still show it so
that an administrator sees everything available to them in one place, delivered or not.

The list format is the whole interface. A static file on a CDN, a customer's internal server, and an
endpoint offered by a storefront Add-on are all the same thing to Core, and any of them may be produced
by anything that speaks the format.

## 4. One package, two halves

A repository contains an Add-on and/or a Module, and delivers one package. There is no arrangement in
which the halves carry separate versions, separate digests, or separate URLs, and therefore nothing that
can drift between them.

A transported package is an archive with a declaration at its root naming which halves are present and
the compatibility each requires. It is a transport form only:

- the Add-on half is placed at the address SERVER_ADDONS.md section 7 derives, and remains one
  self-contained ESM artifact under the rules stated there
- the Module half is placed in external build state, and becomes real at the next Site build under the
  rules of `THIRD_PARTY_MODULES.md` section 9

The local door needs no archive. A bare `addon.mjs` stays installable exactly as today, and a locally
developed Module stays an ordinary package the Site build depends on. Neither is a lesser path; both
are simply unaccompanied by a claim anyone could check.

The concrete archive layout is not settled and is deliberately not fixed here.

## 5. Three digests, three questions

They are easily confused, and each answers a different question:

| Digest | Covers | Checked | Answers |
| --- | --- | --- | --- |
| package | the transported archive | once, at acquisition | did I receive what the list named |
| artifact | `addon.mjs` on disk | before every first load | is the file still the one that was installed |
| manifest | the validated descriptors | on reconcile and dispatch | do the recorded descriptors belong to this artifact |

Only the first is new here. The other two are unchanged, and a package digest never replaces them: it
speaks about a delivery, not about what is running.

A certification is not a fourth row. It is a signature over the package digest -- a claim about who
vouched for a delivery, not another thing measured about it -- and section 9 states what it may carry.

## 6. Order

The Add-on half is installed before the Module half, because it is hot-pluggable and the Module half
waits for a build. Removal runs in reverse.

The reason is asymmetric damage. An Add-on present without its Module means routes nobody calls, which
is invisible; a Module present without its Add-on means a surface calling routes that do not exist,
which is a broken Site.

A pair is never atomic, and between the two acts an instance runs the new Add-on against the previous
Module. This is inherent to hot-plugging one half and building the other, and it is tolerable only
while it is visible: the build records which package version its Module half came from, so Core can
report a build that is behind rather than leave someone looking for a fault that is not in the source.

## 7. Provenance

Where an installed thing came from must be recorded, and must be visible.

`phis.server_addons` has no origin column today. It needs one: local, or a named source with the
version and package digest that were verified. An Add-on has only these two, because the resolved door
is not open to it.

Where a signature was verified, the signer and the date it was last confirmed belong beside the origin.
Under delegation that pair is the difference between an Add-on an administrator was permitted to install
and one an operator placed by hand, and an operator taking over an unfamiliar machine is asking exactly
that.

For Modules the build manifest is the only place this can live, and it distinguishes all three:

- **local** -- version from the package's own `package.json`, which is the only stamp it will ever
  carry, and enough
- **resolved** -- registry, version, and the lockfile integrity, recorded rather than recomputed
- **source** -- the named source, version, and the package digest the list stated

Folding the middle case into "local" would be the convenient answer and the wrong one. Those two differ
in exactly what an operator is trying to establish: whether anyone but the person at this keyboard
vouched for the bytes.

Without this record, the local door launders the transported one. Somebody downloads a package, unpacks
it, installs the inner `addon.mjs` from a path, and has skipped the digest check that the package door
exists for -- usually not maliciously, but because the file was already lying there. Recording the
origin does not prevent that and is not meant to. It makes it apparent: an operator taking over an
unfamiliar machine must be able to see at a glance which extensions came from somewhere accountable and
which somebody placed by hand.

## 8. How far to automate

Three steps that must stay separable:

1. **Check.** Fetch the lists, compare against what is installed, filter by compatibility, note what a
   signer has since withdrawn, record the result. Nothing is downloaded. This belongs in `phis-cli`,
   invoked by the operator's scheduler -- not in a job, because a job belongs to an Add-on and supplying
   the server is not an Add-on's business.
2. **Stage.** Fetch and verify the package, place it beside the running one. No reconcile, no
   migration, no import: the irreversible part, running unknown code, has not happened, and the step
   can be undone by deleting a file.
3. **Apply.** Reconcile, migrate, build, restart.

The line that matters runs between 2 and 3, and any interface reporting progress should draw it there.
Up to Stage nothing unknown has executed and deleting a file undoes the step. From Apply on, foreign
code has run and a migration does not come back. A failed Apply therefore reports what actually holds --
the schema change stands, the build was reverted -- and never claims a rollback.

Step 3 does not run unattended on a schedule. Migrations are not reversible and a bad Add-on takes the
instance with it. It may run on request, which is what section 9 delegates, but only for a package a
trusted signer vouched for, and never as a default.

A signature is not a fourth digest. It is a claim about the package digest of section 5 -- someone
vouched for these bytes at this version -- and it travels on the list beside the digest it speaks about.
Being verifiable offline against a shipped public key is the point: an installation that has to ask a
service for permission cannot install without a network, and reports every installation to whoever
answers.

## 9. Authority

Nothing here weakens SERVER_ADDONS.md section 6. Acquisition is a deployment operation, so a source may
be read and a package fetched only by `phis-cli` on the machine.

The three levels stand unchanged: installed and globally enabled, or compiled into the build, is a
server-level fact held by the operator; enabled for one Site is a Site-level fact. A Site administrator
acts on the second by default, and on what is already present.

For a pair this used to need no rule. The Module half requires a build, and while nothing could produce
a build from a request, a Site administrator could not trigger a pair installation whatever interface
was put in front of them. That was a structural guarantee rather than a policy, and it ends where a
durable run recorded by `phis` and executed by `phis-host` can produce a build. What the structure gave
for free has to be stated instead.

### Delegated installation

An operator may delegate installation to a Site administrator. The delegation is a server-level setting
held by the operator, and it is bounded twice:

- **by source.** The administrator installs only from a list the operator approved.
- **by signature.** Only a package a trusted signer vouched for, at the exact version and package digest
  it vouched for. A certification is a claim about one release of one package; hung on a vendor or a
  package name it would let one review cover everything shipped afterwards, which is worse than no
  certification because it looks like one.

Trusted signers are a list, with the phis.dev key as the shipped default rather than the only entry, so
a company can vouch for its own packages to its own administrators. A withdrawn certification is picked
up by the Check step, which is why the visible fact is *certified, last confirmed on <date>* rather than
a mark with no age.

Neither bound reaches the operator on the machine. The local and resolved doors of section 1 exist for
code nobody publishes, and requiring a signature there would mean asking an outside party to vouch for
in-house work. The requirement is a property of the delegation, not of the product.

What certification can carry is also bounded. It can establish that the manifest validates, that the ABI
is in range, that the artifact is self-contained, that the declared capabilities match what the code
uses, and that the publisher is identifiable -- most of which `phis addon check` already performs, and
the rest of which is a static scan against the prohibitions in `ADDON_HOWTO.md` section 4. It cannot
establish that the code is safe. An interface that renders it as *reviewed and safe* rather than *this
publisher is known and these checks passed* is making a claim nobody made.

The delegation hands a server-level power to somebody holding a Site-level one. The Add-on half runs in
the process every Site on the instance shares, so where more than one tenant is served this is a
cross-tenant grant however narrowly the interface is drawn. It is unremarkable on a single-tenant
installation, and the two bounds above are what make it arguable anywhere else.

## 10. Package listing format

This is the format section 3 calls "the list", version 1. It is written down so the shape can be argued
with before it exists, and so the decisions that are still open are visible as open rather than as
oversights.

### Why a format at all

A source and a consumer must be able to be built by different people who never meet. Whoever offers
packages decides what is in their catalogue; whoever installs decides what to do with it. The format
is the whole of the agreement between them, which is why it has to be small enough to implement by
accident and generic enough that our own use is not privileged.

### A source is a URL

Nothing more. A `GET` returns JSON. The consumer does not know and must not care whether a program
generated the answer from a database or a web server read a file somebody wrote by hand — both are
valid sources, and any rule that only one of them can satisfy is a rule that excludes the small case
for the benefit of the large one.

Sources are configured in the runtime config, asked at bootstrap, switchable by CLI, and ordered. The
default is `cdn.phis.dev`.

### The request

```
GET <source url>
GET <source url>?q=…&category=…&kind=phis.package
                &cursor=…&limit=25&profile=full
```

The bare `GET` must be answered. **Every parameter beyond it is a wish.** A source may honour it,
ignore it, or honour half of it; the consumer re-applies its own filters to whatever comes back, which
on an already-filtered answer changes nothing and on an ignored one does the right thing.

`If-None-Match` is sent whenever the consumer holds a copy, and `304` is the expected answer.

### The envelope

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

### The row is an offering, not a package

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

`acquisition` is the front door from section 1: `transported` (fetched and verified against the
digest), `resolved` (a package manager fetched it, the lockfile is the claim), `built-in` (nothing to
fetch, only to switch on). The fourth door, `local`, appears in no listing — that is its definition.

### Prices

`prices` is an array so a catalogue can quote several currencies and several billing models, and the
purchase link belongs to the entry rather than to the row because currency and billing model are
usually different tills. An entry is identified by `currency` + `model` + `period`; two one-time EUR
entries are an error on the producer's side.

Three states are kept apart: `prices` absent says nothing, `prices: []` says free, and an entry with a
`url` but no `amount` says price on request. Which entry to show is the displaying side's business —
the format does not sort.

### Public or gated

`restricted` names the fields this caller did not get although they exist.

Without it, a missing `asset` would mean either "there is none" or "not for you", and a UI could not
tell them apart — it would offer a free download for a package that is merely unpurchased, or show
"free" for a price that is simply hidden. With it, the same route and the same code answer both callers
and the difference is one array. What is public and what is not remains entirely the producer's policy;
the format prescribes none.

### The signature is on the package, not on the envelope

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

### The rules

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

### The consumer

Core holds one copy per source with its ETag, refreshes on a schedule and on CLI demand, and installs
nothing by itself. An Add-on that needs the list asks Core for it as a capability — read-only, kept
separate per source so provenance can be shown.

## 11. Independence from any source

`phis-cli` must install, upgrade, and reconcile with no marketplace in the picture at all. A company may
build an Add-on and offer it itself, and nothing about that is a lesser path.

The primitive is `--artifact <local file>`. A URL, a marketplace, or a private registry all resolve to a
local file before the install logic begins: a provider is a way to obtain bytes, never a way to install
them. There stays exactly one install path, and the digest check runs after the bytes land, identically
whatever they came from.

Independence has three levels, and the third is the one lost in practice:

1. With no source configured, everything works.
2. Without a network, everything that needs no bytes works. `reconcile`, `migrate`, `enable`, and
   `remove` never reach a source.
3. With a configured but unreachable source, everything except fetching a package works.

The third breaks the moment a source call slips into a shared path -- a version check, an update probe,
telemetry. No source call belongs on the path of install, upgrade, remove, reconcile, migrate, or enable.
Update notification is the Check step of section 8 and may fail offline on its own.

The CLI must not depend on a marketplace either. A marketplace that is itself an Add-on on the shared
server would otherwise be able to block the repair of Add-ons.

## Open questions

- The archive layout for a package carrying both halves.
- Whether `@phis/server` itself is distributed through the same list. It has the same problem -- version,
  compatibility, is there something newer -- and one format for both would be cleaner than two, but it
  widens the scope.
- Whether sources are a column on `server_addons` or a small table of named sources that entries point
  at. The second suits a customer with one source for many packages, and keeps the access secret in one
  place.
- **Which publisher key an installation trusts.** The proposal on the table is to pin the key a package
  was first installed with and to require an explicit operator confirmation for a change. It costs
  nothing the first time and catches exactly the case in question: somebody takes over a name or a
  source and pushes a version.
- **Who paginates for a browsing UI** — through Core's copy, which then has to pass the cursor along, or
  straight against the source, which gives an Add-on a second connection outward and duplicates the
  source configuration.
- **The capability name**, frozen from the first public release. `@phis/server/package-listings:v1`
  is the current suggestion.
- **Whether `attributes.phisVersion` is a range or a minimum.** A range is only worth its ambiguity if
  something filters on it; a dynamic endpoint that answers "newest compatible version for the caller"
  is exactly that something, and a static file is not.
