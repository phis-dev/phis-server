# Phi Server Add-on Contract

## Status

This document defines the v1 contract for extending `@phis/server` and binding Site Modules to server
capabilities.

Common Site authentication methods and session authority remain in Core under
[AUTHENTICATION.md](./AUTHENTICATION.md); they are not optional Add-ons. A new authentication protocol may
be supplied by an audited Add-on, but it must resolve into the Core global-user, Site-membership, and
session contract. Its bound Site Module remains presentation-only and cannot become a second credential or
session authority.

The terminology is strict:

- Site/client extensions are **Modules**.
- Server extensions are **Add-ons**.
- **Core** is the built-in server capability provider.

Loading a package from request or database data, allowing a Module to install server code, or exposing
direct database access to browser code violates this contract.

### Not built

The following parts of this contract are not implemented. None of them is represented by a fallback:

- **DDL separation for `phis`.** An Add-on schema is owned by the migration role, and the serving role
  holds only usage and data access there. The Core schema is not separated the same way: the serving role
  owns the `phis` tables, because the operator setup page (`src/app/(operator)/setup/actions.ts`) applies
  `scripts/sql/001_create_phis.pgsql` through `src/db/bootstrap.ts`, and `phis schema apply` runs as the
  serving role (section 15).
- **`@phis/addon-sdk`.** The build-time half described in section 3 -- descriptor builders, result-type
  generation, a context double -- has no package.
- **Capabilities without a delivery.** `@phis/server/authentication:v1` is named in the Core catalogue
  but is not bound to an Add-on context. It is a name a Site Module asks about -- Core performs
  authentication -- and there is nothing to hand an Add-on about it.
  An Add-on requiring one of them is refused at dispatch, by the job runner, and when its service factory
  is resolved (section 13).
- **Site-admin activation and configuration.** A Site's request for an Add-on and its settings are
  written by `phis addon site` and `phis addon config`. There is no Site-admin API or page for either, and
  no provider setup flow.
- **Rollout reconciliation.** Every serving instance writes `phis.server_instances` at startup and on an
  interval, and `phis instance list` shows where instances disagree about the release or the Add-on set.
  Nothing waits for that agreement: enabling an Add-on completes while an instance is behind (section 17).

Provider-owned viewer roles and the universal Core role claim are governed by
[AUTHORIZATION.md](./AUTHORIZATION.md). Add-on capability availability and viewer-role authorization
are separate gates.

## 1. Identities and terminology

### Module

A Module is a namespaced extension compiled into a Site application. It may contribute React UI,
widgets, layouts, presets, navigation, authoring Clients, controller Clients, and other Site-runtime
artifacts supported by the Module ABI.

A Module id is `<npm-package>/modules/<module>`, and everything the Module owns hangs off it as
`<npm-package>/modules/<module>/<namespace>/<leaf>`. The `modules` marker is required, including for a
package with a single Module: without it, nothing can tell a Module name from a namespace. The grammar
and its enforcement are normative in
[THIRD_PARTY_MODULES.md](../phis-ui/THIRD_PARTY_MODULES.md).

Examples:

```text
@phis/support/modules/support
@phis/github/modules/github
```

### Add-on

An Add-on is a namespaced, operator-installed server extension. It is never compiled into
`@phis/server`: it is installed at runtime as one artifact (section 7). It may contribute server
routes, webhook handlers, jobs, schema and query descriptors, server-side service providers, and
versioned capabilities supported by the Add-on ABI.

One package carries one product, and its name is the Add-on id. There is no `-server` postfix; the two
halves are told apart by their entrypoints rather than by two package names:

```text
package:  @phis/github
addonId:  @phis/github
modules:  @phis/github/modules/github
```

The halves may not carry separate versions, digests or URLs, because anything that can drift eventually
does ([DISTRIBUTION.md](./design/DISTRIBUTION.md), section 4).

Logical identity and physical package identity remain separate fields, and normally hold the same
string. A replacement package may be named differently; the logical Add-on id is API and persistence
identity and does not follow a repackaging.

### Core

Core is compiled into every `@phis/server` release, is never installed as an Add-on, and cannot be
disabled per Site. It participates in capability discovery as:

```text
@phis/server/core
```

### Capability

A Capability is a namespaced, versioned server interface supplied by Core or one Add-on. Capability
version is independent from provider package version.

```text
@phis/server/threads:v1
@phis/server/resource-links:v1
@phis/server/support:v1
@phis/github/issues:v1
```

The version sits in the id. A capability's `interfaceDigest` identifies it in a snapshot; for Core
capabilities it is derived from the id alone and describes no shape. A shape change raises the id to
`:v2`, Core stops offering `:v1`, and an Add-on requiring the old one is refused at dispatch by name
alone. A service kind has no version in its name and needs its interface digest to say the same thing.

### One supplier, and what happens when there are two

"Supplied by Core or one Add-on" is a count, not a turn of phrase. A capability names a single place an
installation goes for that interface, and two Add-ons claiming the same id is not a preference to
resolve but an installation that has not been decided.

It is refused in two places, and both are needed:

- **`phis` refuses the second install.** That is where a person makes the mistake, and it is the only
  place they can be told before anything depends on it.
- **Resolution refuses a double claim.** The capability is reported unavailable with a diagnostic code,
  and an Add-on requiring it is refused as though nobody offered it.

The CLI check alone would make this a request rather than an invariant: an install root is a directory,
and a directory can be written to by something other than `phis`. The resolver is what makes the
guarantee hold; the CLI is what makes it legible.

**Picking one is not an option.** Choosing by load order or alphabetically produces an installation that
works, routed through a supplier nobody selected, and the operator finds out when the behaviour is
wrong rather than when the configuration is. Refusing to start is the other overreach -- a misplaced
directory must not take the server down.

The end state is the same one an installation reaches when it names a capability nobody supplies: off,
with a reason. One state, not two.

### How a Capability reaches an Add-on

Declaring one is not receiving one. `requiredCoreCapabilities` decides whether the Add-on may run at
all; what it then gets is a bound object on its request context, built per request, with the Site and
the acting user closed over. There is no argument through which an Add-on could name another Site or
ask about somebody else -- the restriction is the shape of the thing rather than a check inside it,
which is the same reason a Storage Provider is handed its own secret instead of a reference it could
substitute.

Only declared Capabilities are present, and a Capability this release does not offer never arrives as a
broken object: the Add-on was already refused. An Add-on reaching for one it did not declare finds
`undefined` at the point where it made the mistake.

## 2. Module-to-server binding

Every Site Module declares exactly one server binding:

1. Core, optionally with required Core capabilities; or
2. exactly one logical Add-on id, with required capabilities supplied by that Add-on.

The relation from Module to server provider is single-valued:

```text
Site Module -> Core
```

or:

```text
Site Module -> one Server Add-on
```

The following rules apply:

- A Module must not bind to several Add-ons.
- A Module must not install, enable, import, or dynamically discover an Add-on.
- A Module binding never auto-enables its provider.
- A Module may require additional Core capabilities without changing its single provider binding.
- One Add-on may serve several Modules only when they intentionally share one integration owner,
  deployment lifecycle, and security boundary.
- Cross-domain composition uses Core contracts such as Threads, Resource Links, runtime signals, or an
  explicitly approved bridge contract; it is not hidden multi-Add-on ownership.
- A client-only Module with no special server service binds to Core without additional capability
  requirements.

Reference bindings:

```text
@phis/support/modules/support -> Core
@phis/github/modules/github  -> @phis/github
```

## 3. Package halves and module graphs

One package may carry a Module half, an Add-on half, or both, under one name and one version. The halves
are separated by entrypoint and by process, not by package:

```text
@phis/marketplace            Module half: ".", "./server", "./client", "./authoring-client"
@phis/marketplace/addon/*    Add-on half: "./addon/manifest", "./addon/runtime"
```

A file or a `./server` export of the Module half is not an Add-on and is never loaded by `@phis/server`.
`./server` belongs to the Module and runs in the Site process; the Add-on half is built from
`./addon/runtime` into one artifact and runs in the `@phis/server` process.

The separation is mandatory:

- Module entrypoints contain Site-runtime and authoring code.
- Add-on entrypoints contain server-only code.
- `@phis/server` never imports a Site or React package, and never imports an Add-on package by name.
- A Site application never imports an Add-on entrypoint.
- An Add-on never imports `@phis/ui`.
- Both sides may depend on the neutral, React-free `@phis/contracts` package for shared wire schemas.
- Server-only and Site/Client entrypoints remain physically separate module graphs.

Two neutral packages sit between the sides, and what separates them is when they run:

- `@phis/contracts/addon` states what an Add-on declares or implements.
- `@phis/contracts/access` states the authorization vocabulary `@phis/server` and `@phis/ui` both
  evaluate -- claim shapes, policy shapes, and the one evaluator, `canPhiAccessSubjectReach`. It lives
  there because both decide the same question in different processes and cannot defer to each other:
  `@phis/server` in its guards, the Site while rendering and in the browser. One compiled source is the
  only arrangement in which they cannot disagree. `@phis/server` depends on it, which is why nothing may
  enter it that does more than hand back data. Validation stays in Core: a check shipped to an Add-on
  runs in the Add-on's address space, at the version the Add-on chose, and only if the Add-on calls it,
  so it can never be the authoritative one.
- `@phis/addon-sdk` is to carry what an author uses while building -- descriptor builders, generation
  of result types from declared queries, and a context double for tests. It is not built yet. It
  depends on the contract and is a development dependency and nothing else: an Add-on with the SDK
  removed still runs.

The split is a boundary rather than a discipline. A package carrying runtime code can be installed twice
at two versions, and anything stateful inside it would then exist twice; keeping the SDK out of the
runtime path means that question is never asked.

Publishing a Module does not publish, install, authorize, or activate its corresponding Add-on.

## 4. Add-on and route namespace

Every Add-on uses a scoped logical id:

```text
@scope/name
```

Unscoped Add-on ids are invalid. Routes preserve both identity segments:

```text
@phis/github
-> /api/v1/addons/phis/github/...
-> /api/v1/hooks/phis/github/...
```

```text
@acme/github
-> /api/v1/addons/acme/github/...
-> /api/v1/hooks/acme/github/...
```

Lossy values such as `phis_github` are not canonical Add-on, route, or persistence identity. Inside an
internal technical identifier they may appear as a readable fragment, on one condition: that identifier
must be collision-free. A collision-resistant digest is how that is achieved when the identifier has to
be computed without a lookup. Where it is instead recorded once and uniquely indexed, the lookup does
the same work, and the readable fragment may stand alone -- which is what a schema name does, because an
operator reads it by hand and a digest would cost more there than it buys. What remains forbidden is
computing a lossy value and then treating it as identity.

## 5. Add-on manifest

Every Add-on exports a server-only manifest, `PhisAddonManifestV1` from `@phis/contracts/addon`:

- `manifestVersion`
- `addonId` (the logical id; the route namespace is derived from it), `packageName`, `packageVersion`
- `serverAbi`: the compatible Add-on ABI range
- `capabilities`: provided capabilities with their interface digests
- `serviceProviders`: service-provider descriptors when the Add-on implements a Core-owned service kind
- `requiredCoreCapabilities`: Core capability ids
- `apiRoutes` and `hooks`: route descriptors with method, path, handler, authentication policy, body
  limit, rate-limit class, and timeout
- `jobs`
- `schema`: the schema descriptor, or `null` when the Add-on owns no tables, and `migrationVersion`
- `queries`: the declared query catalog
- optional `settings`, `roles`, `groups`, `groupWriter`, and `modules`

The manifest digest is the SHA-256 of the manifest's canonical JSON and therefore covers every field. The
manifest never contains runtime secrets.

### Adding to the manifest

A field added after this manifest version is already in the wild is **optional, and defines what its
absence means**. A required addition would lock every installation out the moment Core is upgraded: the
stored manifest was written as it was built, its author had not forgotten the new field, and the digest
means the file cannot be repaired by hand either. The initial fields may demand an explicit `null`,
because no stored manifest predates them.

