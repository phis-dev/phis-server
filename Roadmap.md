# phis (phi server) roadmap

## Target Architecture

`phis (phi server)` is the central control plane for the platform family.

It is not the public site frontend and not the commerce engine itself.
Its responsibilities are:

- super-user administration
- site registry and site metadata
- shared internal APIs
- orchestration of site apps and Medusa instances
- bootstrap/setup flows
- shared database-backed configuration

Bootstrap and scaffold repair now have a concrete CLI contract in [BOOTSTRAP.md](./BOOTSTRAP.md). The intended control-plane entrypoints are `phis init` and `phis reconcile`.

The implemented scaffold foundation already materializes the canonical thin App Router/runtime-module
wrappers without a `phis-site-skeleton` checkout, writes the required base package metadata, repairs
CLI-owned files from a versioned manifest while preserving Site runtime secrets and unknown Site-owned
files, removes foreign package-manager lockfiles, and lets `phis update` install, typecheck, build, and
emit a local immutable standalone artifact. The remaining P1 work is limited to transactional first-Site
registration/bootstrap, release-derived dependency and optional-Module resolution, a real install/build
end-to-end regression, and health-checked rolling deployment/rollback across configured Instances.

Core `groups:v1` remains available independently of scaffold generation. The optional `@phis/groups`
Module enters a Site only through an explicit `phis-cli` Module operation and generated external build
state; it is never part of the base scaffold by implication.

The platform is split into four application types:

- `phis`
  - central control plane
  - own Next.js application
  - intentionally lightweight admin UI
- site apps
  - one concrete Next.js application per public site
  - examples: `phisys.com`, `phi-systems.tech`, `moonhug.ch`
- `phis-medusa`
  - Medusa-based commerce application
  - separate repo and separate runtime
- shared packages
  - reusable npm/workspace packages such as `@phis/shared-ui`, helpers, proxies, plugin contracts

## Core Principles

- Keep applications separate at runtime.
- Keep reusable code separate from deployable apps.
- Do not make `phis` depend on site-specific UI stacks unless explicitly required.
- Prefer explicit contract changes over compatibility shims. ABI breaks are acceptable when they preserve a coherent target model.
- Keep the public sites source-based and independently developable.
- Treat Medusa as an external commerce service from the perspective of `phis`.

## Open Contract Cleanup

- Add a `phis-cli` emergency recovery operation that can enable or disable a Site user membership by
  Site and user identity; the current CLI can change Site and platform-operator state, but not Site-user state.
- Keep site-scoped request resolution separate from public, site-agnostic helpers.
- Done 2026-08-17: `x-phis-site-key` is the only Site identity. The host/origin/referer fallback and
  `getSiteByHostname` are removed from the generic site resolver; a request without the explicit key is
  simply not Site-scoped, and `tr()` and other global lookups stay outside the site context contract.
- Audit remaining `throw new Error(...)` paths in shared helpers and storage code so route handlers can keep using structured `phi-server` log events instead of letting internal exceptions surface as raw runtime errors.
- Prefer explicit result/return contracts over unhandled exceptions for route-adjacent helpers where the failure is a normal operational case rather than a programmer invariant.

## Logging Contract

- Move site-scoped operational logging to native journald fields where possible so `siteKey` is filterable before JSON parsing in `/admin/logs`.
- Keep `phi-server` structured log events as the source of truth for payload details, but avoid relying on `siteKey` only inside the serialized JSON body for operational filtering.
- Make upload/finalize failures, media route failures, and similar site-bound errors emit a parsable site identifier at the transport layer so the admin log reader can select the relevant site first and apply secondary filters afterwards.
- Treat local `phis-ui` proxy logs as host-local transport only for now; if `phi-server` and the site app are not co-located, add a reusable ingest transport later instead of relying on shared filesystem or journal access across hosts.

## Media Upload Transport

- The current `Next.js` proxy body limit is only a short-term bridge for large media uploads.
- The long-term upload path should avoid sending large file bodies through the site Next proxy.
- Preferred target directions:
  - direct-to-storage uploads with presigned URLs
  - or a same-origin upload front door implemented outside Next, e.g. nginx or a dedicated upload service
- The upload-session contract in `phi-server` should remain the stable coordination point regardless of the transport layer.
- Restricted media delivery still needs the signed-URL flow to be implemented end to end, including generation, verification, and browser-facing delivery for `restricted + private` assets.

## Application Boundaries

### `phis`

`phis` is a dedicated app with its own repository and deployment artifact.

It owns:

- super-user login and session handling
- bootstrap/setup flows
- site records and site runtime metadata
- assignment of sites to domains, repositories, and Medusa backends
- orchestration actions such as create site, register site, connect Medusa, and run internal admin workflows

It does not own:

- the public site frontend implementation
- site-specific Ant Design pages
- Medusa product/order runtime

### Site Apps

Each public site is its own Next.js repo and its own deployable unit.

Examples:

- `phisys.com`
- `phi-systems.tech`
- future sites

Each site app may depend on:

- `next`
- `react`
- `antd`
- `@phis/shared-ui`
- other `@phis/*` or `@phiplugin/*` packages

Each site app is built and deployed independently from `phis`.

### `phis-medusa`

