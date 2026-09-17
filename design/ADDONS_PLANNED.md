# Planned Add-on Mechanisms

**Status: design.** Nothing in this document is implemented. The Add-on contract that holds today is
[SERVER_ADDONS.md](../SERVER_ADDONS.md); section numbers below refer to it unless another document is
named.

## 1. Capabilities an Add-on supplies

Section 1 already says a Capability is supplied by Core **or one Add-on**, and names
`@phis/github/issues:v1` as the example. The declaring half exists: a manifest states `capabilities`,
the registry records them under `provider_id`, and the snapshot reports per provider whether what a
Site's Modules require is being offered. That answers the Site UI. It does not reach a second Add-on,
because `requiredCoreCapabilities` is checked against Core's own list by name and the bound object a
handler receives is built from Core's capabilities alone.

This section is the other half, and the reason to have it rather than the alternatives. Two Add-ons
that must cooperate have three ways to do it and only one that survives uninstalling. Sharing a schema
is not it: every capability is bound to `{addonId, siteId}` without exception -- schema name, storage
prefix, secret owner, settings, roles, Media Space -- and that single rule is what makes purge,
uninstall and authority answerable locally. A reference count on a shared schema does not repair that;
it counts installations while the rows it is protecting were written by whichever holder has just left,
with a shape nothing now describes. Section 4 already refuses the smaller version of the same thing: a
schema name too long is rejected rather than shortened, because a truncated one would put two Add-ons
on one schema. Two Add-ons in one package is not an answer either. The ids stay separate, the schemas
stay separate, and the only thing gained is that neither can be installed without the other.

### Two shapes, and only one of them is a function call

What Core offers today divides cleanly, and an Add-on-supplied Capability almost always falls on the
second side:

- **A question** answers now. `roles.has`, `authorization.mayActOnRow`, `settings.read`,
  `secrets.read`. The return value is the answer, and there is no state anywhere.
- **Work** answers with a state. `assets:v1` is the worked example already in this document: `begin`
  hands back a reservation, the transfer happens outside the call, `finalize` settles it. Nothing is
  held open for the duration, and a caller that lost its answer can ask again.

Another Add-on is rarely called to learn a number. It is called to have something done -- fetched,
verified, converted, inspected -- and that is the shape a request cannot hold. A Capability that does
its work inside its call inherits whatever bound its caller happens to have, which for a job is the
operator's scheduler and for a route is a timeout declared by a route that knows nothing about the work.

### Minting an interface

A Capability id is scoped, exactly as an Add-on id and a route namespace are: `@scope/name:v<major>`.
Whoever publishes it first owns the name, and no second party may mint the same one -- the scope is
what makes that true without a registry Core has to arbitrate.

An implementer is not the owner. A second implementation declares **the origin's interface id** and
**its own provider key**, and those are two identifiers with two owners:

```text
@phis/artifact-inspector   provides @phis/artifact-inspection:v1  as  @phis/artifact-inspector/tarball
@acme/deep-inspector       provides @phis/artifact-inspection:v1  as  @acme/deep-inspector/tarball
```

The provider key is already required to be qualified by the Add-on that declares it, for the reason a
storage profile row gives: it is persistence identity. Two implementations of one interface therefore
cannot collide, can be installed side by side, and are chosen between by the operator's configuration
and never by Core picking one. Which is the same rule as section 10's, arrived at from the other end: a
result stays bound to the provider that produced it, so an automatic substitution would be Core
reinterpreting data it did not write.

The name lives in a scope rather than in a neutral registry because the alternative hides the owner
rather than removing one. Somebody has to publish what an interface means, and whoever does is its
owner whether or not the identifier admits it; an opaque id would only move that fact out of the name
and into a document, where an operator reading a diagnostic cannot see it. What an owner turning
hostile costs is bounded and known: a fork publishes the same shape under its own id and every consumer
moves by editing a declaration, because the shape did not change.

### The shape is published, not described

An Add-on that mints an interface **must publish its TypeScript declarations**. An interface is not an
implementation: `.d.ts` states what may be called and says nothing about how it is done, so this costs a
closed Add-on nothing it meant to keep. It is the arrangement this project already runs on -- `@phis/server`
is one package and `@phis/contracts` is another, and they are updated through npm independently on the
strength of nothing but agreed ids and published shapes.

They must be reachable without the implementation: a subpath that imports nothing at runtime, the way
`@phis/contracts` is cut into subpaths with no root export. Otherwise a second implementer's build
depends on the first implementer's dependencies, which is the coupling this whole section exists to
avoid.

`phis addon check` verifies that the declared types entry resolves. That is a presence check and not a
proof: types are erased, Core loads a bundle, and an implementation that never looked at the
declarations is indistinguishable from one that did. The same floor is already held elsewhere the same
way -- the published package guard checks that LICENSE and NOTICE reached `dist`, not what is in them.
What the requirement buys is not enforcement. It is that the shape is an artifact rather than prose, so
an implementer who gets it wrong made a choice instead of a reasonable reading.