`manifestVersion` is for something else and is deliberately rarer: it changes when an existing field's
*meaning* changes, where an old manifest is not incomplete but wrong, and reading it under the new rules
would install something subtly incorrect. Refusing is right there, and it is expensive on purpose.

The package exposes two explicit server entrypoints, both under `addon/`:

```text
@scope/package/addon/manifest
@scope/package/addon/runtime
```

`addon/manifest` exports `phisAddonManifest` and must be safe for inspection without starting jobs,
opening connections, or reading secrets. `addon/runtime` exports `phisAddon`: the same manifest plus the
handler maps (`apiHandlers`, `hookHandlers`, `jobHandlers`) and `serviceFactories`. There is no
package-root fallback. The installed artifact is `addon/runtime` bundled into one file, and Core reads
the manifest from its `phisAddon.manifest` ([ADDON_HOWTO.md](./ADDON_HOWTO.md)).

The `addon/` prefix is what keeps the halves apart inside one package. A Module already spends `./server`
on its React Server Components -- code that runs in the *Site* process -- and an Add-on runs in this one.
Two different processes called "server" in one package name is the kind of collision that surfaces at
build time, in somebody else's build. The prefix also makes the one way these exports are ever resolved
visible: Core loads the artifact by file path against its digest (`src/lib/addons/installed.ts`) and
never by package name, so the only resolver that will ever meet `addon/runtime` is a Site build whose author reached for
the wrong half.

The prefix holds whether or not a Module half is present. A package with one half is not a different
kind of package, and a rule that only applies sometimes is one that has to be remembered.

## 6. Installation and deployment authority

Only `phis-cli` may:

- install, upgrade, or remove an Add-on artifact
- validate Add-on ABI and descriptor collisions
- execute reviewed Add-on migrations
- write and remove entries in the Add-on desired state
- globally enable or emergency-disable an Add-on
- build and deploy `@phis/server`
- distribute an artifact to every instance and reconcile the release across them

No browser route, Site Module, persisted CMS value, Add-on handler, or database row may:

- install a package
- submit or execute arbitrary SQL
- submit a migration manifest
- change a package name or version
- create a dynamic package import
- add a top-level Next.js route
- globally enable server code

Installation and upgrade are deployment operations, not Site configuration operations. They do not
require a release: an Add-on is installed into a running server, and only a change to `@phis/server`
itself is a build.

How an artifact reaches the machine in the first place -- configured sources, the package list an
instance compares against, what is recorded about an Add-on's origin, and how far update handling may
be automated -- is [DISTRIBUTION.md](./design/DISTRIBUTION.md). Nothing there widens this section: acquisition
is a deployment operation like the rest.

## 7. Install root and desired state

An Add-on is one self-contained ESM artifact. `phis-cli` places it in the install root and records the
entry -- its identity, its validated descriptors, and two digests -- in the operator-owned desired
state. No Add-on is compiled into `@phis/server`, and there is no second mechanism beside this one.

Self-contained is a requirement, not a recommendation. An artifact carries its dependencies and leaves
no bare import behind except `node:` builtins, because Node resolves a bare specifier by walking up:
one left in place reaches whatever `node_modules` sits above the install root, including the server's
own. An Add-on that cannot be bundled -- one needing a native binary or a runtime-loaded asset -- is
therefore not an in-process Add-on at all. Its capability belongs in Core, or in the separate-process
shape planned in [ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md), section 3.

The artifact's address is derived, never stored:

```text
<install root>/<scope>/<name>/<version>/addon.mjs
```

Together, the install root and the desired state are the only authority for code loadable by a running
release:

- Every load address is computed from the logical Add-on id under a fixed root. A stored string is a
  selector among artifacts already on this instance, and never becomes an import specifier itself.
- No request, database value, environment value, or Module selection becomes an unrestricted import
  specifier.
- The artifact digest is verified against the file before the first load, and an artifact that no
  longer matches is refused rather than loaded.
- The descriptors in the desired state are bound to the artifact by the manifest digest, so a
  hand-edited entry cannot widen an Add-on's routes, capabilities, or schema.
- An Add-on present only in the database is not loadable.
- An Add-on present only in the install root is not effective until registry reconciliation succeeds.
- An installation without Add-ons produces an empty desired state while the fixed Core routes remain
  valid.

The install root is deployment state and must never be part of a build artifact or container image.
Because it is per-instance while the registry is shared, an artifact has to be present with a matching
digest on every instance before the registry may report the Add-on as enabled; enabling first makes it
answer on one instance and fail on the others.

Node cannot unload an ES module. The digest therefore travels in the load address as its cache key: a
new digest is a different specifier, so the next dispatch reaches the new code while requests already
in flight finish on the old one, and the superseded version stays resident until the process restarts.

### Getting out of a state this release cannot validate

A stored manifest can stop validating without the operator having touched anything: a Core release that
renames a capability or a service kind invalidates every entry that named the old one. The manifest was
right when it was written, and the digest means it cannot be edited by hand without breaking a second
check.

Reading the desired state in order to **run** an Add-on stays strict -- an invalid manifest is exactly
what must not be executed. Reading it in order to **describe or change** it does not:

```
phis addon list       shows invalid entries first, by name, with what fails
phis addon check      diagnoses before loading anything, and names the way out
phis addon upgrade    replaces the entry, even from the same artifact when the entry is broken
phis addon disable    and then remove, on an entry that does not validate
```

The exception in `upgrade` is the point of it: re-installing an unchanged artifact is normally refused
as a no-op, but when the stored entry is what is broken, re-writing it is the repair. What gets written
is validated either way, which is the check that actually protects anything.

`phis addon forget` is the last resort: it removes an entry from the desired state without reading it,
and leaves the artifact on disk for `phis addon check` to report.

## 8. Fixed Core routes

`@phis/server` owns two fixed optional catch-all Route Handlers:

```text
/api/v1/addons/[scope]/[name]/[[...path]]
/api/v1/hooks/[scope]/[name]/[[...path]]
```

The route files are Core-owned and are never generated per Add-on.

### Authenticated Add-on API

`/api/v1/addons/*` handles Site-, user-, or operator-authenticated Add-on operations. Core applies the
declared minimum authentication policy before dispatch.

```text
/api/v1/addons/phis/github/installations
/api/v1/addons/phis/github/repositories
/api/v1/addons/phis/github/resource-links
```

### External hooks

`/api/v1/hooks/*` handles external webhooks, OAuth callbacks, setup callbacks, and equivalent
provider-originated requests.

```text
/api/v1/hooks/phis/github/webhook
/api/v1/hooks/phis/github/oauth/callback
/api/v1/hooks/phis/github/setup/callback
```

Hook authentication is provider-specific but descriptor-controlled. Core still enforces method, body
limit, request identity, rate-limit class, logging envelope, and timeout policy. Authenticated APIs
and external hooks never share an implicit authentication policy.

#### A hook may be told its Site, and may still not write

A hook is unauthenticated by construction -- that is what makes it callable by a payment provider, or by
somebody else's Core reading a catalogue. Without a Site it has no capabilities at all, because every one
of them is Site-scoped: it can verify a signature and touch no data.

`siteScoped` on a hook descriptor changes only that. The Site comes from `x-phis-site-key`, the header
every Site-scoped route already uses, and a hook that asks for one and does not get it answers 404 --
which incidentally keeps the address out of indexes and off casual scanners. The header is not a secret
and this is not access control; it is hygiene, and it costs nothing.

What does not change is who is calling: nobody. The actor stays null, and null on a hook means something
it does not mean anywhere else. An internal caller arrives as `{kind:"internal"}`, an operator as
`{kind:"operator"}`, and a job carries system authority -- all three have no Site user id and none of
them is anonymous. Only a hook has no actor at all.

**A request with no actor may read and may not write.** All three mutations are refused before the
ladder is consulted, because there is no row-level question to be ambiguous about: this caller may change
nothing whatever the row is. Insert is the one that needed saying -- update and delete would have been
refused by the ladder anyway, while an insert has no row to judge and would otherwise have gone through,
writing owner-less rows on an address anybody may call.

This is why a public listing endpoint is a hook and not an API route: the reading it needs is available,
and the writing it must not do is impossible rather than merely undone.

#### A hook that needs to write says how it can be believed

`verification` on a hook descriptor is how an unauthenticated address stops being anonymous:

```ts
verification?: {
  scheme: "hmac-sha256";
  header: string;            // "x-hub-signature-256"
  prefix?: string;           // "sha256="
  secret: string;            // a secret name an operator has set for this Add-on on this Site
  deliveryIdHeader?: string; // "x-github-delivery"
}
```

Core checks it before the handler is even looked up (`src/lib/addons/hook-verification.ts`), over the
**raw body**: parsing first and re-serialising would digest something the sender never sent, and every
key ordering would be a way for the two to differ. The comparison is timing-safe, and it is made here
rather than in each handler because a signature compared with `===` inside somebody's route is a
signature compared in variable time.

- `secret` is resolved per Site, through the same reference machinery `secrets:v1` uses, so a verified
  hook is necessarily `siteScoped: true` -- the manifest refuses one that is not.
- `deliveryIdHeader`, where stated, is claimed in `phis.addon_hook_deliveries` after the signature
  matched and before the handler runs. A repeat answers `200 {"ok":true,"duplicate":true}`, which is
  what makes the sender stop retrying; an error would make it retry harder.
- A missing or unreadable secret answers **503**, not 401. The caller did nothing wrong, and 503 is what
  makes the sender try again once the operator has finished configuring the Add-on.
- A bad signature answers **401** and nothing else happens.

**A verified delivery writes as a job does**: system authority over the Add-on's own tables, and the
actorless thread reach of section 18. An unverified hook keeps the rule above -- it may read `data:v1`,
and `threads:v1`, `resource-links:v1` and `support:v1` refuse it outright, reads included, because the
reach those three confer rests on a link a person wrote as consent and handing it to whoever found an
unsigned address would make that consent meaningless.

## 9. Dispatch contract

Before an Add-on handler receives a request, Core verifies:

1. the scoped logical Add-on id
2. presence in the local install root, with an artifact matching its recorded digest
3. global deployment enablement
4. registry reconciliation for the locally installed entry
5. Site enablement when the route is Site-scoped
6. package, Add-on ABI, and capability compatibility
7. applied migration version
8. required configuration and secret availability
9. an exact declared method and subpath match
10. authentication and authorization policy
11. request size, rate limit, timeout, and audit requirements

The dispatcher never gives an Add-on control before these checks. An Add-on cannot claim another
namespace or register outside its own route namespace.

## 10. Handler context

An Add-on handler receives one argument, `PhisAddonRequestContext` from `@phis/contracts/addon`:

- `addonId` and `requestId`
- `method`, `url`, `headers`, the raw `body` bytes, the matched `path`, and its `pathParams`
- `site`: `{ id, key, publicBaseUrl }` for a Site-scoped route, otherwise `null`
- `actor`: a Site user, an operator, an internal caller, or `null` on a hook
- `capabilities`: the Core capabilities the manifest declared, bound to this Site and actor (section 13)
- `signal`: an `AbortSignal` that fires when the caller aborts or the declared `timeoutMs` elapses; a
  timed-out request answers 504, and the handler is not cancelled

There is no database handle, no general secret accessor, no logger, and no outbound HTTP client on the
context. Mediated Module Storage is planned in [ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md),
section 2.

Request values never define effective Site, Add-on identity, package name, secret namespace, or
database namespace.

Trusted in-process Add-ons are not a security sandbox. Code not trusted by the operator runs in a
separate process or container behind an authenticated service boundary.

### Internal service providers

An Add-on may implement a Core-owned in-process service kind through the same installation and
activation boundary. This is the only extension path for infrastructure implementations such as an
S3-compatible Media Storage Provider, a future LDAP/SCIM/Entra Directory Provider, or a translation
unit ([TRANSLATIONS.md](./TRANSLATIONS.md)); a private loopback HTTP route, dynamic import, or
Module-owned adapter is not an alternative.

Each manifest descriptor declares:

```text
service kind
package-qualified provider key
interface digest
runtime factory export key
required Core capabilities
```