`phis-medusa` is a dedicated Medusa application:

- separate repo
- separate build
- separate deployment artifact
- separate runtime and operational lifecycle

It may consume shared `@phis/*` packages where useful, but it remains an application, not a library.

### Shared Packages

Reusable packages are published separately from the apps.

Examples:

- `@phis/shared-ui`
- `@phis/next-proxy`
- `@phis/cms-contracts`
- `@phis/medusa-bridge`
- `@phiplugin/*` packages for optional extension points

Packages are developed locally with `pnpm` and may be published to npm for consumption via `pnpm`, `npm`, or `yarn`.

## UI Strategy

### `phis` UI

`phis` should not inherit Ant Design automatically just because public site apps use it.

Preferred direction:

- native HTML as the base
- small custom React admin components
- lightweight global admin stylesheet
- explicit, limited dependencies

Reason:

- `phis` is an ops/control-plane application
- the public site design system should not dictate the control-plane runtime
- keeping the admin UI small reduces bundle weight and coupling

### Site UI

Public site apps may continue to use:

- `Ant Design`
- `@phis/shared-ui`
- site-specific components and themes

This overhead belongs in the site app containers, not automatically in `phis`.

## Routing Model

### Public Sites

- `phisys.com` -> site app
- `phi-systems.tech` -> site app
- future site domains -> corresponding site app

### Control Plane

`phis` should expose the super-user UI either:

- on `/operator` within the `phis` app, or
- on dedicated admin hosts such as `admin.<domain>`

The important point is that the operator UI belongs to `phis`, not to Medusa Admin.

### APIs

- `phis` owns its internal/shared API surface
- Medusa owns commerce APIs
- site apps proxy to those backends explicitly
- no hidden base URL fallback behavior

## Configuration Model

### Bootstrap Configuration

Database credentials needed to connect initially cannot live in the database itself.

Therefore `phis` needs a bootstrap configuration layer outside PostgreSQL, for example:

- local bootstrap config file
- operator-provided environment variables

Use this only for connection/bootstrap concerns such as:

- PostgreSQL host
- port
- user
- password
- database name
- optional SSL mode

### Runtime Configuration

Once the database is available, runtime and site configuration belongs in PostgreSQL:

- sites
- domains
- Medusa base URLs
- publishable keys
- site metadata
- role assignments
- admin configuration

Do not treat `.env.local` as a runtime config database.

Operational policy:

- hard runtime config should be considered stable for the lifetime of the running process
- `runtime.containerized` may be shipped as tracked config; if missing it defaults to `false`
- `bootstrap.enabled` may be shipped as tracked config when intentionally part of the default deployment state
- config-backed platform super-users are allowed as the explicit exception and should be read fresh for authentication
- soft integration config changed inside the admin UI may be applied directly by the corresponding save flow without building a generic config-reload subsystem
- process-critical config changes should use an explicit restart or reinitialization path instead of hidden automatic reload behavior

## Authentication and Roles

### `phis`

`phis` owns its own internal admin/control-plane auth.

Target role model:

- global `super_user` capability for platform orchestration
- site-scoped roles for site-specific administration where needed

The existing site-scoped role model remains useful, but `phis` also needs a global control-plane capability above site scope.

### Medusa

Medusa remains responsible for commerce/customer identity and commerce workflows.

Medusa is not the primary orchestration layer for platform-wide super-user administration.

If site-specific backoffice access is needed later, it should be modeled deliberately rather than assuming Medusa Admin RBAC solves it by default.

## Multi-Site and Medusa

Supported target modes:

- one shared Medusa instance for multiple sites when central catalog/commerce operations are desired
- one Medusa instance per site when strong operational isolation is required

`phis` should model Medusa as an external integration target:

- site -> Medusa backend mapping
- site -> commerce feature enablement
- optional future support for multiple Medusa instances

## Packaging and Distribution

### Applications

Applications are not published as npm library packages.

This applies to:

- `phis`
- `phis-medusa`
- each site app

Primary distribution targets for applications:

- Docker images
- optional Debian packages for standardized Debian/Ubuntu operations

### Packages

Reusable code is published through npm scopes such as:

- `@phis/*`
- optional `@phiplugin/*`

Current direction:

- move shared publishable code toward `@phis/*`
- keep app repos separate from package repos

### Why Not Publish the Apps Themselves to npm

Apps are operational artifacts, not normal reusable libraries.

They require:

- runtime configuration
- secrets
- service management
- database/bootstrap handling
- reverse proxy integration

Those concerns are better handled through Docker, Debian packaging, and Git-based source distribution.

## Hot-pluggable Add-ons

**Done.** Installing an Add-on used to require a `phi-server` rebuild, because
`src/generated/addon-build-manifest.ts` was a generated source file whose `import()` targets were
compiled into the build -- and a rebuild stops every tenant on the shared instance. Add-ons are now
loaded at runtime from the install root; [ADDON_HOWTO.md](./ADDON_HOWTO.md) is the guide, and
SERVER_ADDONS.md sections 6, 7, 9, and 11 carry the rules.

The measurements that led there are kept below, because they are also the record of what the design
costs and where it still has gaps.

### What was measured (2026-08-30)

