# Phi Server Add-on Contract

## Status

This document defines the normative target v1 contract for extending `phi-server` and binding Site
Modules to server capabilities.

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

### Implementation checkpoint

The initial server/CLI foundation now provides:

- the manifest, route, capability, migration-descriptor, and runtime-handler TypeScript ABI
- strict CLI validation and deterministic SHA-256 manifest digests
- operator-owned `config/phis-addons.json` desired state
- CLI install, remove, list, validate, static-manifest build, enable, disable, and registry
  reconciliation commands
- runtime loading from the install root: a derived `file:` address per Add-on, digest-verified before
  the first load, so installing one no longer rebuilds or restarts the server
- the two fixed Add-on and hook catch-all routes
- internal service-provider descriptors, resolved from the installed desired state. An Add-on declares
  `(service kind, package-qualified provider key, interface digest, factory export, required Core
  capabilities)`; Core checks the pair for uniqueness across the installation, refuses an interface
  digest from a release it no longer offers, and applies the dispatcher's registry checks before
  reaching a factory. There is no runtime registration to fall back to
- exact declared method/path dispatch, authentication policy, body limit, rate-limit class, timeout,
  runtime-manifest digest, Core capability, deployment-registry, and Site-state checks
- the secret store with its first real reader. Authentication provider secrets are rows rather than
  lines in `config/phis-runtime.json`, so a second instance can be given a root key instead of a file
  copy; `phis auth import-secrets` moves an existing installation across once
- the declarative schema descriptor and everything Core derives from it: the generated DDL, the schema
  and its grants, the `information_schema` check afterwards, `phis addon migrate`, and `phis addon
  purge`. An Add-on describes tables, columns, references, indexes, and structured constraints, and
  ships no SQL; Core writes the Site, group and owner columns with their keys, resolves symbolic Core
  references, and records the derived schema name under a unique index
- the declarative query catalog and the compiled access path it implies. An Add-on declares named
  queries, Core derives the statements once, and `data:v1` runs them by name. The Site filter is in the
  statement rather than in the caller, Core writes the scope columns on insert, and a mutation is
  refused by the row-level ladder before it runs
- a Site-scoped read-only capability snapshot endpoint
- mandatory Site Module server bindings with exact provider capability requirements
- the initial Add-on, capability, Site activation, migration-history, and instance registry tables

The following contract stages intentionally remain pending rather than being represented by a
fallback:

- the second half of the DDL separation. `phis-cli` migrates as its own role, and an Add-on schema is
  owned by that role, so the serving role holds nothing but usage and data access there -- it cannot
  create a table in an Add-on schema, and the migration role cannot create anything in `phis`. What
  remains is `phis`: the serving role still holds `CREATE` on it, because `src/app/setup/actions.ts`
  loads `001_create_phis.pgsql` from a request. Revoking it waits on that bootstrap moving to
  `phis-cli`.
- `@phis/addon-sdk`. The contract package is published and depended on; the build-time half described in
  section 3 -- descriptor builders, result-type generation, a context double -- has no package yet.
- Site-admin activation/configuration API and provider setup flows
- Threads and Resource Link adapters in handler context. Six Capabilities are delivered, each bound to
  the request or the job -- `authorization:v1`, `data:v1`, `storage:v1`, `secrets:v1`, `settings:v1`,
  `groups:v1` -- and those two are not. A Storage Provider factory receives the restricted service
  context section 10 describes: one nullary reader bound at construction to the secret its own Storage
  Profile names, with no argument through which another could be named.
- a Site-admin surface over what `phis addon config` writes. The values are stored, declared, and
  readable; what is missing is a page rather than a mechanism.
- startup instance heartbeat/readiness and load-balancer rollout reconciliation. `phis.server_instances`
  is declared and unwritten, so no deployment can yet tell whether every serving instance carries the
  same release.
- provider role catalogs, Site user claim persistence, and Add-on viewer-claim resolution defined by
  `AUTHORIZATION.md`
- a separately published reference Add-on used for end-to-end package tests

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
[THIRD_PARTY_MODULES.md](../phi-shared-ui/THIRD_PARTY_MODULES.md).

Examples:

```text
@phis/support/modules/support
@phis/github/modules/github
```

### Add-on

An Add-on is a namespaced, operator-installed extension compiled into `phi-server`. It may contribute
server routes, webhook handlers, jobs, migrations, external-service adapters, server-side providers,
and versioned capabilities supported by the Add-on ABI.