The runtime exports the matching factory map. Core resolves a factory only after validating the static
manifest, unique `(service kind, provider key)`, interface digest, Add-on and Site activation,
configuration, secret availability, migration state, and local instance readiness. The factory receives
a restricted server-only service context and schema-validated profile configuration; it never receives
arbitrary database or secret access.

A service-provider descriptor is not a Module binding and is not inserted as a second implementation of
one uniquely owned capability. A Core-bound Module calls its Core domain service; Core selects the
configured service implementation internally. Multiple Storage Provider implementations may therefore
coexist without changing the rule that one Module binds to exactly one Add-on or Core.

A Media Storage Provider states how a Client is to deliver an upload body, as a typed plan, and settles
the staged object when the Client reports it done. Core never assumes a transport on a Provider's behalf,
and an Add-on never gains a browser endpoint or a second upload lifecycle of its own; `init` and
`finalize` stay Core routes for every Provider.

Provider data remains bound to the concrete provider/profile identity that created it. Disabling or
removing a Provider preserves that binding and fails closed; Core must not reinterpret it through a
fallback Provider. Storage-specific profile, upload, delivery, and migration rules are normative in
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). User/group Directory bindings, scoped synchronization,
and assertion provenance are designed in [DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md).

### Jobs

A job is declared as `{ id, handler, suggestedInterval? }`, where `handler` names an entry in
`jobHandlers`. It is run by `phis addon job --addon <id> --job <job id> --site <site key>`, which posts to
the serving instance's internal `/api/v1/addons/jobs` route. It is not scheduled by Core, and the interval is documentation for the operator
rather than a promise: `@phis/server` serves from several instances, so an in-process timer would fire once
per instance for one intended run, and every Add-on would have to defend against a concurrency nobody
asked for. The operator's own scheduler is one runner by construction.

**A job has no actor.** It is the Add-on acting on its own data, not a person acting through it, so the
row-level ladder has nobody to apply and `data:v1` writes with system authority. A job context carries
`addonId`, `jobId`, `runId`, `site`, `capabilities`, and `signal`. That is
exactly why a job is reachable only through the internal-token route and never from a request: an Add-on
able to start its own job from a handler would have built itself a way around the ladder.

The job runs in the serving process rather than in the CLI, against the release that instance actually
serves. The CLI stays a caller instead of becoming a second runtime that would have to reproduce the
loader, the pool, and the capability bindings.

### Events

A job is the Add-on asking. An event is Core telling.

An Add-on declares `eventHandlers: [{ id, event, handler }]`, where `event` is one of
`thread.message.created`, `thread.message.updated`, `thread.status.changed`, `thread.link.removed`, and
`handler` names an entry in `eventHandlers` on the runtime. One handler per event: two would need an
order Core does not define, and an Add-on wanting two things to happen can do both in one function where
the order is visible.

**Declaring an event is not receiving it.** An event reaches an Add-on only for a thread the Add-on
holds a `Synced` resource link to -- the same predicate that decides whether it may read that thread at
all. Delivering every thread event to every declaring Add-on would be the Site-wide listing `threads:v1`
refuses, arriving by push instead of by pull. A message the Add-on itself imported is never handed back
to it, which is what stops an echo.

Core writes the row in the transaction that caused it (`phis.addon_event_outbox`) and dispatches after
the commit. The request that caused it tries once and reports nothing -- the person was writing a
message, not operating an integration -- and `phis addon job run` drains what is still owed before the
job it was asked for. Delivery is in key order and stops at the first failure for that Add-on and Site,
because events about one thread are a sequence and applying them out of order leaves a state that never
happened.

An event context carries `addonId`, `event`, `deliveryId` (the outbox key, stable across retries),
`site`, `subject: { threadId, messageId }`, `capabilities`, and `signal`. Like a job, it runs with no
actor and system authority: Core is telling the Add-on about a thread it is already allowed to reach.

## 11. Deployment and Site activation

Code availability and Site use are separate states.

### Deployment state

Only `phis-cli` controls:

- installed package and version
- ABI compatibility
- migration state
- presence of the artifact in the install root, and its digest
- global enablement or emergency disablement
- release, manifest, and artifact digest

### Site state

An authorized Site administration surface may manage only an already installed and globally available
Add-on for its own Site. No such surface exists yet; the operator writes this state with
`phis addon site` and `phis addon config`:

- requested enabled/disabled state
- Site-scoped non-secret configuration
- provider installation/account mapping
- authorized OAuth or provider setup flow

A Site cannot install code, choose a package version, execute migrations, alter descriptors, read
secrets, or configure another Site.

### Effective state

An Add-on is effective for a Site only when:

```text
present in the local install root with a matching digest
AND globally enabled
AND registry reconciled
AND migrations applied
AND Add-on ABI compatible
AND Site requested enabled
AND required Site configuration valid
```

Disabling it for a Site stops Site-scoped routes, jobs, hooks, and capability projection for that Site.
It does not delete data, secrets, provider installation records, or migration history.

### Asking for an Add-on on a Site

Three switches stand between an artifact on disk and a handler that answers, and they are three
decisions by, in general, three different people:

| Switch | Where | Command |
| --- | --- | --- |
| the instance has it | desired state | `addon install` |
| the instance allows it | `server_addons.flags` | `addon enable` |
| the Site wants it | `site_server_addons` | `addon site --site … --enable` |

`addon config` and `addon storage` refuse a Site that has not asked for the Add-on and say that it
has to be enabled first. Enabling for a Site also creates the groups the manifest declares; disabling retires them.

What a Site asks for and what it gets stay separate columns. `effective_status` depends on the artifact
loading, the capabilities resolving and the configuration being complete, and writing it beside the
request would make it a guess.

`effective_status` is written by `reconcile` and read by no decision. Everything it could say is worked
out by the capability snapshot from the sources that determine it -- desired state, registry, digests,
migration level, request, configuration -- and reading a stored verdict back on top would make the
answer depend on when it was last written. It is a diagnosis an operator can read without reproducing
that reasoning.

`configuration_status` is derived rather than declared: a setting either has a value an operator wrote
or a default the manifest states, and an Add-on that declares nothing configurable is ready the moment a
Site asks for it. It is re-derived after every change, because clearing a setting can take a Site back
out of readiness and a status that only ever moves one way is one that lies.

### The Module half comes first

A manifest may name the Modules its package's other half contributes, and that is the one thing Core
cannot read off an artifact: whether a Module half exists at all. One package carries one product, so
the package name is the manifest's own and there is nothing to resolve.

**Enabling an Add-on for a Site requires that half to be there already.** The order is the opposite of
[DISTRIBUTION.md](./design/DISTRIBUTION.md), section 6, and there is no contradiction: that section is
about installing into an instance, this is about switching on for a Site.

The order costs nothing and removes a state. A Module whose Add-on is not enabled for the Site
deactivates itself -- the capability snapshot is per Site, and an unavailable provider drops the Module
out of routes, controllers, widgets, layouts and providers while its selection stays recorded. So the
Module can be installed and built first, harmlessly, and enabling is then the cheap step that takes
effect at once with no second build behind it. Enabling first would leave a Site with routes and no
surface until somebody remembers to build, and disabling first would leave a surface calling routes that
are gone.

`--without-module` enables the server half on its own, for the case that is genuinely meant.

Disabling needs no such rule: the Module deactivates itself the moment the Site's request is withdrawn,
so there is no window to protect. Removing it for good is `phis module del` and a build, in that order
and at leisure.

**A Service Provider is refused for a Site that never asked.** `resolvePhisServiceProvider`
(`src/lib/addons/services.ts`) checks the Site's request for the providing Add-on. The Site is taken from
the Storage Profile, whose `site_id` is `NOT NULL`, so no caller has to remember to pass it and none can
drop it by omission.

## 12. Persistent registry

The database stores operational state but never acts as a code loader.

The registry represents at least:

### Installed Add-ons

- logical Add-on id
- physical package name and version
- Add-on ABI version/range
- migration version
- manifest digest
- release/build id
- global enabled state
- installation, upgrade, activation, and disable timestamps

### Capabilities

- provider id
- capability id
- capability interface version
- interface/descriptor digest

### Site Add-on state

- Site id
- Add-on id
- requested enabled state
- configuration status and version
- provider installation/account reference
- effective status and diagnostic code

Secrets are not stored in registry records. A registry row carries the reference and the
configuration-state marker; the encrypted store described in section 16 is a separate table with
its own access path, and reading it is never part of reading the registry.

Persistent boolean state follows the existing `@phis/server` table convention and occupies explicit
bits in `flags INT` columns. Schema, configuration, and migration counters use `SMALLINT`; package
versions, capability interface versions, and release ids remain independent string identities.

Initial flag assignments are:

```text
phis.server_addons.flags       bit 0 = globally enabled
phis.site_server_addons.flags  bit 0 = requested enabled for Site
phis.server_instances.flags    bit 0 = ready
```

Write authority is fixed:

- `phis-cli` writes installation, version, migration, release, and global state.
- `@phis/server` startup/reconciliation writes observed build and instance state.
- authorized Site administration writes only its Site's permitted enablement and configuration state
  (no such surface exists yet; see Status).
- normal Site clients have no registry mutation authority.

Package version, Add-on ABI version, capability version, migration version, and release build id are
independent version axes and are never inferred from one another.

## 13. Core capability registry

### A capability name is frozen once it is public

The version lives inside the id, and it covers the shape, not the name. Renaming the name half of
`@phis/server/<name>:v1` produces an id that was never offered, which to every consumer looks like a
capability that does not exist -- no version moved, so nothing signals a break.

A Module requiring a renamed capability deactivates itself, exactly as the contract says it must, and
the Site silently loses what that Module contributed -- a login route, for example.

From the first public release of `@phis/server`, a capability name may only gain a successor beside it, never
be replaced in place. An installation that updates `@phis/ui` and `@phis/server` independently through npm
has no other protection: they agree on capability ids and on nothing else.

`phis site check --key <site key>` compares what a Site's Modules require against what its server offers
and names the Modules that lost theirs. The comparison happens in the Site, because `@phis/server` does not
depend on `@phis/ui` and cannot know what a Site requires. It reports the running Site, so it is the check
to run after an update rather than a prediction about one.

Core participates in the read-only discovery model as:

```text
@phis/server/core
```

The Core capabilities are the ones `PHIS_CORE_CAPABILITIES` in `@phis/contracts` names
(`phis-contracts/src/core.ts`), and that package owns the spelling. Every id in it appears in the Core
capability snapshot a Site's Modules are resolved against. Only the ones marked delivered are bound to an
Add-on's context (`src/lib/addons/core-capabilities.ts`); an Add-on requiring any other is refused at
dispatch, by the job runner, and when its service factory is resolved.

| Capability | Delivered to Add-ons |
| --- | --- |
| `@phis/server/authentication:v1` | no -- required by Core-bound Modules only |
| `@phis/server/authorization:v1` | yes |
| `@phis/server/data:v1` | yes |
| `@phis/server/threads:v1` | yes |
| `@phis/server/resource-links:v1` | yes |
| `@phis/server/support:v1` | yes |
| `@phis/server/groups:v1` | yes |
| `@phis/server/storage:v1` | yes |
| `@phis/server/assets:v1` | yes |
| `@phis/server/secrets:v1` | yes |
| `@phis/server/settings:v1` | yes |
| `@phis/server/roles:v1` | yes |

Core descriptors are generated from the running release and reconciled into the registry. They are not
editable Site settings and cannot be disabled per Site.

### `authorization:v1`

It answers "may this actor", in the
three places that question is decided: does the row belong to them, what level do they hold in its
group, and what may they do on this Site at all.

```text
mayActOnRow({ table, id, intent })  -> boolean
groupLevel(groupId)                 -> "member" | "author" | "editor" | "manager" | null
hasSiteAccess(access)               -> boolean
```

`mayActOnRow` is the reason it exists. `ownerScoped` and `groupScoped` mean Core wrote `owner_user_id`
and `group_id` on that table, so Core reads them back and applies the ladder itself. The Add-on names a
row and an intent and never reproduces the rule -- which is what keeps one rule from becoming one
implementation per package, each with its own mistakes. The schema is derived from the calling Add-on,
so `table` can only ever address one of its own; a name that is not in its manifest never reaches a
query. A table with neither scope answers false to everything: absence of a scope is not absence of a
restriction.