A stub package that did not exist at build time, in a directory outside every build trace, against a
real `output: "standalone"` build of this app, loaded through a temporary probe route:

| Variant | Result |
| --- | --- |
| `file:` URL + `/* turbopackIgnore: true */` | loads |
| bare package specifier | `ERR_MODULE_NOT_FOUND` -- resolution starts in `.next/server/chunks/` |
| package tree with own `node_modules`, resolved via `createRequire` | loads |
| package created *after* the server process started | loads, no restart |
| missing module | ordinary catchable `ERR_MODULE_NOT_FOUND`, process unaffected |
| SHA-256 of the artifact before loading | 0.35-0.8 ms for a small file |

Turbopack leaves both dynamic imports native in the standalone output -- the compiled chunk contains
`await import(e)` verbatim, with no bundler wrapper, no warning, and no build error. `turbopackIgnore`
is a supported feature here, not an escape hatch.

Two incidental findings: a route folder with a `_` prefix is a private folder and is not routed at
all, and the standalone server refuses to start without `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.

### The seam

The dispatcher already calls `entry.load()` per dispatch rather than at module init, so the loading
*moment* is already at runtime. Only the manifest table is static. Consequences for the design:

- `load` must resolve a `file:` URL. A bare specifier cannot work, because resolution begins inside
  `.next`. This suits the intended rule: the path is derived from the Add-on id under a fixed install
  root, never stored as a specifier.
- The database stays a selector over that directory and never becomes a code loader. The registry
  already carries package name, version, and manifest digest; the digest binds the selector to the
  artifact and is verified before the load.
- Both delivery shapes work. A single bundled file is preferred -- one hash, no foreign dependency
  resolution -- but a package tree is not a dead end.
- "Enabled in the database, artifact missing" degrades into a scoped diagnostic on its own.

### Version selection and lifecycle

The specifier is built from registry state at dispatch time, so the active version is simply part of
the URL: `<install-root>/<addon-id>/artifact.mjs?v=<digest>`. The moment the registry names a new
digest, the next dispatch constructs a different specifier and Node loads the new module. The digest
is the better version key than a semver string, because identical code reuses the same instance and
rollback is idempotent. Requests already in flight finish on the version they resolved, which is the
desired behaviour rather than a limitation.

This makes the registry read, not the loader, the thing that needs care: a per-request database round
trip is not acceptable, so the snapshot needs an explicit invalidation path.

Node cannot unload an ES module, which splits the lifecycle:

- **Upgrade** works in-process through the versioned specifier. The superseded version stays resident.
  Measured cost: 150 loads of a 206 KB module grew the heap from 42 MB to 130 MB -- roughly three
  times the artifact size per version, never reclaimed. Acceptable for occasional and security
  updates; a periodic rolling restart is what clears it.
- **Disable** is immediate for request handlers, because the loader is simply never called again.
- **Resident artifacts are not**. Declared `jobs`, timers, listeners, and pools survive both disable
  and upgrade. An Add-on that owns any of them needs a lifecycle hook, and until that exists the honest
  answer for those is a restart.

### Keep the sidecar door open

In-process loading puts foreign code in the shared process that carries every tenant -- a hang, a leak,
or a native crash takes all of them down. An Add-on that needs no in-process server code should be able
to run as a sidecar instead: its own process or container, addressed over the existing catch-all routes.
That makes hot-plug easier rather than harder, because a sidecar can be stopped, and it removes the
unload problem entirely.

The split follows the artifact kind, not the Add-on:

- routes, hooks, and jobs are process-isolable
- service providers are not, because they hand back an object with methods on a hot path

Nothing in the contract should assume in-process loading as the only shape. Manifest, registry, digest
verification, and dispatch stay the same either way.

### End-to-end probe with a real test Add-on

A standalone package outside the workspace -- two tables, six API routes, one hook, no runtime
dependency of any kind -- was installed, migrated, enabled, exercised, and removed again.

What held up without a single correction:

- The declarative schema produced the intended database. Core added `site_id`, its foreign key, its
  cascade and its index; resolved the symbolic `core.user` to `phis.user_accounts(id)` at Core's own
  width; and derived both check constraints from the structured descriptors.
- Routes dispatched through the fixed catch-all with path parameters bound and the actor resolved.
- The manifest passed validation on the first attempt.
- The reverse path enforces its own order: `purge` refuses while the Add-on is installed, `remove`
  refuses while it is enabled. `disable` -> `reconcile` -> `remove` -> `purge` dropped the schema and
  every record.

Three findings came out of building it:

- **The contract is compile-time only.** The compiled Add-on contains no external import at all. But
  `@phis/contracts` is `private: true` and unpublished, so a real third-party Add-on cannot
  declare a dependency on it. It has to be published before anybody outside this workspace can build
  against the ABI.
- **`phis addon install` only accepts a registry-resolvable specifier.** It runs `pnpm add <name>`,
  so a local tarball, a `file:` package, or a private-registry artifact cannot go through the CLI's
  install path. The package and the desired-state entry had to be placed by hand.
- **The Add-on runtime is bundled into the build.** Because the generated manifest's `import()` target
  is a static analyzable specifier, Turbopack compiles the Add-on into a server chunk rather than
  resolving it from `node_modules` at runtime. That is the concrete reason installation needs a
  rebuild today, and it confirms where the seam has to be cut.

### Failure behaviour, measured

- A handler that throws answers 503 with the request id. The process stays healthy.
- A handler that never returns answers 504 at exactly its declared `timeoutMs`.
- **The timeout does not cancel the handler.** `invokeHandler` races the handler against a timer, so
  the client is answered while the work continues. Sixty abandoned handlers cost 14.4 MB of RSS and
  kept running to completion long after their 504. The request context does carry an `AbortSignal`
  a handler can honour, but nothing obliges it to, and a handler with side effects will commit them
  after the caller has been told the request failed.

### Multi-instance, measured

Two standalone instances against one database, the registry reporting the Add-on as enabled:

- the instance whose build carries the Add-on answers 200
- the instance whose build does not answers 404

Behind a load balancer that is a coin flip per request. Two further observations make it worse before
it gets better:

- **`phis.server_instances` is empty.** The table has `release_build_id`, `addon_manifest_digest`,
  `addon_packages_json`, `flags`, and `last_seen_at` -- the readiness model is designed, but nothing
  writes or reads it.
- **`reconcile` is driven by the desired state, not by the build.** It reported two Add-ons while the
  built manifest carried one, so a release cannot currently say "this build does not carry that
  Add-on".

Closing that gap is a precondition for runtime installation, not a refinement of it: an Add-on must
not be reported as active until every instance has confirmed it holds the artifact. The build carried
that guarantee for free.

Live gating, on the other hand, already works as the design needs it to: `disable` followed by
`reconcile` took effect on a running instance without a restart, and `enable` brought it back. The
registry -- not the `enabled` flag baked into the build manifest -- is what decides at request time.

### Still open

- the sidecar shape: nothing has been prototyped out of process yet.
- publishing `@phis/contracts`, so a third party can build against the ABI at all.
- writing and reading `phis.server_instances`, and gating activation on every instance confirming it
  holds the artifact. This is the one gap that has to close before an Add-on may be installed into a
  multi-instance deployment.
- an install root guaranteed free of `node_modules` on any ancestor path.
- **the Site's half of the Storage Profile surface.** `phis storage` covers the operator's half; the
  selection beyond the Site Space, the presigned/proxy choice, and an in-process CORS reconcile are
  still missing. See below.

Closed since: `phis addon upgrade` (versions side by side, digest as the module's cache key, rollback
by upgrading to the older artifact); the return channel for an upload the browser could not deliver
(`POST uploads/[token]/report`, with the log event behind it); and a browser-reachable storage endpoint
(`publicEndpoint` signed over, nginx vhost, bucket CORS derived from `sites.public_base_url`).

### Two shapes, and only one of them exists

Decided on 2026-08-30, after measuring what a dependency actually costs an artifact.

Ordinary npm dependencies are the normal case and bundle: `@aws-sdk/client-s3` came out as one 1.3 MB
file, `sanitize-html` as 529 KB, and a GitHub Add-on for tickets needs nothing beyond `fetch` and
`node:crypto`. What does not bundle is narrow: native binaries, and packages that read their own files
at runtime. Both bundle *without error* and fail when loaded.

The workaround -- mark the package external, put a `node_modules` beside the artifact -- works;
`sharp` loaded that way and produced a PNG. It was rejected anyway, because of what the measurement
showed next: Node resolves a bare specifier by walking up, and an artifact placed under
`<PHIS_ROOT>/addons/` imported `pg`, the server's own PostgreSQL driver, successfully. The
single-file rule is therefore not only about distribution and integrity. It is what makes "no import of
anything outside the artifact" a property rather than a promise.

So there are two shapes and no third:

- **In-process (A)** -- one self-contained artifact, no bare import except `node:` builtins. This is
  what exists, and it covers everything that bundles.
- **Sidecar (C)** -- a separate process for an Add-on that genuinely needs a native binary or its own
  runtime. **Planned, not built.**

The sidecar is cheaper than it sounds, because it reuses the whole installation machinery: the Add-on
still installs an artifact, only that artifact carries the manifest and a sidecar declaration instead
of handlers. Install, digest, registry, migration, activation, and deactivation stay identical, and
only the invocation changes -- the catch-all forwards instead of calling in-process. It also solves the
unload problem and shrinks the blast radius, because a process can be stopped.

Two things it cannot do, and they bound what it is worth: a sidecar cannot carry a service provider,
because those hand back an object with methods on a hot path; and it needs a lifecycle -- who starts
it, who watches it, what happens when it is gone. A storage provider with a native dependency falls
through both shapes and stays Core's business.

Nothing needs the sidecar today, so it waits for the first real case. The cost of adopting the rule now
is having to say no to a native dependency until then.

## Storage Profiles have no write path

Where the physical storage is configured is settled: the row is. `phis.media_storage_profiles.config`
holds `rootDir` and `storageKeyPrefix` for Local, and endpoint, bucket, region, prefix, access key id
and `publicEndpoint` for S3 -- the secret only as a reference. Which profile a Space uses is
`media_spaces.default_storage_profile_id`, and every file additionally records its own
`media_assets.storage_profile_id`, which is why nothing derived follows a later change of default.

Local has a default and needs no configuration at all:

```text
1. profile.config.rootDir            the row
2. media.local.rootDir               config/phis-runtime.json
3. <PHIS_ROOT>/storage/media         built-in fallback
```

The Local profile is seeded lazily -- by the first `ensureSiteMediaSpace`, `ensureGroupMediaSpace` or
`ensureUserMediaSpace`, not by `phis site add` -- and the seeding fills an empty row only:

```sql
SET config = CASE WHEN config = '{}'::jsonb THEN EXCLUDED.config ELSE config END
```

Afterwards the row is authoritative and the configuration is never consulted again, so changing
`media.local.rootDir` later changes nothing.

That used to be the whole write path. `phis storage` closes the operator's half of it:

```text
phis storage list --site <key>
phis storage add  --site <key> --key <profile> --provider <id> [--config <json|@file>] [--secret-name <name>]
phis storage set  --site <key> --key <profile> [--config <json|@file>] [--replace] [--secret-name <name>]
phis storage use  --site <key> --key <profile>
phis storage del  --site <key> --key <profile>
```

Two properties are worth keeping when this is touched again:

- **Nothing in the CLI knows what an S3 Profile needs.** The configuration is handed to the very factory
  Core resolves at runtime, reached through the installed artifact, with a context whose secret accessor
  throws -- constructing a Provider must not need a credential. What the CLI accepts and what the Server
  accepts therefore cannot drift apart, and the refusal an operator reads is the Provider's own words.
- **`set` merges.** Changing one endpoint should not mean retyping a bucket; `--replace` is how a
  removal is said out loud.

`del` refuses while a Space or an Asset still points at the Profile, because those rows are what says
where the files are.

Still on the Site's side of the split, and still open:

- **the selection.** `use` sets the Site Space only, because an operator has to be able to bootstrap the
  first Profile before any Site surface exists. Which Profile a user's or a group's Space uses, and
  `phis.site_media_config.allowed_storage_profile_ids`, are Site administration and want the Module
  counterpart in the UI.
- **presigned PUT versus proxied stream.** There is no field for it anywhere; the S3 adapter always
  answers `presigned-put`.
A Site surface that writes a Profile is in-process and should reconcile CORS the same way `add` and
`set` already do -- through `reconcilePhiMediaStorageCorsWith`, which both the CLI and
`POST /api/v1/media/cors/reconcile` call. Only how a Provider is reached differs between them: the
Server resolves one through its own registry, the CLI through the installed artifact. The derivation,
the grouping by `storageIdentity()` and the failure handling exist once.

## Core services for Add-ons

An Add-on declares `requiredCoreCapabilities` in its manifest, Core keeps a list of the capabilities it
offers -- `auth:v1`, `threads:v1`, `resource-links:v1`, `support:v1`, `groups:v1`, `storage:v1`, each
with its own digest -- and the dispatcher refuses an Add-on whose declared capability this release does
not carry.

**Behind those declarations there is nothing.** An Add-on states that it needs `groups:v1` and then has
no way to read a group. The declaration half exists; the delivery half does not, and building it is what
turns the capability list from a compatibility gate into an extension surface.

### Where it goes, and where it does not

Not into `@phis/contracts` as runtime code. An artifact is one self-contained file with no bare
imports, so anything the contract exported would be **compiled into every artifact** -- copied rather
than shared, frozen at the version it was built against, and a correction Core makes tomorrow would stay
wrong in twenty artifacts. It could not reach data anyway: the request context carries no database
handle by design, so such code would have to call back into Core, and then the contract only needs to
describe the shape.

The package's admission rule survives with one clause added: *nothing enters unless an Add-on must
declare it **or Core must offer it**; still no implementations.* That widens the package from "what an
Add-on states" to "what Add-on and Core agreed on", which is a boundary rather than a toolbox.

The delivery is a services object on the request context. Two properties make it safe by construction
rather than by review:

- **It carries only the capabilities the Add-on declared.** An Add-on that never stated `groups:v1` has
  no `groups` on its context -- not forbidden, absent. The declaration finally does something.
- **It is built per request and bound to that request's `site` and `actor`.** A user lookup can then
  only see this Site, and only what this actor may see. Without that binding it is a second,
  unaudited data API, and an Add-on route declaring `auth: "internal"` could read the user table.

What must never be in it: a pool, a transaction or any other handle; SQL in any form; another Site, not
even behind an id argument; and writes to Core-owned data, which belong to Core's own operations with
their own rules rather than to a generic setter.

Two edges to keep in mind. A declared job runs without a request and therefore without the actor that
makes the query surface safe, so it needs a narrower surface of its own or none. And a sidecar should
receive the same interface over a different transport -- designed in now, a sidecar is a transport
change later; designed in later, there are two surfaces drifting apart.

### Do not invent the catalogue

The admission rule exists to stop a junk drawer, and it should hold here too: nothing enters before a
real Add-on needs it. Twenty methods designed from imagination produce eleven that were cut wrong, and
every correction costs a rebuild of every artifact. The first real Add-on is the forcing function.

`images:v1` does not exist yet and will have to. Native dependencies are excluded from artifacts, and
`sharp` was the example -- so an Add-on that needs image work currently cannot do it at all. That is not
a convenience missing, it is a class of Add-on that is impossible.

## Marketplace, and distribution generally

The first real Add-on candidate: a marketplace for Add-ons and Modules. It is worth building for its own
sake, and it is a good forcing function because it exercises both halves of the platform at once -- a
schema with real relations, two content kinds of which one is not an image, artifact-sized uploads,
authenticated delivery, identity, and a UI Module with real client code.

Build it in stages, because the whole of it at once would design the Core services surface under
pressure from the most complex case:

1. **Catalogue and delivery** -- product, version, name, description, binary, image. Forces `storage:v1`
   and almost nothing else, which is exactly the capability with no workaround available today.
2. **Identity** -- who may download what. Forces `auth:v1` and `groups:v1`.
3. **Ratings** -- technically the least interesting and socially the most: one rating per user per
   product, moderation, abuse. Worth deferring until there are products to rate.

### The marketplace is one provider among others

`phis-cli` must install, upgrade and reconcile with no marketplace in the picture at all. A company may
build an Add-on and offer it themselves, and nothing about that is a lesser path.

The shape that keeps this true is one level below "pluggable sources", which would be a second extension
mechanism and is exactly what the contract forbids inventing:

> The primitive is `--artifact <local file>`. A URL, a marketplace, a private registry all **resolve to
> a local file** before the install logic begins. A provider is a way to obtain bytes, never a way to
> install them.

There stays exactly one install path, a provider implements nothing, and the digest check runs after the
bytes land -- identically, whatever they came from. Verification cannot trust a marketplace more than a
file on disk, because it cannot tell the difference.

Independence has three levels, and the third is the one lost in practice:

1. With no marketplace configured, everything works.
2. Without a network, everything that needs no bytes works. `reconcile` must never reach one; neither
   must `migrate`, `enable` or `remove`.
3. With a configured but unreachable marketplace, everything except `--from <url>` works.

The third breaks the moment a provider call slips into a shared path -- a version check, an "is there an
update?", a line of telemetry. **No provider call belongs on the path of install, upgrade, remove,
reconcile, migrate or enable.** Update *notification* is a separate command and may go hungry offline.

### Trust anchors, and what publishing implies

If a company distributes its own Add-on, "it is on the marketplace" cannot be the security claim.
The operator decides which key to trust; marketplace membership is a pre-trusted key, a convenience. The
alternative writes a security claim into the marketplace that it cannot carry, and makes a
self-distributed Add-on look weaker than it is when the verification is the same.

This makes publishing `@phis/contracts` a precondition rather than an open item: while it is
`private: true`, nobody outside this workspace can build against the ABI at all.

And the CLI must never depend on the marketplace. If the marketplace is itself an Add-on on the shared
server, a broken marketplace would otherwise block repairing Add-ons. `--artifact <local file>` is the
primitive that works without it.

## Modules are not hot-pluggable, and that is the right trade

Confirmed 2026-08-30. A Module cannot be installed into a running Site the way an Add-on can be
installed into a running server.

The wall is not the RSC manifest: `PhiRuntimeModuleRenderClientHost` already decouples the server, which
emits only the host while the browser resolves a string key. The wall is the shared scope -- React, antd
and the `@phis/ui` runtime would have to be singletons available to an externally loaded bundle. That is
solved technology (import maps, module federation), but it demands a **runtime ABI** from `@phis/ui`
rather than a compile-time API, and such a break surfaces in a visitor's browser weeks later rather than
in the tenant's build.

The trade runs the other way from the server, and that is what settles it:

| | blast radius of a rebuild | value of hot-plug |
| --- | --- | --- |
| `phi-server` | every tenant on the shared instance | high |
| Site instance | one tenant, their own code | low |

A Site rebuild is an ordinary deploy of one company's own application. Measured: 29.7 s to compile, cold
and warm alike. `phis-cli` building on request and restarting that one Site is therefore not a fallback,
it is the correct mechanism.

### Two clocks, and the ordering that follows

An Add-on and its UI Module are one product and two deployment units with different latencies: the
server half goes live in seconds without a restart, the Site half needs a build and a rolling restart.

The ordering falls out of that: **activate the server half first and the Site half second; deactivate in
the reverse order.** Otherwise the UI calls routes that do not exist yet.

The coupling is already modelled -- a Module binds to exactly one Add-on and declares versioned server
capabilities, and unavailable capabilities deactivate only the dependent Module with a scoped
diagnostic. A Module switches itself off when its Add-on is absent. The half-active state is foreseen;
it has simply never been exercised.

For several instances of one Site the Module half is a rolling deploy of an immutable artifact, which is
already the planned mechanism: `phis update` emits one, and health-checked rolling deployment and
rollback across configured Instances is the remaining P1 work rather than something new.

**A product that carries both halves must not present them as one operation.** Two buttons that look
alike and differ by orders of magnitude in duration produce support cases. One click, two operations,
different durations, defined order -- decided before the button exists.

## Docker Model

Docker is used per application, not for a generic standalone "Next.js service".

Correct unit of deployment:

- one container for `phis`
- one container per site app
- one container for `phis-medusa`

In other words:

- `phisys.com` is a Next.js app and can be deployed as its own Docker container
- `phis` is its own app and can be deployed as its own Docker container
- `phis-medusa` is its own app and can be deployed as its own Docker container

The source repos are still needed to build the images.
The built image is the runtime artifact.

## Site Lifecycle

The long-term super-user flow should look like this:

1. Operator deploys `phis`.
2. `phis` bootstrap/setup initializes connection and core records.
3. Super-user creates or registers a site.
4. Site repo is created, linked, or loaded from a known template/source.
5. Site repo declares its own dependencies such as `antd` and `@phis/shared-ui`.
6. Site app is built and deployed as its own artifact.
7. Site is mapped to domains and optional Medusa backend in `phis`.

`phis` orchestrates this lifecycle.
It should not absorb the full runtime dependency graph of every site.

Infrastructure-specific provisioning should be split from the web UI:

- `phis` stores the site record, site metadata, and deployment hints
- `phis` may render operator-facing snippets and ready-to-use config files for:
  - `nginx`
  - `apache`
  - `systemd`
  - `docker compose`
- the actual host-level provisioning is performed by the system operator or a dedicated host-side script

This separation is intentional:

- the normal web process should not have direct write access to `nginx`, `systemd`, or arbitrary site directories
- infrastructure actions are runtime-specific and should not be hard-coded into the generic web control plane
- a mistake in privileged web-triggered operations would affect the full host, not just one site record
- keeping provisioning outside the web process makes review, rollback, and debugging much clearer

## Repository and Package Direction

Recommended naming direction:

- apps stay as dedicated repos
- shared packages move toward `@phis/*`

Examples:

- `@phis/shared-ui`
- `@phis/next-proxy`
- `@phis/cms-contracts`
- `@phis/medusa-bridge`

If a dedicated public plugin ecosystem is desired later, `@phiplugin/*` can be used for explicitly external plugin packages.

## Operations Model

Preferred near-term model:

- Debian host services for infrastructure
  - `nginx`
  - `postgresql`
  - `redis`
  - backups and monitoring
- Docker for applications
  - `phis`
  - site apps
  - `phis-medusa`

Optional later distribution:

- Debian packages such as `phis-core` and `phis-medusa`

That is complementary to Docker, not a replacement for npm packages.

### Debian Site Provisioning

For Debian-based host installations, `phis` should eventually ship a dedicated provisioning helper for site runtime setup.

Target direction:

- the admin UI generates clear instructions and pre-rendered config artifacts
- a host-side Debian helper such as `phis-cli` or `phis-provision-site` applies them
- new sites may be provisioned under a controlled runtime layout such as:
  - `/var/www/phis/sites/<site-key>`
- the helper may automate:
  - site directory creation
  - template/config rendering
  - `systemd` enable/start/restart for a site template unit
  - optional `nginx` site file installation and reload

This Debian helper is the right place for privileged automation.
The web UI is not.

### Debian Multi-Instance Packaging

If multiple `phis` instances should run on the same Debian host, the package must install the software only once and keep instances separate through their own roots.

Target direction:

- one Debian package installs the shared program files
  - `phis` CLI wrapper
  - application code
  - shared templates/assets
- each runtime instance gets its own root such as:
  - `/srv/phis/stages/prod`
  - `/srv/phis/stages/test`
  - `/srv/phis/stages/dev`
- each instance root contains its own:
  - `config/phis-config.json`
  - `config/phis-runtime.json`
  - optional `.env`
- `systemd` should use a template unit such as:
  - `phis@.service`
- concrete instances then run as:
  - `phis@prod`
  - `phis@test`
  - `phis@dev`
- the server process should receive its stage root through:
  - `PHIS_ROOT=/srv/phis/stages/%i`
- the central `phis` runtime should use a separate loopback port range starting at
  `5301` for the first stage and incrementing by `1` for each additional stage
- port allocation is a host-level convention and must not be inferred from stage
  names; `prod`, `test`, and `dev` are only examples
- the CLI must support:
  - `phis --root /srv/phis/stages/prod ...`
  - `phis --root /srv/phis/stages/test ...`

Operational implication:

- the Debian package should not implicitly create every possible instance
- instance initialization belongs to `phis-host`
- `phis-host` should know which stage roots exist on the local host and call the shared `phis` binary with the matching `--root`

### Host Integration Package

Docker and privileged host integration should be treated as a separate deliverable from the `phis` web app itself.

Target split:

- `phis`
  - web control plane
  - setup UI
  - internal APIs
- `phis-host`
  - host integration package
  - privileged helper scripts
  - runtime templates for `nginx`, `systemd`, and Docker/Compose

`phis-host` should also be multi-instance aware on a single host:

- one host may run several `phis` stages side by side
  - `prod`
  - `test`
  - `dev`
- `phis-host` selects the correct local instance root per stage
- the shared `phis` binary remains stage-agnostic and receives its context through `--root`

Privilege handling should stay inside `phis-host`:

- the Debian package may install templates and fixed integration points for `nginx`, `systemd`, and Docker
- `phis-host` should still own the orchestration logic for enable/disable, reload, and lifecycle commands
- when run without sufficient privileges, `phis-host` should tell the operator to rerun the same command with `sudo`
- operators should not have to translate a failed `phis-host` action into lower-level host commands by hand

`phis-cli` should stay inside the main `phis` repository:

- operator-facing CLI
- non-privileged config and bootstrap helpers
- shared config/schema/auth logic close to the web app codebase

Reason:

- Docker lifecycle and host provisioning do not belong inside the normal web process
- host-level automation needs a controlled installation target and explicit privileges
- `phis-cli` should remain close to the shared `phis` code instead of becoming a separate product
- the same app may be deployed behind different runtimes, so host integration should remain modular
- Debian and Docker support can then share one host-tooling layer without pushing those privileges into `phis` itself

### Multiple hosts

Everything above describes one host running several stages. Multiple hosts serving one Site is the
same package's next responsibility, but it is three roles rather than one, and they need different
rights:

- **local and privileged** -- reload `nginx`, write a unit, unpack a release. Needs `root` on one host.
  This is `phis-host` as already described.
- **distributing** -- put a release on every host, health-check it, drain, promote, roll back. Needs to
  reach all hosts, which is the opposite of host-local. A package installed everywhere must not also be
  the thing that reaches everywhere.
- **round-robin itself** -- performed by the reverse proxy at request time, not by a tool. What tooling
  contributes is the upstream list: `phis` generates it because it knows the Sites, `phis-host` applies
  it because it holds the rights.

Distribution is pull, not push. Each host reads which release it should be running, fetches it, and
reports ready; no host holds credentials to another. The alternative -- one orchestrator with SSH keys
to the fleet -- is easier to build and is a master key for the whole deployment.

The existing design already points this way without naming it. `phis.server_instances` is a
self-report rather than a poll, and `SERVER_ADDONS.md` section 17 says every instance reports its own
release, manifest digest, package versions, and readiness. An instance that already writes to the
database can read from it. The server secret store makes the same argument from the other side: under
pull a new host needs exactly two things, the root encryption key and a database connection, and reads
everything else itself. Under push, secrets would go back to being files somebody has to copy to every
host -- the problem the store exists to remove.

Two prerequisites are easy to miss because nothing fails without them today:

- **the instance heartbeat.** `phis.server_instances` is declared and unwritten. Until an instance
  reports itself, no deployment can tell whether the fleet runs one release or three.
- **upstreams from healthy instances, not from configured ones.** Two instance notions currently exist
  and do not know each other: `SiteLocation` in `config/phis-runtime.json` states where a Site should
  be deployed, and `phis.server_instances` states what is actually running. `buildNginxConfig` resolves
  a single primary instance from the first. A round-robin upstream list has to come from the second, or
  the proxy will send traffic to a host that is mid-rollout or serving a different release.

Local object storage is the remaining blocker under either model: an Asset on one host's disk does not
exist for the others, which is why the S3 Storage Add-on is a precondition for more than one instance
rather than merely a storage option.

## Immediate Cleanup Decisions

- Block media deletes when the asset is still referenced by the same site's CMS tree.
  - `DELETE /api/site/media/:id` should traverse the full site tree before removing metadata or binary payloads.
  - The scan must include `sites.theme.brand.logoAssetId`.
  - The scan must include page trees, regions, layout nodes, widget configs, and nested config objects for both published and draft records.
  - If references are found, return `409 Conflict` with a compact list of usage locations instead of deleting the asset.
  - The v1 truth source remains the CMS tree; a separate media usage table can stay a later optimization if delete scans become too expensive.
- Remove architectural assumptions that place Ant Design at the center of `phis`.
- Remove vague wording that implies one generic `Next.js` container instead of one container per app.
- Remove undocumented config defaults or compatibility shims from active code paths.
- Avoid documenting database/schema split ideas that are not part of the chosen target model.

## Server Add-on Delivery

Completed foundation:

- strict Module, Add-on, Core, and single-provider binding contract
- scoped logical Add-on ids separated from physical server package names
- CLI-owned desired state and runtime loading from the install root
- fixed Add-on API and hook dispatch routes
- manifest/digest/route/auth/body-limit/rate-limit/timeout validation
- PostgreSQL deployment, capability, Site activation, migration-history, and instance tables
- Site-scoped capability discovery

Next implementation stages:

- execute reviewed package migrations through `phis addon migrate`
- add Site-admin enablement and non-secret configuration APIs for already deployed Add-ons
- report instance heartbeat/readiness and make CLI activation wait for the complete serving release
- expose scoped Core services, secrets, jobs, and storage through the handler context
- implement the Core Threads and Resource Links repositories behind their versioned capabilities
- validate the complete path with a `@phis/github` package carrying both halves

## Summary

Target platform shape:

- `phis`
  - central control plane
  - lightweight custom admin UI
  - Docker-distributed application
- site apps
  - separate Next.js repos
  - can use `Ant Design` and `@phis/shared-ui`
  - built and deployed independently
- `phis-medusa`
  - separate Medusa repo
  - separate deployment unit
- shared code
  - extracted into npm/workspace packages under `@phis/*`

This keeps the architecture explicit:

- apps are deployed as apps
- packages are published as packages
- `phis` stays operationally small
- public site UI dependencies do not automatically leak into the control plane