Every physical Add-on package uses the mandatory `-server` postfix. For a direct Site Module counterpart,
the scope and base name match exactly:

```text
Module package: @phis/github
Add-on package: @phis/github-server
```

Logical identity and physical package identity are separate:

```text
addonId:     @phis/github
packageName: @phis/github-server
```

The logical Add-on id is stable API and persistence identity and omits the physical `-server` postfix.
The physical package name is deployment metadata, but every replacement package must still satisfy the
`@scope/name-server` Add-on naming contract.

### Core

Core is compiled into every `phi-server` release, is never installed as an Add-on, and cannot be
disabled per Site. It participates in capability discovery as:

```text
@phis/phi-server/core
```

### Capability

A Capability is a namespaced, versioned server interface supplied by Core or one Add-on. Capability
version is independent from provider package version.

```text
@phis/phi-server/threads:v1
@phis/phi-server/resource-links:v1
@phis/phi-server/support:v1
@phis/github/issues:v1
```

The version sits in the id, which is why a Capability carries no separate interface digest the way a
service kind does. A shape change raises the id to `:v2`, Core stops offering `:v1`, and an Add-on
requiring the old one is refused at dispatch by name alone. A service kind has no version in its name
and needs the digest to say the same thing.

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

## 3. Physical package separation

Site packages and server packages are separate publication and build units:

```text
@phis/support
@phis/github

@phis/github-server
```

An Add-on package name that does not end in `-server` is invalid. A file or `./server` export inside the
Module package is not an Add-on and must never be compiled into `phi-server`.

The separation is mandatory:

- Site packages contain Site-runtime and authoring code.
- Add-on packages contain server-only code.
- `phi-server` never imports a Site or React package.
- A Site application never imports an Add-on package.
- An Add-on never imports `phi-shared-ui`.
- Both sides may depend on a neutral, React-free contract package for shared wire schemas.
- Server-only and Site/Client entrypoints remain physically separate module graphs.

Two neutral packages sit between the sides, and what separates them is when they run:

- `@phis/addon-contract` states what an Add-on declares or implements. `phi-server` depends on it, which
  is why nothing may enter it that does more than hand back data. Validation stays in Core: a check
  shipped to an Add-on runs in the Add-on's address space, at the version the Add-on chose, and only if
  the Add-on calls it, so it can never be the authoritative one.
- `@phis/addon-sdk` carries what an author uses while building -- descriptor builders, generation of
  result types from declared queries, and a context double for tests. It depends on the contract, and it
  is a development dependency and nothing else. An Add-on with the SDK removed still runs; only its next
  build lacks the generator.

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

Every physical Add-on package exports a server-only manifest containing at least:

- logical Add-on id
- physical package name and package version
- compatible `phi-server` Add-on ABI range
- immutable route namespace
- provided capabilities and interface versions
- internal service-provider descriptors when the Add-on implements a Core-owned service kind
- required Core capabilities and version ranges
- internal route descriptors
- external hook descriptors
- job descriptors
- a schema descriptor when the Add-on owns tables, and the version it is at
- declared queries when the Add-on reads its tables
- manifest format version

The built manifest has a deterministic digest covering route, capability, service-provider, job,
schema, query, and migration descriptors. It never contains runtime secrets.

### Adding to the manifest

A field added after this manifest version is already in the wild is **optional, and defines what its
absence means**. A required addition would lock every installation out the moment Core is upgraded: the
stored manifest was written as it was built, its author had not forgotten the new field, and the digest
means the file cannot be repaired by hand either. The initial fields may demand an explicit `null`,
because no stored manifest predates them.

`manifestVersion` is for something else and is deliberately rarer: it changes when an existing field's
*meaning* changes, where an old manifest is not incomplete but wrong, and reading it under the new rules
would install something subtly incorrect. Refusing is right there, and it is expensive on purpose.

For the case nobody foresaw, `phis addon forget` removes an entry from the desired state without
reading it. `remove` validates before it deletes, which is right when the state is sound and useless
when it is not.

The package exposes two explicit server entrypoints:

```text
@scope/package/manifest
@scope/package/runtime
```

`/manifest` exports `phiServerAddonManifest` and must be safe for CLI inspection without starting
jobs, opening connections, or reading secrets. `/runtime` exports `phiServerAddon`; it contains the
same manifest plus the declared handler maps and service factories. There is no package-root fallback.