### What is declared to Core

The provider declares the interface id and **the names of its members**. The consumer declares the same
id and **the members it actually calls**. Core checks that the consumer's members are contained in the
provider's, and that the provider's runtime object exports each of them -- the check it already makes
one level down when it holds `factoryExport` against the runtime's factory map and refuses a name that
is not there.

Nothing else is declared. Option names and parameter types were considered and left out: they would be
a second, poorer statement of what the declarations already say, they do not describe a return value at
all, and the vocabulary would have to grow at the first interface that passes bytes. A function
signature is not a bounded language the way SQL is, and the place to describe one is a `.d.ts`.

There is no interface digest. A Capability carries none for the reason section 1 gives -- the version
is in the id, a shape change raises it to `:v2`, and Core stops offering `:v1` -- and an Add-on-supplied
Capability is no different from a Core one in that respect. What a digest was standing in for is what
the published declarations now answer.

Declaring the members rather than only the id is what lets a diagnostic name the fault. A consumer
requiring a member the provider does not offer is reported as that, with the member named, instead of
as `incompatible`. A provider offering more than any consumer calls is the normal case and not a
finding.

### Reaching one

A consumer declares the supplied Capabilities it requires separately from `requiredCoreCapabilities`.
That field is checked against Core's registry by name, and widening it would make a missing Add-on look
like a Core release that had dropped something.

Core builds the bound object at dispatch, from the provider's runtime, closed over **the caller's Site
and the caller's actor**. This is the safety property the arrangement rests on. A provider running under
its own identity would let any consumer borrow its authority, and the row-level ladder the consumer was
measured against would end at the capability boundary. A job has no actor (section 12a), so a Capability
called from one is called with none, and a provider that needs somebody must refuse rather than
substitute itself.

The call is refused before the provider's code runs, by the list section 9 applies to a request: the
provider is not installed, is not enabled for this Site, is behind on migrations, or offers `:v2` where
`:v1` was required. The consumer sees a state, never a half-built object. A consumer installed before
its provider is not an error; it is `missing`, which section 14 already has a word and a diagnostic for.

Loopback HTTP between Add-ons remains what section 10 says it is: not an alternative.

### Work answers with a closed state

A work-shaped Capability returns a state from a vocabulary its declarations name, not a payload and not
a message. Free text is refused here for the same two reasons it is refused for a Module category. The
caller has to act on the answer without understanding the domain -- a catalogue must not have to learn
what a checksum is to know it should stop asking -- and a reason shown to a person has to be
translatable, which a string produced inside a provider can never be.

The vocabulary must distinguish **not yet** from **never**. An endpoint that did not answer is
transient; an archive with no manifest in it is not. Without that distinction a consumer either retries
forever or gives up on a network blip, and neither is recoverable by anything the consumer knows.

The caller polls and the provider is resumable. A work call does what it can within a bound the provider
declares, records where it got to, and answers `running`; the next call continues. The alternative --
the provider scheduling its own job and the consumer collecting later -- puts one state in two
schedulers and adds an entry to the operator's crontab for every pair of Add-ons that cooperate.
Resumability is the provider's private business either way, and one scheduled job driving the chain is
what an operator can reason about.

### The handle is the subject, not a ticket

`assets:v1` issues a random token because a reservation is about one transfer of one file, and there is
nothing else it could be named after. Most work is not like that: it is about a thing, and the same
thing asked twice is the same question.

Where a subject exists -- a content digest, a version, a canonical id -- the handle is derived from it
rather than issued. Asking twice then costs nothing instead of twice, two consumers asking about one
subject share one result, and a provider removed and reinstalled leaves no handle dangling, because the
next call is the same question rather than a lookup of a ticket nobody kept. It is the rule `finalize`
already follows when it recognises a finished upload by its object rather than by a counter.

### What a result is bound to

Section 10 states the rule for service providers: provider data stays bound to the concrete provider
identity that created it, removing a provider preserves that binding and fails closed, and Core must not
reinterpret it through a fallback. The same holds for a supplied Capability, and it is what replaces the
reference count a shared schema would have needed.

A consumer records **which provider produced a result and at which interface version**. When the
provider is gone the record stands and nothing re-derives it; when `:v2` arrives, a result carrying
`:v1` came from a different interface and is treated as one. Nothing is counted, because nothing is
shared: each Add-on owns its own tables, and what crosses between them is an answer with a provenance
rather than a row with two owners.

### Order

Deployment order between dependent Add-ons is the operator's, and Core states rather than arranges it: a
consumer whose provider is absent, disabled or behind on migrations is `missing` until it is not. What
Core must not do is let a call succeed against a provider whose schema has not caught up, which is why
migration state is in the dispatch list above and not only in the install one.