Both scopes require `siteScoped`, and `siteScoped` itself is stated rather than defaulted. Core weighs a
person on a Site everywhere it weighs one at all -- an authorization is read as a pair, and a disabled
membership answers no -- so ownership without a Site would be the one place that pair comes apart, the
same account reaching a row from a Site it was never admitted to on a comparison that looked at nothing
but a user id. And a table saying nothing at all about the Site would be the instance-wide one, which
makes silence the permissive answer in the one descriptor where it is permissive nowhere else. A table
that genuinely belongs to the Add-on rather than to a Site -- a category list, a currency table -- says
so with `false`.

A reference into a Site-scoped table is bound together with its Site, the way a group reference is:
Core writes `(column, site_id)` against the target's `(key, site_id)`, lays down the unique key that
pair needs, and requires both tables to be Site-scoped. The Site filter guards what a query *reads*; it
does not guard what a value *points at*, and an insert naming another Site's row by id is an ordinary
write that no declaration would show.

`groupLevel` names the level instead of returning the bits. The numeric ladder stays Core's, so no
installed Add-on can come to depend on a value, and `hasSiteAccess` takes a symbolic access name rather
than a role flag for the same reason.

**It answers and grants nothing.** There is no operation here that changes a role, a membership, or an
owner, and there must not be one -- a single Capability declaration would otherwise be permission to
rewrite the authorization model instead of permission to consult it. Writes stay routes with their own
authority.

Two neighbours it is deliberately not: `authentication:v1` is who the actor is, and is spelled out
rather than shortened to `auth` because the shortening would sit one letter from this one and mean the
opposite half of the same word. `groups:v1` is group *facts* -- which groups exist, who is in them --
while what follows from them is decided here.

### `data:v1`

Running the queries the manifest declared. Five operations and a unit of work, and every call names a
query rather than describing one:

```text
select(name, args)     -> a page of rows
aggregate(name, args)  -> a page of counts and summaries
insert(name, args)     -> the inserted row, scope columns included
update(name, args)     -> the row as it now stands, or null
delete(name, args)     -> the removed row, or null
transaction(body)      -> whatever the body returns
```

There is no method taking SQL, a table, or a condition. An Add-on that could pass one of those at
request time would be holding a database handle with extra steps, which is what section 15 rules out.

Three things Core does here that an Add-on cannot influence:

- **The Site filter is in the statement, not in the caller.** Every compiled statement against a
  Site-scoped table carries it. That is what `siteScoped` promises beyond a column and a key: not that
  an Add-on remembers to filter, but that it has no statement in which the filter is missing.
- **The scope columns are written by Core on insert.** The descriptor has nowhere to name `site_id`,
  `group_id` or `owner_user_id`, so there is no form of the statement in which an Add-on picks its own
  Site, group, or owner. The Site and the owner come from the bound context; the group comes from a
  declared parameter, because a row may belong to any group -- and the row-level check refuses one the
  actor is not in. They stay readable: "the rows that are mine" needs `owner_user_id` by name.
- **`update` and `delete` are checked before they run.** Both address exactly one row by its primary
  key, and Core applies the same row authority `authorization:v1` answers with. A refused mutation
  answers `null`, which is also what a missing row answers: telling the two apart would report the
  existence of a row the caller may not have.

  Every mutation answers with the row it wrote, and `null` for that same pair of refusals -- which
  withholds exactly as much, since a row comes back only where the write actually happened. On an
  `update` that is the row as it now stands rather than the values that were sent, and the two part
  company wherever a default, a constraint, or a column the query did not name had a say. On a `delete`
  it is the only moment those columns can be had at all: a row naming an object in the Add-on's store is
  the last record of that object, and once the statement has run there is nothing left to ask -- the
  bytes would stay, counted against the quota, belonging to nobody. Where the file was declared as an
  **asset** that question does not arise: Core takes the row's files with the row, down to the objects
  behind them. See *When the row goes* under `assets:v1`.

`mayActOnRow` and this enforcement answer the same question on purpose. The capability is for deciding
what to offer a user -- whether to render the delete control; the write path is what actually holds. A
check an Add-on has to remember to call is one that eventually is not called.

The transaction handle offers the same five operations and nothing else: no commit, no rollback, no
savepoint. Returning ends the unit of work, throwing undoes it, and an Add-on cannot leave one open
because it never holds the thing that would stay open.

The vocabulary is poorer than the schema descriptor's in one further way: **there are no joins.** A
join to a Core table would make the kernel's shape an installed Add-on's dependency, and a join between
two Add-ons' tables is already forbidden. A read is bounded by a required `limit`, capped at 500 --
"the caller will pass a sensible one" is not a bound. `LIKE` is absent for the reason regular
expressions are absent from the schema descriptor: escaping and collation differ between database
systems, and taking it would buy back the dependency the descriptor exists to remove.

### `storage:v1`

A private object store for one Add-on on one Site: `put`, `get`, `head`, `remove`, `list`, `usage`.

Keys are the Add-on's own and relative. Core puts them under a prefix it derives from the Add-on id and
the Site key, and never hands the physical key back -- so there is no address an Add-on can store,
guess, or be tricked into passing, and another Add-on's objects are unreachable by construction rather
than by a check. The same rule the install root follows: a stored string never becomes an address.

The bytes go through the Site's configured Storage Provider, so an operator who moved a Site to S3
moved its Add-ons with it. The Site's `max_object_bytes` bounds a single object, because one limit is
easier to reason about than two.

Both directions are streams. A release artifact and an export waiting to be fetched are the two uses
here that grow, and a buffer would have made the largest object a Site allows the memory one call costs
on a path that only moves bytes. `put` therefore takes a `ReadableStream` and a declared `byteSize`, and
`get` answers with one; an Add-on that already holds its bytes wraps them in a one-chunk
`ReadableStream`.

The size is declared because the ceiling is booked before a byte is written -- nothing can be booked
that has not been stated. It is not taken on trust: Core counts while it writes, ends a body at the
first byte past what it claimed, and refuses one that turns out shorter, removing the object and the
booking together. A write that overwrote something has already destroyed it by then, which is why a
refused write leaves the key empty rather than restored.

What the store may hold in total is bounded separately, per Add-on and per Site, in bytes and in
objects -- two hundred thousand small files cost a listing, a backup and a provider bill even when the
bytes are unremarkable, and no byte limit says so. The operator sets both with `phis addon storage`;
`null` is no ceiling and is not the same as zero, which is a store that may hold nothing.

The ceiling is Core's, not the Add-on's: a package that could check its own limit could equally not
check it. A `put` is booked against the total before the bytes are written and given back if the write
fails, in one conditional statement -- two writes arriving together would otherwise both read the same
figure, both find room, and both proceed. An overwrite costs the difference and no object, so an Add-on
that rewrites one file each hour is not charged as though it kept every version.

A purge removes the objects too, after the rows and never before them: the rows are one transaction and
the bytes are not in it, so if the storage then refuses, what is left is objects nobody references --
untidy, findable, removable later. Removing the bytes first would lose them whenever the transaction
rolled back. The Sites are read before the purge, because `site_server_addons` is one of the tables it
empties. Disabling an Add-on for a Site keeps its objects, as it keeps its tables.

`phis addon storage --recount` sets the counters to what the store actually holds. They are a running
total and can drift -- an object removed with a bucket client, a Provider migration, a write the storage
accepted after Core had given the booking back. A ceiling reached by drift refuses writes against space
that is free, and the error mentions the ceiling rather than the reason. It is a command rather than a
background pass because it costs a full listing of the prefix.

`phis maintain` (task `addon-storage`) runs the same recount for every Add-on store the operator's
process can reach, and names the ones it cannot. It is the answer to the one drift `put` itself causes:
two writes of one new key at the same moment -- a retried request, an event delivered twice, a job on two
instances -- both find the key absent and both book an object. Preventing that would cost every write a
lock or a row per object; counting again repairs it together with every other drift. A write in flight
while a store is listed is left out of that figure, which errs towards room and is counted next time.

Objects an Add-on no longer refers to are its own business here. This capability hands out a key space
the Add-on manages, and no row of Core's describes what is in it, so which objects still matter is a
question only the Add-on can answer -- a declared job is where that answer belongs.

Declared **assets** are the other case and they are not in this key space at all: they are Media Assets
in the Add-on's own Space, so a row names each one and `phis addon storage --sweep` finds the ones
nothing points at with a join rather than a bucket listing. They arise because the cascade only runs one
way -- removing an Add-on's parent row takes its link rows, and a file is not the Add-on's to cascade.
The sweep clears expired upload reservations in the same pass.

`usage()` is what an Add-on may do with the figures: read them. It exists so a refusal can be explained
before it happens rather than arriving as an error, and a vendor who can see they are at their limit
does not file a bug about it.

This is not the Media library. What a person uploads, browses, and references belongs in a Media Space
with its folders, quotas, and delivery policies. This is what an Add-on keeps for itself: a release
artifact, a generated preview, an export waiting to be fetched.

### `assets:v1`

Filling the slots a table declared. The schema descriptor says where a file may go; this is how one gets
there.

```text
begin(table, ownerId, slot, contentType, sizeBytes, sha256?, filename?)
                                 -> a reservation token and a delivery plan
finalize(table, token, completion?) -> the finished file
abandon(table, token)               -> gives an unredeemed reservation up
list(table, ownerId, slot?)         -> the files of a row
remove(table, id)                   -> takes a file out of its slot, and the file with it
usage()                             -> what the Space holds, reserves, and is allowed
```

**This is not a second upload lifecycle.** Core reserves, receives, measures and hashes without knowing
who asked; the purpose stated at `begin` is read back at the last step, where the finished object becomes
a Media Asset and a link row. The reservation is an ordinary Media upload session, delivered to the
ordinary Media upload route.

**No method takes an object key and none returns one.** A key an Add-on chooses is a key Core cannot
recognise later, and an object Core cannot recognise is one it can neither deliver nor account for. What
comes back is a Media Asset id, which a delivery URL is built from.

`begin` refuses where the slot is not declared, where the media type is not one it takes, where the size
is over the slot's ceiling or the Site's, where the Space is full, and **where the acting user may not
change the row**. That last one matters: putting a file on a row changes it, so it is the row's own
authority that decides. Without it this would be a second, quieter way past the ladder -- a caller who
may not edit an offering could still hang a package off it, which is editing it by another name.

**The space is charged when the place is made, not when it is used.** A ceiling decided at the end would
bound the bookkeeping and not the store: ten clients could each write a gigabyte and have five of them
refused afterwards, with the bytes already paid for. Reserving is one conditional statement, so it is
also the check -- read the total, find room, then write, and two uploads arriving together both find the
same room.

`sha256` is the client's statement of what it is about to send. Where the Storage Profile's probe found
the endpoint verifies one, it is **signed into the presigned request** and the endpoint refuses anything
else -- so a wrong digest never becomes an object, and Core records the client's figure as true because a
wrong one would not have got that far. Where it was not, the plan routes the body through Core, which
hashes it in flight. Either way the digest is established rather than asserted, and where neither holds
nothing is recorded: `checksum_algorithm` and `checksum_value` stay null. An `etag` is an HTTP header,
and a recorded SHA-256 that is really an MD5 is worse than no checksum.

Above a single PUT that stops being true -- a multipart object's `ChecksumSHA256` is a composite of the
part digests and not the hash of anything. It does not arise under the two-gigabyte slot ceiling, which
is why the ceiling is worth keeping there.

`finalize` looks at the object rather than believing the report: nothing there is not a file, and a
different size than was reserved is not one either. On a single-valued slot the file being replaced goes
in the same transaction, and the reservation goes with it: while its row exists the bytes are held,
once the file is settled they are used, never both. A second `finalize` with the same token therefore
finds no reservation and is refused. A client whose answer was lost asks `list` whether the file is
there -- the finished row is the record, not the reservation that produced it.