## 6. Installation and deployment authority

Only `phis-cli` may:

- install, upgrade, or remove an Add-on artifact
- reject any Add-on package name without the mandatory `-server` postfix
- validate Add-on ABI and descriptor collisions
- execute reviewed Add-on migrations
- write and remove entries in the Add-on desired state
- globally enable or emergency-disable an Add-on
- build and deploy `phi-server`
- distribute an artifact to every instance and reconcile the release across them

No browser route, Site Module, persisted CMS value, Add-on handler, or database row may:

- install a package
- submit or execute arbitrary SQL
- submit a migration manifest
- change a package name or version
- create a dynamic package import
- add a top-level Next.js route
- globally enable server code

Installation and upgrade are deployment operations, not Site configuration operations. They no longer
require a release: an Add-on is installed into a running server, and only a change to `phi-server`
itself is a build.

How an artifact reaches the machine in the first place -- configured sources, the package list an
instance compares against, what is recorded about an Add-on's origin, and how far update handling may
be automated -- is [DISTRIBUTION.md](./DISTRIBUTION.md). Nothing there widens this section: acquisition
is a deployment operation like the rest.

## 7. Install root and desired state

An Add-on is one self-contained ESM artifact. `phis-cli` places it in the install root and records the
entry -- its identity, its validated descriptors, and two digests -- in the operator-owned desired
state. No Add-on is compiled into `phi-server`, and there is no second mechanism beside this one.

Self-contained is a requirement, not a recommendation. An artifact carries its dependencies and leaves
no bare import behind except `node:` builtins, because Node resolves a bare specifier by walking up:
one left in place reaches whatever `node_modules` sits above the install root, including the server's
own. An Add-on that cannot be bundled -- one needing a native binary or a runtime-loaded asset -- is
therefore not an in-process Add-on at all. Its capability belongs in Core, or in the separate-process
shape that is planned and does not exist yet.

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

## 8. Fixed Core routes

`phi-server` owns two fixed optional catch-all Route Handlers:

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
somebody else's Core reading a catalogue. Until a hook could name a Site it also had no capabilities at
all, because every one of them is Site-scoped: it could verify a signature and touch no data.

`siteScoped` on a hook descriptor changes only that. The Site comes from `x-phi-site-key`, the header
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

An Add-on handler receives a scoped server context that may expose:

- request and correlation ids
- resolved Site identity
- validated user/operator identity and permissions
- a namespaced structured logger
- a namespaced secret accessor
- approved Core services such as Threads and Resource Links
- its own Module Storage or repository boundary
- approved job scheduling
- restricted outbound HTTP support
- a raw body only when the route descriptor requires signature verification

Request values never define effective Site, Add-on identity, package name, secret namespace, or
database namespace.

Trusted in-process Add-ons are not a security sandbox. Code not trusted by the operator runs in a
separate process or container behind an authenticated service boundary.

### Internal service providers

An Add-on may implement a Core-owned in-process service kind through the same static build and
activation boundary. This is the only extension path for infrastructure implementations such as an
S3-compatible Media Storage Provider or a future LDAP/SCIM/Entra Directory Provider; a private loopback
HTTP route, dynamic import, or Module-owned adapter is not an alternative.

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
and assertion provenance are normative in [DIRECTORY_PROVIDERS.md](./DIRECTORY_PROVIDERS.md).

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
Add-on for its own Site:

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

Persistent boolean state follows the existing `phi-server` table convention and occupies explicit
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
- `phi-server` startup/reconciliation writes observed build and instance state.
- authorized Site administration writes only its Site's permitted enablement and configuration state.
- normal Site clients have no registry mutation authority.

## 13. Core capability registry

### A capability name is frozen once it is public

The version lives inside the id, and it covers the shape, not the name. Renaming the name half of
`@phis/phi-server/<name>:v1` produces an id that was never offered, which to every consumer looks like a
capability that does not exist -- no version moved, so nothing signals a break.

This is not hypothetical. `auth` was renamed to `authentication` during development, the Site Module
requesting it was not carried along, and the Auth module resolved a capability nobody offers: it
deactivated itself, exactly as the contract says it must, and the Site silently had no login route. That
was found by a person reporting a 404, not by anything in the build.