## 2. Mediated Module Storage

Simple Add-on documents could use mediated Module Storage instead of dedicated tables. Module Storage
would remain Site- and Add-on-scoped, schema-validated, quota-limited, audited, and inaccessible through
raw SQL. Today an Add-on that stores data declares a schema under section 15.

## 3. Sidecar Add-ons

In-process loading puts foreign code in the shared process that carries every tenant: a hang, a leak, or
a native crash takes all of them down. An Add-on that needs no in-process server code should be able to
run as a sidecar instead -- its own process or container, addressed over the existing catch-all routes.

There are two shapes and no third:

- **In-process** -- one self-contained artifact, no bare import except `node:` builtins. This is what
  exists, and it covers everything that bundles.
- **Sidecar** -- a separate process for an Add-on that genuinely needs a native binary or its own
  runtime.

Ordinary npm dependencies bundle. What does not bundle is narrow: native binaries, and packages that read
their own files at runtime. Marking such a package external and placing a `node_modules` beside the
artifact works, and is rejected: Node resolves a bare specifier by walking up, so an artifact under
`<PHIS_ROOT>/addons/` could import the server's own `pg`. The single-file rule is what makes "no import of
anything outside the artifact" a property rather than a promise.

The sidecar reuses the installation machinery. The artifact carries the manifest and a sidecar
declaration instead of handlers; install, digest, registry, migration, activation, and deactivation stay
identical, and only the invocation changes -- the catch-all forwards instead of calling in-process. A
process can be stopped, which removes the unload problem of in-process upgrades and shrinks the blast
radius.

The split follows the artifact kind, not the Add-on:

- routes, hooks, and jobs are process-isolable;
- service providers are not, because they hand back an object with methods on a hot path. A storage
  provider with a native dependency therefore fits neither shape and stays Core's business.

A sidecar needs a lifecycle -- who starts it, who watches it, what happens when it is gone -- and must
receive the same capability interface as an in-process handler over a different transport, so that the
two surfaces cannot drift apart. Nothing in the contract assumes in-process loading as the only shape.
Nothing needs a sidecar yet; until the first real case, a native dependency is refused.

## 4. Add-on desired state in the database

Pulling releases onto hosts needs a place to pull from, and `config/phis-addons.json` is a file per host.
The split that holds is:

- **which Add-ons in which version are wanted** -- one answer for the installation, in the database;
- **which artifact bytes are physically present** -- per host, on disk, and reported by that host.

Section 7 stays true: an Add-on present only in the database is not loadable. The digest binding gets
stronger, because the digest a host reports is checked against a recorded one instead of a neighbouring
copy of the same file. It is also what lets an operator surface say whether an Add-on is installed,
could be enabled, or waits on a Module build, because those facts become readable where the Next process
runs.

Consequences:

- `addon install` stops recording intent and becomes the step that places bytes; under pull, the host
  places them itself.
- `addon enable` becomes a row update, which is what makes it available to an operator UI.
- the three switches of section 15 keep their separation; only their storage moves.

## 5. Delegated installation

An operator may delegate installation of a product -- Add-on half and Module half -- to a Site
administrator through an operator-owned database setting. The Add-on half runs in the process every Site
on the instance shares, so the setting is bounded by what may be installed rather than by who asks: the
flag says whether installation is delegated, an operator-approved source says from where, and a signature
over the package digest says who vouched for the bytes. [DISTRIBUTION.md](./DISTRIBUTION.md) section 9
carries the rule and what a certification can claim.

The run crosses a privilege boundary and is built as two halves: `phis` records the intent and the
per-step status; `phis-host` places the Module on the source path, builds, copies to the serving path,
restarts, and reports back. A web process that can write the serving path and restart a unit is what that
split exists to prevent, and a build outlives any request.

Rules for the interface:

- The two halves have different clocks. The Add-on half goes live without a restart; the Module half
  needs a Site build and restart. Activate the Add-on half first and the Module half second, deactivate
  in reverse, and enable the Add-on for the Site last -- the CLI already refuses to enable an Add-on whose
  Module half the Site does not have. The interface shows that as a precondition, and never presents the
  two halves as one operation of one duration.
- The restart is the Site's, not the server's.
- Progress is Check, Stage, and Apply ([DISTRIBUTION.md](./DISTRIBUTION.md) section 8), and which side of
  Stage and Apply a failure fell on is the fact to report.

This assumes the host builds. Under a fleet, a build happens once and is distributed, so delegated
installation is a single-instance feature until that is settled.

Modules stay out of hot-plugging by decision. Loading a Module into a running Site would require
React, antd, and the `@phis/ui` runtime as shared singletons behind a runtime ABI, whose breaks surface in
a visitor's browser rather than in a build. A Site rebuild affects one tenant, so building and restarting
that Site is the mechanism.