As on the Media route, a reservation past its expiry is refused and released rather than redeemed (its
bytes are already discounted from the Space), a proxied body must have been recorded as arrived, and only
one `finalize` per token gets past the claim. The object is looked for in the Storage Profile the
reservation was made in, not in whatever the Space's default has since become.

#### The path on the row

A one-valued slot may name a **mirror column**, and Core keeps that slot's delivery path in it: written
when a file is settled, rewritten when a file replaces it, cleared when it is taken away.

Without one, showing a row's picture means asking for its files -- one question per row, so a page of
fifty costs fifty, and a public listing pays it on every request. With one the path arrives with the row,
in the statement that was being run anyway.

The column is Core's on both ends. It is created from the declaration rather than by the Add-on, it is
readable in a declared query like any other column, and no declared query may assign it -- a row that
could name its own file could name somebody else's. The path is kept rather than the Media Asset id
because a delivery path carries the cache revision, and reading that back would be the join the mirror
exists to avoid.

Only on a slot that holds one file. A slot that accumulates has no single path to mirror, and a column
holding the newest of several is a fact nobody asked for.

#### When the row goes

An Add-on never has to take its files away first. `data:v1`'s `delete` does it, and the order is the
whole of the design.

The links are read **before** the statement, because the foreign key takes them with the row and
afterwards there is nothing left to ask. The statement runs and may still refuse -- a delete the ladder
turns down comes back as a silent zero -- and only a row that actually went releases anything, because
files destroyed for an act that did not happen cannot be put back. The Assets, their variants and the
Space's figures then go in that same transaction, so a rollback takes the release with it.

The store is touched last and alone, because it cannot take part in a transaction. That is the one gap
no ordering closes: the moment the Asset row is gone, the storage key is gone with it, and a process that
dies before the object does leaves a file that nothing can name. So the key is **written down inside the
transaction** -- `phis.media_discarded_objects` -- and the removal that follows clears the note. What
stays there is a retry list, read by an index, drained a few at a time by whatever deletes next.

`phis maintain` (task `addon-assets`) asks the other question: which Assets in an Add-on's Space does no link name. The
note says what Core meant to remove; the join says what is actually unreferenced, and it is the only
thing that catches what no note was ever written for -- a restored backup, a schema dropped by hand, an
Add-on removed with its tables. It is the audit, not the mechanism.

### `secrets:v1`

`read(name)` and nothing else. The owner and the Site are bound, so another Add-on's secret cannot be
named, and the resolver checks the owner a second time because a wrong binding and a wrong argument are
different mistakes.

There is no writer, and there should not be one. An operator sets a secret with `phis secret set`; a
package that could write its own could plant one, and the store would stop being the operator's record
of what they configured.

### `groups:v1`

Group facts, bounded by the acting user: `myGroups()`, `members(groupId)`, `user(userId)`, and
`declared()`, which lists the groups this Add-on's manifest declared on this Site with their ids. Where
the manifest declares a `groupWriter`, the same object also writes this Add-on's own groups (see *Groups an
Add-on makes as it runs*).

One rule decides every read about people -- **an Add-on sees what its actor sees.** Every answer is one the acting
user could already have obtained through the Site's own group routes, projected exactly as those
project it: a display name, a company only where the group's own flag discloses it, and never an
address. That decision belongs to the group's Manager, and an Add-on inherits it rather than being
asked separately.

`user(userId)` answers null for somebody the actor shares no group with. That null is the point of the
method: it is what stops a row's owner id from becoming a lookup into a Site's whole user table. An
Add-on renders "listed by" and learns nothing else.

#### Groups an Add-on declares

An Add-on may declare the groups it needs in its manifest's `groups`, by key and name, and Core creates
them on every Site that asks for the Add-on. Who is in a declared group stays with whoever administers
the Site: without a `groupWriter`, `groups:v1` only reads, so a package cannot hand out standing.

The group lives in `phis.site_groups` beside Core's own, told apart by `provider_id`. That is what makes
it work everywhere without a second mechanism -- the ladder, the membership projection and the Site's
group administration all read one table, and an Add-on's group is a group like any other. Core already
filters group claims against the available providers, so a group belonging to a removed Add-on stops
granting anything without anybody having to clean up.

Groups are created when a Site asks for the Add-on, and caught up on `reconcile` for Sites that already
run it -- a new release may declare a group its predecessor did not. Removal retires rather than deletes:
a membership is a statement about a person made by whoever administers the Site, not the Add-on's data,
and uninstalling a package must not quietly undo fifty of them. A retired group grants nothing either
way, and a re-enabled Add-on finds its members still there.

#### Groups an Add-on makes as it runs

The `groups` list in a manifest is for the groups a Site always has -- known when the manifest was
written, created per Site when the Site asks for the Add-on. `groupWriter: { allowedBy }` is for the
other kind: one per vendor, per team, per tenant, whose number and names nobody knew in advance. It adds
four methods to `groups:v1`:

```text
create({ key, name })                    -> the group, made or already there
addMember({ groupId, userId, level })    -> boolean
removeMember({ groupId, userId })        -> boolean
retire({ groupId })                      -> boolean
```

It is a **declaration** rather than a capability an Add-on simply has, for the reason `grantableBy`
exists: the manifest is covered by a digest the running code cannot rewrite, so the author states who
may cause a group and Core decides whether the condition is met. Without it, "an Add-on may make groups"
would mean "an Add-on may make itself an authority container and fill it". `allowedBy` has the policy
shape a role's `grantableBy` uses, is evaluated by the same function (`satisfiesPhisAddonGrantPolicy` in
`src/lib/addons/role-granting.ts`), and has the same Site Admin floor. `addMember` also refuses a user who
is not a member of the Site.

**Ownership bounds the rest.** A group made here carries the Add-on's id as its provider, and every
write checks that before it writes: group ids are integers out of one table, so without that check an
Add-on could administer Core's groups and another Add-on's by guessing a number. Membership rows carry
the Add-on as their source too, which is what keeps them apart from the ones a Site administrator wrote.

`create` is an upsert, because asking twice is how an id is learned: the key is the Add-on's to choose
and the id is the database's to assign. `retire` is not a delete -- access policies are serialized
against the provider-qualified key, and releasing it would let a later group of the same name inherit
them.

Nothing else changes: it is `phis.site_groups` with a different provider, so the ladder, the membership
projection and the Site's group administration all keep reading one table. Core already filters group
claims against the available providers, so one of these stops granting anything the moment the Add-on is
gone -- and comes back with it, members included.

### `threads:v1`

Core's threads, bounded by whoever is behind the call: `list`, `get`, `create`, `reply`,
`addParticipants`, `setStatus`, `markRead`, `findByExternalRef`.

**With an actor** the rule is the one `groups:v1` states, for the same reason -- an Add-on sees what its
actor sees. A thread is visible to its participants, and a group participates as a group, so its members
are resolved when the thread is read. Every read here goes through that same predicate; there is no
listing that steps outside it. An author is projected as `groups:v1` projects one: a display name and a
company, never an address.

**Without an actor** -- a job, a verified hook, an event handler -- the Add-on reaches the threads it
owns and the ones it is linked to. It owns what it opened with nobody behind it. It is linked to a
thread when a `resource-links:v1` row of its own carries `Synced` and points at that thread, at a
ticket, or at a ticket task whose thread it is, and that row was written by a person who could see the
thread. The link is that person's consent for one integration and one conversation, and unlinking ends
it. There is still no listing: an actorless Add-on arrives at a thread through the reference it
recorded, never by walking.

`list` and `markRead` are the two an actorless Add-on is refused, because both are questions about
somebody's own inbox.

What is withheld either way: an `Internal` message never reaches an Add-on, and a `Confidential` one
arrives with its text removed and its flag set, so an interface can say why there is nothing to show --
and with the text goes what hung on it, because an attachment travels inside the message rather than
beside it.

`create` and `reply` take `assetIds`, files from the Add-on's own Space written through `assets:v1`.
Custody follows whoever the write is attributed to: acting for a person an Add-on attaches that person's
files, acting as itself its own, and neither reaches into the other's Space. Who may read one is the
message's answer and never the Space's, so a file an Add-on attaches is read by everyone in the
conversation, and one it is shown does not thereby become its own.

### `resource-links:v1`

References from a Phi record into an Add-on's own system: `list`, `link`, `setState`, `unlink`,
`findByExternalId`. The subject is a thread, a Support ticket, or a ticket task.

Bounded twice. The provider is closed over, so an Add-on reads and writes its own links and sees no
other's -- two integrations on one ticket do not have to know about each other, and removing one takes
its references with it. And a subject has to be one the acting user may reach, asked of the subject's
thread, because there is one answer to "may this person see this conversation".

**Writing needs an actor.** A link is a person saying two records belong together, and it is that
statement the actorless reach above rests on; a hook that could write its own would be granting itself
the access the link is supposed to confer.

### `support:v1`

The workflow record around a conversation -- the type, the queue, the status, the work: `get`,
`findByThread`, `create`, `listTasks`, `addTask`, `setTaskStatus`. It exists so a package in its own
repository can reach a Site's tickets without depending on `@phis/support`, which is only the Module;
the tables and the rules are Core's.

Reach is the thread's answer and never a second one: a ticket is readable exactly when its thread is,
which for an actorless Add-on means the two ways above -- it opened the thread, or somebody linked it
and marked the link synced. There is no listing and no search, for the reason `resource-links:v1` has
none.

**It does not move a ticket's status.** An issue completes its task, and whether that finishes the
Support work depends on the type's close policy and on the other tasks -- which an integration cannot
see all of. A type and a queue are named by key rather than by id, because an id means nothing in an
Add-on's configuration; a key that names nothing is refused rather than quietly routed elsewhere.

### `settings:v1`

`read(name)` and `all()`. What an operator configured with
`phis addon config --addon <id> --site <key> --name <setting> [--value <value>]` (without `--value` the
setting is cleared; without `--name` the command lists the settings), stored in
`site_server_addons.configuration_json` -- the row that already says whether the Add-on runs on that
Site, which is where what it runs with belongs.

Distinct from `secrets:v1` on purpose: a commission rate is not a credential, and asking the secret
store to hold one would make what is configured unreadable to the operator who configured it.

The declared descriptors are the shape of the answer, not the stored row. A value nobody set falls back
to its declared default; a stored key nobody declares is ignored; a stored value of the wrong type falls
back rather than being handed over. An Add-on therefore reads exactly what it declared it would read,
whatever has accumulated in the column across versions. As with secrets, there is no writer.

### Add-on roles

`roles:v1` answers `has(role)` and `all()` for the acting user. The roles themselves are declared in the
manifest, assigned in Core, and checked in three places: the handler, a declared query, and a browser
access policy.

#### Three questions, three mechanisms

An Add-on that governs who may do what is always asking one of three questions, and answering all three
with one tool is the mistake:

| Question | Answered by |
|---|---|
| May this person do this **at all**? There is no row yet. | **Role** |
| May this person touch **their own** row? | **`owner_user_id`** |
| May several people share a row, each to a different depth? | **Group** and its ladder |

The test: does the question concern a particular row? If not, it is a role. If yes and only the creator
should reach it, ownership settles it. If yes and several people share it at different depths, it is a
group.

**A group is Core's vocabulary about shared rows; a role is the Add-on's vocabulary about actions.**
Whatever Core evaluates has to be Core's word. The ladder's four levels are interpreted by
`mayActOnScopedRow` (`src/lib/addons/capabilities.ts`): Author means "may change what is theirs", Editor
"also what others wrote", Manager "also remove it". Core can apply that only because it knows what the
words mean. Roles are opaque to Core by design: it stores them, answers `has()`, and compares a name. The
ladder also hangs on the group while a role hangs on the Add-on, so the same person is Editor in one
group and Member in another -- a dimension a role does not have.

What already holds without any role:

- Core writes the scope columns on insert, and a query descriptor has nowhere to name them, so an Add-on
  cannot issue a row in somebody else's name.
- Ownership works without any group. On a table that is `ownerScoped` and not `groupScoped`, the owner
  reads and writes their rows and nobody else does.
- A group means "everyone in here reads everything in here": a Member reads every row of the group. This
  decides who may be put in a group -- never a customer, for instance.