From the first public release of `phi-server`, a capability name may only gain a successor beside it, never
be replaced in place. An installation that updates `@phis/ui` and `phi-server` independently through npm
has no other protection: they agree on capability ids and on nothing else.

`phis site check --key <site key>` compares what a Site's Modules require against what its server offers
and names the Modules that lost theirs. The comparison happens in the Site, because `phi-server` does not
depend on `@phis/ui` and cannot know what a Site requires. It reports the running Site, so it is the check
to run after an update rather than a prediction about one.

Core participates in the read-only discovery model as:

```text
@phis/phi-server/core
```

The Core capabilities are the ones `@phis/addon-contract` names, and that package owns the spelling:

```text
@phis/phi-server/authentication:v1
@phis/phi-server/authorization:v1
@phis/phi-server/data:v1
@phis/phi-server/groups:v1
@phis/phi-server/secrets:v1
@phis/phi-server/storage:v1
@phis/phi-server/threads:v1
@phis/phi-server/resource-links:v1
@phis/phi-server/support:v1
```

Core descriptors are generated from the running release and reconciled into the registry. They are not
editable Site settings and cannot be disabled per Site.

### `authorization:v1`

The one Capability that is delivered rather than only declared. It answers "may this actor", in the
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

Running the queries the manifest declared. Four operations and a unit of work, and every call names a
query rather than describing one:

```text
select(name, args)  -> rows
insert(name, args)  -> the inserted row, scope columns included
update(name, args)  -> rows touched
delete(name, args)  -> rows touched
transaction(body)   -> whatever the body returns
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
  reports zero rows touched, which is also what a missing row reports: telling the two apart would
  report the existence of a row the caller may not have.

`mayActOnRow` and this enforcement answer the same question on purpose. The capability is for deciding
what to offer a user -- whether to render the delete control; the write path is what actually holds. A
check an Add-on has to remember to call is one that eventually is not called.

The transaction handle offers the same four operations and nothing else: no commit, no rollback, no
savepoint. Returning ends the unit of work, throwing undoes it, and an Add-on cannot leave one open
because it never holds the thing that would stay open.

The vocabulary is poorer than the schema descriptor's in one further way: **there are no joins.** A
join to a Core table would make the kernel's shape an installed Add-on's dependency, and a join between
two Add-ons' tables is already forbidden. A read is bounded by a required `limit`, capped at 500 --
"the caller will pass a sensible one" is not a bound. `LIKE` is absent for the reason regular
expressions are absent from the schema descriptor: escaping and collation differ between database
systems, and taking it would buy back the dependency the descriptor exists to remove.

### `storage:v1`

A private object store for one Add-on on one Site: `put`, `get`, `head`, `remove`, `list`.

Keys are the Add-on's own and relative. Core puts them under a prefix it derives from the Add-on id and
the Site key, and never hands the physical key back -- so there is no address an Add-on can store,
guess, or be tricked into passing, and another Add-on's objects are unreachable by construction rather
than by a check. The same rule the install root follows: a stored string never becomes an address.

The bytes go through the Site's configured Storage Provider, so an operator who moved a Site to S3
moved its Add-ons with it. The Site's `max_object_bytes` is the ceiling, because one limit is easier to
reason about than two.

This is not the Media library. What a person uploads, browses, and references belongs in a Media Space
with its folders, quotas, and delivery policies. This is what an Add-on keeps for itself: a release
artifact, a generated preview, an export waiting to be fetched.

### `secrets:v1`

`read(name)` and nothing else. The owner and the Site are bound, so another Add-on's secret cannot be
named, and the resolver checks the owner a second time because a wrong binding and a wrong argument are
different mistakes.

There is no writer, and there should not be one. An operator sets a secret with `phis secret set`; a
package that could write its own could plant one, and the store would stop being the operator's record
of what they configured.

### `groups:v1`

Group facts, bounded by the acting user: `myGroups`, `members(groupId)`, `user(userId)`.

One rule decides all of it -- **an Add-on sees what its actor sees.** Every answer is one the acting
user could already have obtained through the Site's own group routes, projected exactly as those
project it: a display name, a company only where the group's own flag discloses it, and never an
address. That decision belongs to the group's Manager, and an Add-on inherits it rather than being
asked separately.

`user(userId)` answers null for somebody the actor shares no group with. That null is the point of the
method: it is what stops a row's owner id from becoming a lookup into a Site's whole user table. An
Add-on renders "listed by" and learns nothing else.

### `settings:v1`

`read(name)` and `all()`. What an operator configured with `phis addon config set`, stored in
`site_server_addons.configuration_json` -- the row that already says whether the Add-on runs on that
Site, which is where what it runs with belongs.

Distinct from `secrets:v1` on purpose: a commission rate is not a credential, and asking the secret
store to hold one would make what is configured unreadable to the operator who configured it.

The declared descriptors are the shape of the answer, not the stored row. A value nobody set falls back
to its declared default; a stored key nobody declares is ignored; a stored value of the wrong type falls
back rather than being handed over. An Add-on therefore reads exactly what it declared it would read,
whatever has accumulated in the column across versions. As with secrets, there is no writer.

## 12a. Jobs

A job is declared as `{ id, handler, suggestedInterval? }` and run by `phis addon job`, which posts to
the serving instance. It is not scheduled by Core, and the interval is documentation for the operator
rather than a promise: phi-server serves from several instances, so an in-process timer would fire once
per instance for one intended run, and every Add-on would have to defend against a concurrency nobody
asked for. The operator's own scheduler is one runner by construction.

**A job has no actor.** It is the Add-on acting on its own data, not a person acting through it, so the
row-level ladder has nobody to apply and `data:v1` writes with system authority inside one. That is
exactly why a job is reachable only through the internal-token route and never from a request: an Add-on
able to start its own job from a handler would have built itself a way around the ladder.

The job runs in the serving process rather than in the CLI, against the release that instance actually
serves. The CLI stays a caller instead of becoming a second runtime that would have to reproduce the
loader, the pool, and the capability bindings.

Package version, Add-on ABI version, capability version, migration version, and release build id are
independent version axes and are never inferred from one another.

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

### Table ownership

Add-on tables live in their own PostgreSQL schema. Ownership is recorded once and read in two halves:
the catalog row maps the Add-on to its schema, and PostgreSQL maps that schema to its tables. There is
no third register that could disagree with either, and `phis-cli` removes an Add-on's data by dropping
the schema its catalog row names. Core tables stay in `phis`, and no Add-on names a schema at all -- the
descriptor has nowhere to put one.

Core derives the schema name from the logical Add-on id, never from the physical package name:
`phis_addon_`, then the id without its `@`, with `/` and `-` both replaced by `_`. `@acme/github`
becomes `phis_addon_acme_github`. Deriving from the package name would write `-server` into every schema
and would demand a rename, with rows already in it, on the replacement package section 1 allows. An
Add-on id is a valid npm package name without the `-server` postfix, in which neither `_` nor `.`
occurs. Lowercase follows from the first half rather than from a rule of ours: npm has refused uppercase
in new package names since 2014, and an Add-on package is always new because it needs the postfix and a
manifest. The two characters we do exclude, we exclude for one reason -- both would have to be mapped to
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
level reaches it through ownership. This is authority, not history: a table that only wants to record
who created a row uses an ordinary `core.user` reference column, which grants nothing.

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
verification that remains has a different addressee than it used to: after applying a descriptor,
`phis-cli` reads `information_schema` and refuses the result when a table sits outside the Add-on's
schema, when a foreign key points at an Add-on from Core, when a delete rule is neither of the two
permitted, or when a Site-scoped table is unbound. It is no longer defending against a hostile Add-on --
it is checking Core's own generator, at the point where a generator bug is still cheap.

### The schema descriptor

A descriptor states the shape an Add-on's schema should have, not the steps to reach it. It names
tables; a table names columns, a primary key, indexes, unique constraints, foreign keys, and
constraints. Column types are abstract, and Core maps them: identity, integer in three widths,
unbounded text, bounded string, boolean, instant, JSON document, UUID, binary. A column states
nullability and may state a default from a closed vocabulary -- a literal, or the current instant.

Constraints are declared in structured form: a range on a number, an enumeration of permitted values,
non-emptiness on text, a comparison between two columns of the same row, and null cardinality across a
group of columns, for the polymorphic row where exactly one of several columns is set. Regular
expressions are not offered; their syntax differs between database systems, and taking them would buy
back the dependency the descriptor exists to remove.

Constraints belong in the first version of a descriptor and are the one part that does not wait. A
column can be added later and an index can be added later; a constraint added later meets the rows that
are already there.

What a descriptor cannot say is the point of it. There are no triggers, functions, views, expression or
partial indexes, and no free-form check expression, because each of those is SQL and would put back
exactly what the descriptor takes away. An Add-on that needs one of them is either cut wrong or needs a
Core service.

### Declared queries

An Add-on does not query its tables. It declares the queries it needs -- what to read, under which
filters, in which order, how many -- and Core compiles each into a statement at build time. A handler
calls a query by name and passes parameters.

The reason is the one that governs Site binding. Core builds the statement, so Core puts the Site filter
in: a query against a Site-scoped table is bounded by the Site in the handler context, not by a
predicate the Add-on remembered to write. An Add-on cannot express a query that reaches past its own
Site, and cannot express one that reaches past its own schema.

Two further properties follow. No statement is assembled from values at request time, so there is no
injection surface to reason about. And Core knows every query an Add-on will ever run before it is
installed, which makes an admission judgement possible where runtime SQL allows none: an unbounded scan,
a write without a filter, an ordering with no index behind it are all visible while the Add-on is being
installed rather than while it is serving.

The declaration form carries what a real query needs and refuses what does not survive the boundary:

- a filter may be declared optional, and Core compiles one statement per combination rather than one
  statement with a null-tolerant predicate, because the null-tolerant form costs the index. The number
  of optional filters per query is capped for that reason.
- ordering is declared, and paging is by key rather than by offset. Core issues the cursor and reads it
  back; an Add-on passes it on without being able to see what it is made of.
- a write declares what it returns.
- a named sequence of queries runs as one transaction. Without one, every write stands alone and no
  invariant spanning two tables can hold.
- a join reaches only the Add-on's own tables. A join onto a Core table would fix Core's shape inside an
  Add-on and undo what the symbolic reference just bought; what an Add-on may know about a user comes
  from a Core service.

Result types are generated from the declared queries at the Add-on's own build time, by the SDK of
section 3, because an Add-on is built separately and cannot read `phi-server`'s generated artifacts.

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
package leave the schema and its rows untouched. `phis addon purge` drops the schema, clears the
Add-on's Site assignments and applied-version rows, and deletes its catalog row -- which takes the
Add-on's stored secrets with it, because credentials for something no longer installed have no reason to
stay readable.

Simple Add-on documents may use mediated Module Storage instead of dedicated tables. Module Storage
remains Site- and Add-on-scoped, schema-validated, quota-limited, audited, and inaccessible through raw
SQL.

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
often than what it protects. An instance that cannot resolve its root key does not report ready under
section 17 and receives no traffic, rather than accepting requests whose secrets it cannot read.

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

`phis-cli` completes global activation only after the expected release is ready on all serving
instances or old instances have left the load balancer.

Failure behavior:

- unknown or disabled Add-on/path: `404`
- enabled but absent or incompatible on the receiving instance: `503`
- temporarily unavailable external hook: `503` so retry-capable providers can redeliver

Capability responses include local release identity so rollout drift is attributable.

## 18. Threads and Resource Links

Threads and Resource Links are Core services rather than Support-owned Add-ons.

Threads provide:

- Site ownership
- subject and lifecycle
- participants
- visibility and authorization
- messages
- read state
- namespaced Resource References
- audit events

Resource References identify domain objects without importing their Module:

```text
provider: @phis/support
kind: ticket
externalId: 4711
```

```text
provider: @phis/github
kind: issue
externalId: owner/repository#123
```

Resource Link projections may expose normalized label, URL, semantic status, icon key, synchronization
state, and last synchronization timestamp. Core stores and authorizes the generic relation; the owning
Add-on resolves provider-specific state.

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
Required capability: @phis/phi-server/support:v1
Required capability: @phis/phi-server/threads:v1
Required capability: @phis/phi-server/resource-links:v1
Server Add-on:       none
```

### GitHub

```text
Site package:        @phis/github
Site Module:         @phis/github/modules/github
Server binding:      @phis/github
Server package:      @phis/github-server
Provided capability: @phis/github/issues:v1
Core requirement:    @phis/phi-server/threads:v1
Core requirement:    @phis/phi-server/resource-links:v1
```

## 21. Non-negotiable invariants

- Site/client extensions are Modules; server extensions are Add-ons.
- Every physical Add-on package has the `-server` postfix; a direct counterpart to `@scope/name` is
  `@scope/name-server`, while its logical Add-on id remains `@scope/name`.
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
- Load-balanced activation is release- and instance-aware.
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