- An insert that names a group is refused unless the actor stands in it, loudly rather than silently: a
  swallowed insert would look to the Add-on exactly like one that happened.
- `data:v1` enforces the ladder on `update` and `delete` before the statement runs, whether or not the
  Add-on declared `authorization:v1`.

#### Declared in the manifest, held by Core

```ts
roles: [
  { name: "market-admin", grantableBy: { siteAccess: "site-admin" } },
  { name: "vendor",       grantableBy: { role: "market-admin" } },
  { name: "reviewer",     grantableBy: { role: "market-admin" } },
]
```

A role is `{ name, description?, grantableBy }` (`PhisAddonRoleDescriptor` in `@phis/contracts/addon`).
`name` matches `^[a-z][a-z0-9-]{0,63}$` and is frozen from the first assignment: a grant is stored as
text, and text does not follow a rename. `grantableBy` names exactly one of:

- `{ siteAccess }` -- one of the Site accesses in `PHIS_SITE_ACCESS`: `site-admin`, `developer-tools`,
  `structure-authoring`, `content-editing`, `publishing`, `site-media`, `support`, `accounting`
- `{ role }` -- another role this same Add-on declares

The same bargain as `settings`: the Add-on states its vocabulary, Core holds the assignments, and the
Add-on reads through `roles:v1` and never writes. There is no writer for the reason `settings:v1` and
`secrets:v1` have none -- an Add-on able to grant its own roles could grant itself whatever those roles
guard.

`grantableBy` is how an Add-on decides for itself who may hand out its roles, **declaratively**. It lives
in a manifest the digest covers, so the author sets the policy and the running code cannot rewrite it.
Manifest validation (`src/lib/addons/manifest.ts`) refuses a `role` that names a role the Add-on does not
declare, and refuses a role set in which no role is grantable by a Site access, because nobody could ever
enter such a set. A Site Admin may always grant any role of any Add-on, so a badly declared graph never
locks a Site out.

#### Where assignments are stored

```sql
CREATE TABLE phis.site_addon_user_roles (
  site_id            SMALLINT     NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id           VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT,
  user_id            INT          NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  role               VARCHAR(120) NOT NULL,
  granted_by_user_id INT          NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  granted_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, addon_id, user_id, role),
  CHECK (role <> '')
);
CREATE INDEX site_addon_user_roles_site_user_idx ON phis.site_addon_user_roles (site_id, user_id);
```

One Core table, not one per Add-on. That is what makes "what does this person hold on this Site" a single
question across every installed Add-on -- with a private table per package, offboarding means visiting
each of them. `role` is text rather than a foreign key: which roles exist is stated by the manifest, and
a role table beside it would be a second truth, drifting at the next update. The primary key serves the
runtime read; the index serves "what does this person hold, across all Add-ons".

`phis addon purge` deletes an Add-on's assignments. `phis addon remove` and `phis addon disable` keep
them.

#### Reading, and what a new version drops

`roles:v1` answers `has(role)` and `all()`, bound to the acting user of the request. No user id leaves
Core: the Add-on learns whether, never who. Without an actor both answer no.

Results are filtered against the roles the **current** manifest declares, the same way a stored setting
nobody declared is ignored rather than handed over. An Add-on never sees a role it does not know.

An assignment naming a role a newer version no longer declares is **kept**, never deleted: deleting would
be silent loss of access during an upgrade. `readPhisAddonOrphanedRoles` (`src/db/server-addon-roles.mts`)
lists such assignments per Site and role for the operator to decide on.

#### A role in a declared query

A declared query may state `requiresRole`, and Core refuses to run it for an actor who does not hold the
name. Core still learns nothing: it does not know that `curator` moderates, only that this query is for
whoever is one.

That is what makes a table nobody owns writable. Without an owner and without a group there is no row for
Core to judge, so the ladder answers no to every update and delete -- right for a row that should belong
to somebody, wrong for a catalogue, a rate table or a moderation note. Such an update or delete must state
a role, and validation refuses it otherwise. On an owned or grouped table the role narrows rather than
replaces: both have to be satisfied. `alsoAllowedByRole` widens instead, for moderation (section 15,
*Declared queries*).

#### Gating a surface on a role

A role reaches the browser too, so a Module can leave out a link somebody would be refused anyway.
`PhiViewerAccessPolicy` (`@phis/contracts/access`) has an `addon-roles` shape:

```ts
{ access: "addon-roles", providerId: "@acme/market", allowedRoles: ["vendor"] }
```

The held names travel with the viewer as `addonRoleClaims` (`/api/v1/auth/me`, reached through a Site's `/api/auth/me`), filtered to what the current
manifest declares and to Add-ons enabled globally and for this Site (`src/lib/addons/viewer-roles.ts`). A
viewer that carries no `addonRoleClaims` is denied. A Site Admin passes, as for every role and group
policy. A Module may name only its own Add-on's roles (`isPhiAccessPolicyProviderOwned`).

The evaluator is `canPhiAccessSubjectReach` in `@phis/contracts/access`, compiled once and used by both
`@phis/server` and `@phis/ui`.

**It is presentation, not protection.** Leaving a link out spares somebody a refusal; it does not make
the page safe. The request behind the link is decided again by the handler, against `roles:v1`.

#### Granting

`POST /api/site/addon-roles` with `{ addonId, role, userId }` grants; `DELETE` with the same body
revokes. Core resolves the descriptor from the installed manifest and evaluates `grantableBy` against the
acting user (`src/lib/addons/role-granting.ts`): a Site access through the ordinary access policy, a role
through `site_addon_user_roles`, and Site Admin always. Taking a role back needs the standing to have
given it. An unknown Add-on or undeclared role answers 404, a refusal on standing 403.

`GET /api/site/addon-roles` answers with every role of every installed Add-on the caller may grant, and
with `?userId=` also what that person holds -- the latter only for a caller who may grant at least one
role. One screen therefore serves an operator and a `market-admin` alike, because it shows what the
viewer could grant rather than what exists.

An Add-on's own surface renders the screen and calls these routes; it never decides the answer, so
somebody who reaches the screen without the standing is refused here rather than there. Finding the
person to grant to is not part of the role routes: `GET /api/site/groups/candidates` searches a Site's
people by name or address, but only for a caller who manages some group.

On the command line, `phis addon role --site <key>` lists what each installed Add-on declares
(`--addon` narrows it), `--user <id>` shows what one person holds across Add-ons, and
`--addon <id> --user <id> --grant <role>` / `--revoke <role>` set it. The operator is above the Site Admin
floor, because somebody has to appoint the first person who can appoint others.

#### A worked example: support

Customers must not be in the team group -- a group grants read on everything in it. And an insert into a
group-scoped table takes its group from a parameter, so a customer who is in no group cannot create such a
row. Both facts push to two tables:

```text
requests   siteScoped, ownerScoped     what the customer files
tickets    siteScoped, groupScoped     what a team runs
```

The customer files a `request`; Core writes `owner_user_id` from the bound actor, and only they can read
or change it. An agent accepts it and creates a `ticket` in their team, which they may because they are in
that group. The customer follows progress through a declared query filtered on the acting user, which Core
substitutes and the Add-on cannot aim at anybody else.

| Person | Role | Team A | Team B | Result |
|---|---|---|---|---|
| customer | -- | -- | -- | sees only their own requests |
| agent K | `agent` | Editor | Member | works A, reads along in B |
| agent O | `agent` | Member | Manager | reads along in A, closes in B |
| lead R | `support-admin`, `supervisor` | Manager | Manager | grants roles, everything in both teams |

K and O hold the **same role** and may do quite different things. That is the argument for the ladder
staying per group. The role covers what has no row: opening the agent workspace, accepting a request
into a team at all. The group covers which team's tickets and how deep. Ownership covers the customer.

#### Not part of this contract

- **Moving a row to another group.** The scope columns are absent from an update descriptor, and an
  insert into a group the actor is not in is refused, so a ticket cannot be escalated from one team to
  another. The shape such an operation would take is the one designed for Media Assets in
  [GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md), section 2: a named operation
  with its own guard rather than a generic endpoint, Core and Add-on each checking what they know, the
  client naming the occasion and never the target, and a durable record.
- **Binding roles to groups** as well as to users.

### Capabilities an Add-on supplies

Section 1 says a Capability is supplied by Core **or one Add-on**. A manifest states `capabilities`, the
registry records them under `provider_id`, and the capability snapshot reports per provider whether what
a Site's Modules require is offered. Nothing lets a second Add-on reach such a Capability; the design is
in [ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md), section 1.

## 14. Capability requirements and diagnostics

A Module's single server binding declares the capabilities and compatible versions it requires.
Resolution occurs server-side against the effective Site snapshot. A browser claim never proves server
availability.

Observable states are:

- `available`
- `missing`
- `disabled`
- `incompatible`
- `misconfigured`
- `unavailable`

When a required provider or capability is unavailable:

- the Module does not blindly start the affected Controller Client
- the affected widget or route renders a localized scoped diagnostic
- a deduplicated structured log records Site, Module, provider, capability, expected version, observed
  state, release id, and correlation id
- unrelated Modules, routes, and content continue to work

`phis-cli` validates known Module/Add-on compatibility during build or deployment whenever it has both
manifests. Runtime resolution remains mandatory to detect operational drift.

## 15. Database and migration boundary

Browser and Module code never receive database credentials, raw SQL, DDL, or an unrestricted query API.

Neither does an Add-on. An Add-on describes the tables it needs and the queries it runs; Core derives
the statements. That is what lets an Add-on outlive a change of database system, and it is what turns
most of the rules below from something checked afterwards into something that cannot be expressed.

Core domain services use Core-owned normalized tables. A trusted Add-on may own relational tables when
its domain requires them, subject to these rules:

- an Add-on ships a versioned, checksummed schema descriptor, never SQL text
- only `phis-cli` derives and executes DDL, with deployment migration authority
- normal runtime credentials have no DDL authority
- descriptor versions and applied state are persisted
- activation occurs only after required migrations succeed
- disabling never drops tables or rows
- destructive uninstall is a separate explicit operator operation
- cross-Add-on table access is forbidden unless exposed by an approved Core service

Separate credentials carry migration authority. The role a running instance serves requests with holds
no DDL grant, and the role `phis-cli` migrates with is not the role that serves.

### Keeping the Core schema current

`scripts/sql/001_create_phis.pgsql` is idempotent. The operator setup page applies it on the first
bootstrap; afterwards a release that adds a Core table reaches a running installation through
`phis schema`:

```text
phis schema check           what this release declares that the database does not have
phis schema apply           applies the script, and re-grants the Core reference tables
phis schema drop [--force]  drops every Add-on schema and then `phis`; without --force it only lists them
```

`check` and `apply` run as the **serving role**, from `database.uri` and deliberately not from
`database.migrationUri`: Core's tables belong to the serving role, exactly as bootstrap leaves them, and a
table created by anyone else is one the application cannot later alter. `migrationUri` is DDL authority
for Add-on schemas, which are not Core's tables; `drop` needs it for that reason.

`apply` re-grants `REFERENCES` on the Core reference tables to the migration role every time, because a
table this release adds may be one an Add-on is allowed to point at, and that grant is per table.

### Table ownership

Add-on tables live in their own PostgreSQL schema. Ownership is recorded once and read in two halves:
the catalog row maps the Add-on to its schema, and PostgreSQL maps that schema to its tables. There is
no third register that could disagree with either, and `phis-cli` removes an Add-on's data by dropping
the schema its catalog row names. Core tables stay in `phis`, and no Add-on names a schema at all -- the
descriptor has nowhere to put one.

Core derives the schema name from the logical Add-on id, never from the physical package name:
`phis_addon_`, then the id without its `@`, with `/` and `-` both replaced by `_`. `@acme/github`
becomes `phis_addon_acme_github`. The two names normally hold the same string, so this looks like a distinction
without a difference until the day it is not: a replacement package under section 1 may be named
differently, and deriving the schema from the physical name would demand a rename with rows already in
it. An Add-on id is a valid npm package name in which neither `_` nor `.` occurs. Lowercase follows
from the first half rather than from a rule of ours: npm has refused uppercase in new package names
since 2014, and an Add-on package is always new, because it needs a manifest. The two characters we do exclude, we exclude for one reason -- both would have to be mapped to
`_`, and three characters collapsing into one would multiply the collisions the unique index has to
catch for nothing in return. Excluding `_` also buys something: every underscore in a schema name then
marks a boundary that was there before.

The derivation is lossy and therefore not injective: `@acme-a/b` and `@acme/a-b` reach the same name. It
is a suggestion computed once, not a rule applied repeatedly. `phis-cli` records the name it derived in
the Add-on's catalog row under a unique index, and the database is then what guarantees that two
installed Add-ons never share a schema -- a guarantee that survives someone working around the CLI,
which a check inside the CLI does not. Recording it also means a later change to the derivation leaves
existing installations on the name they already carry instead of orphaning their tables. A derived name
past the identifier length limit is refused rather than truncated, and an Add-on that owns no tables
records no schema at all.

Foreign keys cross that boundary in one direction only. An Add-on table may reference a Core table;
Core never references an Add-on table, because the kernel must not come to depend on something an
operator may uninstall.

An Add-on names a Core table symbolically -- the Site, the user -- from a list Core maintains, and never
writes `phis.sites(id)`. Core is then free to rename its own tables without breaking an installed
Add-on, and which Core tables an Add-on may point at becomes a decision instead of a consequence of what
happens to be reachable.

A referencing column chooses between `ON DELETE CASCADE` and `ON DELETE SET NULL`, and the descriptor
offers no third value. An Add-on must not be able to refuse a Core deletion: an operator who cannot
delete a user because an installed package forbids it is looking at a constraint error from code they
may not know they have. `CASCADE` also settles the common case without asking the Add-on anything -- a
user's rows in an Add-on table go when the user goes, whether or not the Add-on is currently enabled.

Site binding belongs to Core. A table states that it is Site-scoped; Core adds the column, the foreign
key to `phis.sites(id)`, and the cascade, and Core is what puts the Site filter into every query that
reads the table. The Add-on neither writes the column nor is able to forget it. User binding works the
same way. Deleting a Site stays complete, and data that outlives its Site is not a feature of Add-on
ownership.

Two further scopes work the same way and exist for a different reason: they carry authority rather than
a boundary.

A table states that it is **owner-scoped**; Core adds `owner_user_id`, its foreign key to the user, and
answers whether a row belongs to the acting user. The column is nullable and a deleted user leaves it
null rather than taking the rows along, so a row without an owner belongs to nobody and no membership
level reaches it through ownership.

**Beside it Core writes `created_by_user_id`, and never writes it again.** The owner is authority and
moves; the author is history and stays, which is what keeps a handed-over row attributable afterwards.
Media keeps the same pair for the same reason. They hold the same value until the first handover and
part company there.

`phis addon owner --addon … --site … [--from <user>] --to <user>` is that handover: every owned row of
one Site moves from one account to another in one transaction, because a half-finished one would leave
the successor holding part of a vendor's entries and nothing recording where the line was drawn. Left
out, `--from` names the rows nobody owns -- what a deleted account leaves behind, and the case a
successor is most often appointed for. Which tables are owned is read from the catalog rather than from
a manifest: what makes a table owned is that Core put the column on it, and the database holds that fact
already.

A table states that it is **group-scoped**; Core adds `group_id` and binds it, and the group membership
levels then apply to that table. Group scope requires Site scope, because a group has no meaning without
a Site, and Core binds the pair `(group_id, site_id)` against the unique key `site_groups` carries for
exactly this purpose. The group id alone would let a row name a group belonging to a different Site, and
neither the Add-on nor the database would see that it had. A `core.group` reference column is bound the
same way and is therefore also confined to a Site-scoped table, and to `ON DELETE CASCADE` -- `SET NULL`
would clear the Site column along with it.

The reason these two belong to Core and not to each Add-on is that the rule they encode -- a person may
edit and delete what they created, and a group's members reach the group's rows by their level -- is one
rule. Left to the packages it becomes one implementation per package, each with its own mistakes, and no
consistent answer to who could do what.

Making a Core table referenceable is also an operational act, not only a contract one: the role that
migrates an Add-on's schema needs `REFERENCES` on that table, and the Add-on's foreign key fails at
migration time without it.

Because Core writes the statements, these rules are mostly guaranteed rather than requested. The
verification that remains is addressed at Core's own generator: after applying a descriptor,
`phis-cli` reads `information_schema` and refuses the result when a table sits outside the Add-on's
schema, when a foreign key points at an Add-on from Core, when a delete rule is neither of the two
permitted, or when a Site-scoped table is unbound. That is the point where a generator bug is still
cheap.

### The schema descriptor

A descriptor states the shape an Add-on's schema should have, not the steps to reach it. It names
tables; a table names columns, a primary key, indexes, unique constraints, foreign keys, and
constraints. Column types are abstract, and Core maps them: identity, integer in three widths,
unbounded text, bounded string, boolean, instant, JSON document, UUID, binary. A column states
nullability and may state a default from a closed vocabulary -- a literal, or the current instant.

An index states what it is for rather than how it is built: `ordered` for equality, ranges and the
orderings a paged select runs under, `text` for substring search over one text column. Core maps `text`
to a trigram (`gin_trgm_ops`) index, which is what makes `contains` a lookup rather than a scan. A text
index cannot be unique and cannot span columns, because it indexes fragments rather than values. The
`pg_trgm` extension it needs is created by the Core schema script, so it is there before any Add-on asks
for it. Where a provider forbids the extension, migrating an Add-on with a text index fails;
`phis schema check` and `phis schema apply` report the missing extension beforehand.

Constraints are declared in structured form: a range on a number, an enumeration of permitted values,
non-emptiness on text, a comparison between two columns of the same row, and null cardinality across a
group of columns, for the polymorphic row where exactly one of several columns is set. Regular
expressions are not offered; their syntax differs between database systems, and taking them would buy
back the dependency the descriptor exists to remove.

Constraints belong in the first version of a descriptor and are the one part that does not wait. A
column can be added later and an index can be added later; a constraint added later meets the rows that
are already there.

**In a Site-scoped table, unique means unique within the Site.** Core prepends the Site column to every
uniqueness rule the table declares -- to `unique` on a column and to a unique index alike. The Add-on
cannot say this itself: it may not declare `site_id`, so it has nowhere to name the pair. Left as plain
uniqueness the rule would reach across every tenant on the instance, and the second Site to install the
Add-on would collide with the first over a value neither of them can see. Instance-wide uniqueness is
therefore not expressible on a Site-scoped table, which is the answer and not a gap: an Add-on holding
rows for several Sites has no business enforcing a rule across them, and one that genuinely needs a
globally unique value keeps an unscoped table for it. A non-unique index is only an access path and is
left exactly as it was written.

What a descriptor cannot say is the point of it. There are no triggers, functions, views, expression or
partial indexes, and no free-form check expression, because each of those is SQL and would put back
exactly what the descriptor takes away. An Add-on that needs one of them is either cut wrong or needs a
Core service.

### Files a row carries

A table may declare **assets**: named slots where a file belongs. The names are the Add-on's -- `logo`,
`package`, `screenshots` -- and each slot states its cardinality (`one` replaces, `many` accumulates), a
`maxBytes`, the exact media types it takes, and who may fetch it. That last one is per slot because the
answers really do differ within one package: the logo on a listing has to be readable by anyone who can
see the listing, and the release artifact behind it must not be. Assets require `siteScoped`.

**The file itself is a Media Asset.** Core already records where an object is, how big it turned out,
what type it is and which digest it carries -- once, for every upload it has ever handled. An Add-on's
asset table holds a link to one of those and nothing else:

```text
site_id · id · owner_id · slot · media_asset_id
```

Three of those five are Core's scope columns and `slot` is the only fact that belongs to the Add-on.
Copying the object's properties in would be a second record of one thing, and two records of one thing
eventually disagree. It also means **delivery comes for nothing**: the file is a Media Asset, so the
delivery Core already has serves it.

The files live in a Media Space of the Add-on's own -- a fourth Space kind, one per Add-on per Site, not
browsable. That is what makes the Space's quota **the Add-on's quota**: one account over one set of
bytes, rather than two that drift apart.

The link is bound to the Site and cascades **both ways**, which is worth reading twice:

- Removing the Add-on's parent row takes its link rows with it. The Media Assets survive, because a file
  is not the Add-on's to delete, and `--sweep` collects the ones nothing points at any more.
- Removing the file in the Media view takes the link. **The parent row survives and simply has nothing
  to deliver for that slot.** That is deliberate: it makes deleting a file a usable answer to somebody
  uploading rubbish, without destroying the record it was attached to.

Every row in that table is a finished file, so the rule for a single-valued slot is a plain unique index.
A transfer in flight is recorded in Core's upload session, never in this table.

### Declared queries

An Add-on does not query its tables. It declares the queries it needs -- what to read, under which
filters, in which order, how many -- and Core derives each statement from the declaration. A handler
calls a query by name through `data:v1` and passes parameters.

The reason is the one that governs Site binding. Core builds the statement, so Core puts the Site filter
in: a query against a Site-scoped table is bounded by the Site in the handler context, not by a
predicate the Add-on remembered to write. An Add-on cannot express a query that reaches past its own
Site, and cannot express one that reaches past its own schema.

Two further properties follow. No statement is assembled from values at request time, so there is no
injection surface to reason about. And Core knows every query an Add-on will ever run before it is
installed, which makes an admission judgement possible where runtime SQL allows none: an unbounded scan,
a write without a filter, an ordering with no index behind it are visible in the manifest rather than
only while the Add-on is serving.

The declaration form carries what a real query needs and refuses what does not survive the boundary:

- a filter may be declared optional, as `whenPresent` over a nullable parameter, and the parameter being
  absent is what switches it off. It compiles to one statement, `($n::TYPE IS NULL OR col = $n)`, and
  not to one statement per combination.

  The null-tolerant predicate keeps the index because Core calls the database with statement text and
  values and never with a statement `name`: an unnamed statement is planned at bind time with the real
  values, the null test is folded away, and the comparison goes into the index condition as a
  hand-written filter would. Under a *prepared* statement the index condition disappears, which is why
  the unnamed form is load-bearing (`src/lib/addons/data-capability.ts`).
- ordering is declared, and paging is by key rather than by offset. Core issues the cursor and reads it
  back; an Add-on passes it on without being able to see what it is made of.

  There is no unpaged read to reach for: `select` answers with a page and a cursor, always. Core
  completes the declared ordering with the table's primary key so the order is total -- without that,
  two rows sharing a sort value may come back either way round and the page boundary falls between them
  differently on each call, which puts one row on two pages and another on none. Every ordering column
  must be `NOT NULL`, because where nulls sort is not something the descriptor can state and a keyset
  comparison against null ends the paging early and silently. The cursor carries a signature of the
  ordering it was made for; a query with a different one refuses it rather than paging on a foreign
  order.
- text is searched with `contains`, which takes a column and a value and is the only search the
  vocabulary offers. It is an operator rather than a pattern: Core writes the statement and escapes the
  value, so a `%` in a search term is a character to look for rather than a wildcard that quietly
  matches everything.
- a query may state `requiresRole`, and Core refuses to run it for an actor who does not hold that
  name. Core learns no meaning from this -- it compares a name with what is stored, as `roles.has()`
  does -- and what the role stands for remains the Add-on's own pairing of role and query. It is what
  makes a table nobody owns writable: without an owner and without a group Core has no row to judge, so
  such an update or delete must state a role, and validation refuses it otherwise. Where a row does have
  an owner or a group, the role narrows rather than replaces.
- `alsoAllowedByRole` is the other direction, and the one moderation needs. `requiresRole` asks for the
  role *on top of* the ladder, which on an owned table means role and owner both -- something nobody
  moderating a stranger's row can ever be. This one widens: the row is judged first, and a caller the
  ladder turned down is let through on the role instead, while the owner keeps reaching their own row
  without holding any. It is asked after the row rather than before it, because a role standing in for
  an authority the row did not grant can only be weighed once the row has answered. The refusal stays
  the ladder's silent zero, so a moderation query does not become a way of asking whether a row exists.
  Only on an update or a delete, only on a table that has authority to stand in for, and never together
  with `requiresRole` -- a query wanting both is two queries under one name.
- `in` comes in two forms. One takes values fixed in the descriptor -- a state, a kind, a handful of
  names the Add-on knows. The other names a `list` parameter and takes what the caller brings, which is
  what makes a second question about a page possible: read a listing, then ask something about exactly
  those keys. Core writes `= ANY($n::TYPE[])` rather than expanding the values into the text, so the
  statement has one shape however many arrive -- an expanded list would be a statement assembled at
  request time, with a plan and a cache entry per length. A list is capped at
  `PHIS_ADDON_QUERY_MAX_LIST` and refused above it rather than truncated: a shortened list answers
  about some of the rows and reports it as an answer about all of them.
- `aggregate` counts and summarises instead of returning rows: `count`, `sum`, `avg`, `min`, `max`.
  Without it an Add-on reads every row to count them -- the unbounded read paging exists to prevent --
  or keeps a running total in a column Core cannot hold true. It reaches no row a select could not have
  read: what a query may see is what the query says, and an aggregate over rows the caller may not read
  one by one is one the Add-on wrote that way. `sum` and `avg` want an integer column, and validation
  says so rather than letting the first call raise it. Without `groupBy` the answer is one row and there
  is no cursor. With it there is one row per group, paged like a select -- and the grouping columns *are*
  the ordering, total by construction because `GROUP BY` yields each combination once, which is also why
  they must be `NOT NULL`. There is no ordering by an aggregated value: ranking by an average would page
  on a key that is neither unique nor known before the group is computed.
- an `update` or `delete` addresses exactly one row by its primary key, through `idParameter`; there is
  no `where` and no bulk form. Every mutation answers with the row it wrote.
- several calls run as one unit of work inside `data:v1`'s `transaction(body)`. Without it, every write
  stands alone and no invariant spanning two tables can hold.
- there are no joins, not even between the Add-on's own tables. A join onto a Core table would fix
  Core's shape inside an Add-on and undo what the symbolic reference buys; what an Add-on may know about
  a user comes from a Core service.

Result types are to be generated from the declared queries at the Add-on's own build time by
`@phis/addon-sdk` (section 3, not built), because an Add-on is built separately and cannot read
`@phis/server`'s generated artifacts.

### Applying and removing a schema

`phis-cli` compares the declared descriptor against the recorded one and derives the statements that
close the difference. Before v1 it executes exactly one comparison, the one against nothing; any other
ends with an instruction to purge and recreate. This is the licence Core takes for its own schema before
v1, and it expires the same way. Once installations hold rows nobody may discard, `phis-cli` executes
the differences that lose nothing -- a new table, a new nullable column, a new index -- and keeps
refusing the ones that do unless the descriptor names them.

The recorded checksum covers the canonical serialization of the descriptor, not the text of anything.
Reformatting is therefore not drift; a changed shape is. A checksum that disagrees with what was applied
stops the run and names the remedy rather than attempting a repair.

`phis-cli` creates the schema before applying anything into it, grants the serving role usage on the
schema and data access on its tables -- never DDL -- and arranges for objects created by later versions
to carry the same grants. A migration that succeeds while leaving the serving role unable to read the
result is a failure that would otherwise surface as a bug in the Add-on.

An applied-version row references the installed Add-on, so the Add-on is registered before its schema is
applied; `phis addon migrate` registers it when reconciliation has not yet run, rather than requiring
the operator to reconcile twice. `server_addons.migration_version` holds the highest applied version and
is written by the migration runner alone.

Removal has two steps and only the second is destructive. Disabling an Add-on and uninstalling its
package leave the schema, its rows, its role assignments, and its `storage:v1` objects untouched.
`phis addon purge` drops the schema; deletes the Add-on's Site assignments, role assignments,
applied-version rows, registry capabilities, and stored secrets; retires its groups (memberships stay);
deletes its catalog row; and then removes the `storage:v1` objects of every Site it was enabled on.

**The catalog row is also what the Add-on's Media Space hangs on**, and it cascades: the Space, its
Assets, their variants. Nothing in that chain can reach a store, and afterwards nothing can name the
objects either -- they sit under the Site's ordinary Media prefix, which the purge's `storage:v1` removal
does not touch, in a Space `phis addon storage --sweep` can no longer ask about. So the purge writes their
keys to `phis.media_discarded_objects` in the same
transaction, before the cascade runs, and reports how many. Removing them is then a drain like any
other.

One case stays open and is not solvable here: an Add-on that was itself the Storage Provider. Its
objects can only be reached through code that left with it, so the keys are recorded and the bytes are
the operator's to remove with a client of their own. `phis addon purge` reports the objects it had to
keep in that situation.

## 16. Secrets

Secrets are server-only and namespaced by logical Add-on and, where applicable, Site.

Examples include GitHub App id, private key, webhook secret, and OAuth client secret.

Secrets never appear in:

- Site packages
- an installed Add-on artifact or its desired-state entry
- generic Module Storage documents
- Site-visible capability responses
- browser state

The registry may store only an opaque secret reference or configuration-state marker. Secret creation
and rotation use `phis-cli` or an explicitly authorized server-side provider setup flow and do not
require a schema migration.

### Where a secret is kept

A reference names a secret; it does not state where the secret is kept. Resolution goes through a
registered resolver, so a deployment may hold secrets in the database, in an instance's runtime
configuration, or in an external manager without any caller changing. The reference is what travels
through the registry, the Storage Profile row, and the handler context.

The default store is the database, encrypted. A file-backed store cannot serve more than one instance
without copying every secret to every host and copying them again on every rotation; a database row is
written once and read by all of them. Ciphertext, initialization vector, and authentication tag are
stored in separate columns, as `user_auth_factors` already stores an enrolled factor, and every row
records the version of the key that produced it. That column is worth nothing until the first rotation
and impossible to add afterwards, because by then there is ciphertext whose key is no longer known.

The root key is the one secret that stays out of the database, held in each instance's runtime
configuration. It is the only material a new host needs before it can serve, and it changes far less
often than what it protects. It is `secrets.encryptionKey` in the runtime configuration, created with
`phis secret init-key`.

A secret row records the Add-on and, where applicable, the Site it belongs to, so removing either takes
its secrets with it and an uninstall leaves nothing readable behind. Resolution is server-only and
scoped: a handler resolves references in its own namespace and can neither enumerate nor reach another
Add-on's.

## 17. Load-balanced releases

A global Add-on row does not prove that every serving instance has the same code.

Every instance reports:

- instance id
- release/build id
- local Add-on manifest digest
- local Add-on package versions
- local capability digests
- readiness and last-seen timestamp

Instances write this to `phis.server_instances` at startup and on an interval. `phis instance list`
shows where they disagree and exits `1` while they do (`converged: false` with `--json`), so a rollout
script can wait on it; `phis instance drain` clears an instance's ready bit, and `phis instance prune`
removes instances that stopped reporting. Global activation is to complete only after the expected
release is ready on all serving instances or old instances have left the load balancer; `phis addon
enable` does not wait for that yet (see Status).

Failure behavior:

- unknown or disabled Add-on/path: `404`
- enabled but absent or incompatible on the receiving instance: `503`
- temporarily unavailable external hook: `503` so retry-capable providers can redeliver

Capability responses include local release identity so rollout drift is attributable.

## 18. Threads and Resource Links

Threads and Resource Links are Core services rather than Support-owned Add-ons, and both are
implemented: they reach Add-ons as `threads:v1` and `resource-links:v1`, and a Site session reaches
threads under `/api/site/threads`. Threads are no longer Support's own -- Support is one kind of thread
among Direct, Group and CrossGroup, and membership is `site_groups` rather than a Support-owned table.
[design/THREADS.md](./design/THREADS.md) records the reasoning; [DB.md](./DB.md) holds the tables.

A thread carries its Site, its kind, its lifecycle, its participants, its messages, and per-reader read
state. Two message flags decide what leaves and what is seen: `Internal` is who may read it -- Staff
participants, and not the requester a Support note is written past -- and `Confidential` is where it may
go, which is nowhere outside Core, an Add-on included.

A Resource Link identifies a domain object without importing the Module that owns it:

```text
provider: @phis/github
type: 20 (the provider's own vocabulary)
externalId: owner/repository#123
```

Core stores the relation, indexes it per Site and provider, and authorizes it through the subject's
thread. What `20` means, and what a state of `3` means, belongs to the Add-on that wrote the row -- the
same arrangement a role name has. A link carrying `Synced` additionally grants that Add-on actorless
reach to the subject's thread, which is the one thing here that is not merely a reference.

## 19. Runtime coordination

Server persistence and Client runtime coordination are separate.

Authoritative changes flow through Core or Add-on APIs. Runtime signals may notify active controllers
and widgets about a new projection or synchronization state, but they are neither authorization
evidence nor persistence authority.

Support does not declare GitHub-specific receiver schemas. It may declare generic Resource Link or
external-resource receivers using Core-owned schemas, and GitHub may emit those generic projections.

Support can display a GitHub issue status without importing GitHub:

1. the GitHub Add-on synchronizes provider state
2. Core stores or projects the Resource Link
3. the Support Module renders the generic resource projection
4. an optional runtime signal refreshes the visible projection immediately

Arbitrary React injection into another Module's widget and direct cross-Module draft mutation are not
part of this contract.

## 20. Reference bindings

### Support

```text
Site package:        @phis/support
Site Module:         @phis/support/modules/support
Server binding:      Core
Required capability: @phis/server/support:v1
Required capability: @phis/server/threads:v1
Required capability: @phis/server/resource-links:v1
Server Add-on:       none
```

### GitHub

An illustrative binding; no GitHub package exists.

```text
Package:             @phis/github
Site Module:         @phis/github/modules/github
Server binding:      @phis/github
Add-on entrypoints:  @phis/github/addon/manifest, @phis/github/addon/runtime
Provided capability: @phis/github/issues:v1
Core requirement:    @phis/server/threads:v1
Core requirement:    @phis/server/resource-links:v1
```

## 21. Non-negotiable invariants

- Site/client extensions are Modules; server extensions are Add-ons.
- One package carries one product. Both halves ship under one name and one version, and the Add-on half
  lives under the `addon/` entrypoint prefix.
- Every Module binds to exactly one Add-on or to Core.
- Module activation never installs or auto-enables an Add-on.
- Only `phis-cli` controls installed server code, migrations, the install root, and global activation.
- A Site may enable or disable only an already installed Add-on for itself.
- The database records operational state but never selects an import target.
- Catch-all routes dispatch only to exact entries in the local desired state, backed by an artifact
  whose digest still matches.
- Add-on identity is scoped and collision-safe.
- Browser code never receives direct database, migration, DDL, or secret access.
- Core and Add-on capabilities use the same versioned discovery format.
- Deployment availability and Site enablement are separate.
- Load-balanced activation is release- and instance-aware (not yet enforced; see Status).
- Missing server capabilities fail locally and observably without breaking unrelated Modules.
- Internal service implementations use the one manifest-declared service-provider registry; Add-ons and
  Modules must not create provider-specific import, loopback-route, or fallback paths.
- An Add-on owns tables only inside its own schema, and the catalog is what says which are its.
- Foreign keys point from an Add-on at Core and never the other way; an Add-on cannot refuse a Core
  deletion.
- A secret reference does not name a storage location, and the key that decrypts a secret never lives
  where the secret does.
- An Add-on ships no SQL and no DDL. It describes its tables and its queries; Core derives the
  statements.
- Core owns physical naming, Site binding, and the Site filter in every query against a Site-scoped
  table; an Add-on cannot write them and cannot omit them.
- A derived technical name is either digest-backed or recorded under a unique index. A lossy value is
  never computed and then treated as identity.
- Every query an Add-on will run is declared before it is installed, so no statement is assembled from
  request or database values.
- The Add-on SDK is a development dependency. An Add-on runs without it.
