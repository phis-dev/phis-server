# Building, compiling, and installing a phi-server Add-on

This is the practical guide for shipping an Add-on. The normative rules stay in
[SERVER_ADDONS.md](./SERVER_ADDONS.md); where this guide is more specific, it is specific about the
same rules and cannot widen them.

## Status

**Implemented and proven.** A server was built and started with one Add-on installed, and a second
Add-on was then installed, migrated, and enabled into that running process. Its routes and its hook
answered from the same PID, with no rebuild and no restart. Tampering with an installed artifact makes
it refuse to load rather than load the changed bytes.

`phis addon upgrade` replaces an installed artifact in place, and `phis addon forget` takes an entry out
of the desired state without reading it -- for the manifest that has become unreadable and that
`remove` therefore refuses to touch.

## The one shape

There is exactly one way an Add-on reaches a running server, and it is not a rebuild.

An Add-on is **one self-contained ESM file** that `phis-cli` places into the install root. The server
loads it at dispatch time through a `file:` URL derived from the Add-on id, after verifying its
digest. No Add-on is compiled into the server, and no second mechanism exists beside this one.

That has a consequence worth stating before anything else: **the bundler stops working for you.**
The server will not resolve your imports, will not transpile your syntax, and will not shake your
tree. Whatever your artifact needs at runtime has to be inside it.

```text
<install root>/<scope>/<name>/<version>/addon.mjs
```

The path is derived from the Add-on id, never stored anywhere as a string, and never assembled from
a request or a database value. The install root defaults to `addons/` under the stage root
(`PHIS_ROOT`), so it is deployment state that travels with the instance rather than with the build.

## 1. What the artifact must export

One export:

```js
export const phiServerAddon = {
  manifest,        // PhiServerAddonManifestV1
  apiHandlers,     // optional
  hookHandlers,    // optional
  serviceFactories // optional
};
```

The manifest is reached as `phiServerAddon.manifest`. There is no second entrypoint, no separate
manifest file, and no `package.json` in the install root -- the artifact is the unit.

**The module must have no top-level side effects.** `phis-cli` imports the artifact to read and
validate the manifest during installation, before the Add-on is enabled and before any request has
reached it. Anything your module does while being evaluated happens at that moment, on an operator's
machine, for an Add-on that may then be rejected. Open no connections, start no timers, read no
files, and register nothing at module scope.

## 2. What it must declare

Build every identifier from the Add-on id. The grammar is enforced where it is written.

- **Add-on id** -- an npm package name without the `-server` postfix, containing neither `_` nor `.`:
  `@acme/status`. This is the logical identity, and it is what the install path and the database
  schema name are derived from.
- **Package name** -- the same name with the mandatory `-server` postfix: `@acme/status-server`.
- **Package version** -- semver. It appears in the install path, so two versions can sit side by side
  and a rollback is a change of one field.
- **`serverAbi`** -- the Add-on ABI range this artifact was built against, e.g. `^1`.

Routes, hooks, jobs, settings, capabilities, service providers, and the schema and query descriptors
are documented in [SERVER_ADDONS.md](./SERVER_ADDONS.md). Two reminders that catch people out:

- A route `path` is relative to the fixed catch-all, so `ping` and `echo/:token`, never a leading
  slash and never `/api/v1/...`.
- A handler name in a descriptor is a key in `apiHandlers` or `hookHandlers`. A descriptor naming a
  handler the runtime does not export is a failed installation, not a 404 later.

### Tables

An Add-on ships no SQL. It states the shape it wants and Core derives the statements. Core owns more
of the result than a first reading suggests:

- A `siteScoped` table gets its Site column, its foreign key, its cascade, and its index from Core.
  You neither write the column nor can forget it.
- A reference column has no type of its own. `references: "core.user"` resolves to whatever Core's key
  actually is, at Core's width.
- Constraints are structured, not expressions. `notEmpty`, `range`, `enumeration`,
  `columnComparison`, and `nullCardinality` cover what a table may say about itself.

Add columns and indexes in a later `version`; add constraints in the first one. A constraint added
later meets the rows that are already there.

## 3. How to compile it

Two steps, both in your own package. Nothing in this section involves phi-server.

**Type-check against the ABI.** `@phis/addon-contract` carries the types an Add-on declares or
implements. It contains no runtime code, so it disappears entirely from the compiled artifact -- it
belongs in `devDependencies`, never in `dependencies`.

**Bundle to one file.** Any bundler that emits ESM will do; the settings are what matter.

| Setting | Value | Why |
| --- | --- | --- |
| format | `esm` | the server loads it with a native dynamic import |
| platform | `node` | it runs in the server process |
| target | the Node major of the release | nothing transpiles it afterwards |
| bundle | on, **no externals** | the server resolves nothing for you |
| minify | your choice | it changes the digest, nothing else |
| sourcemap | external only, without `sourcesContent` | a private source stays private |
| outfile | `addon.mjs` | the name the install root expects |

If your dependency tree contains any CommonJS -- most real ones do -- an ESM bundle needs a `require`
shim in its banner, or the first thing that calls `require` at runtime fails with *Dynamic require of
"node:https" is not supported*:

```text
--banner:js='import{createRequire as __cr}from"node:module";const require=__cr(import.meta.url);'
```

A dependency you leave external will resolve against nothing and fail on the first request that
reaches it, not at installation. That is the single most likely way to ship a broken Add-on, so
verify the bundle has no bare imports left before you hand it over.

Build reproducibly if you can. The digest is what an operator compares across instances, and a build
that produces a different digest from the same source makes that comparison worthless.

### Dependencies from npm

This is the normal case, not the exception, and bundling is what handles it: your dependencies are
inlined into the artifact. The Media Storage Add-on carries the whole `@aws-sdk/client-s3` tree and
comes out as one 1.3 MB file with no bare import left in it.

Three things follow, and the third one is a real limit.

**Each Add-on carries its own copies.** Two Add-ons using the same library do not share it. That costs
memory and disk, and it buys isolation: neither can be broken by the other's version choice, and there
is no resolution to negotiate between them. After an upgrade, both the old and the new copy stay
resident until the process restarts.

**CommonJS in the tree needs the `require` shim.** Most real dependency trees still contain some.
Without the banner from the table above, the first call fails at runtime with *Dynamic require of
"node:https" is not supported*.

**Native modules cannot be bundled, and they fail quietly.** A package with a `.node` binary --
`sharp`, `argon2`, `better-sqlite3` -- bundles *without any error* and then fails when it is loaded:

```text
Could not load the "sharp" module using the linux-x64 runtime
```

The same is true of packages that read their own files at runtime: WASM blobs, ICU data, anything that
resolves a path from `__dirname`. They bundle and then cannot find what they expect.

**An Add-on may not depend on either kind.** Not because the workaround is impossible -- marking the
package external and putting a `node_modules` beside the artifact does work -- but because of what that
costs. Node resolves a bare specifier by walking *up*, so an artifact with any bare import left in it
reaches whatever `node_modules` happens to sit above the install root. Measured: an artifact under the
install root imported `pg`, `phi-server`'s own PostgreSQL driver, successfully. The rule "no import of
anything outside the artifact" is true only while the artifact contains no bare imports; the moment one
is allowed, the rule becomes a promise instead of a property.

Node builtins are the one exception, and they are not a hole: `node:crypto` and its siblings resolve to
the runtime and never walk up. **Always write them with the `node:` prefix**, so that "no bare import
except `node:*`" is something a reader can check at a glance.

If a capability genuinely needs a native module, it does not belong in an in-process Add-on. It belongs
in Core, or -- once the sidecar shape exists -- in a separate process. There is no third option, and
until the sidecar exists the honest answer is that such an Add-on cannot be built yet.

The failure does at least surface early: `phis addon install` imports the artifact to read its
manifest, so a native dependency touched at module scope is rejected at installation rather than at the
first request. One that is only reached inside a handler is not, which is another reason to keep
module scope empty.

## 4. What it must not do

- **No import of anything outside the artifact**, other than `node:` builtins. Not phi-server, not a
  package name, not a path. The artifact's own relative imports are inlined by the bundler and cease to
  exist, and anything left over resolves upward into directories that are none of an Add-on's business.
- **No dynamic import of a computed specifier.** An Add-on may not become a loader itself.
- **No SQL, no migration steps, no direct database handle.** The request context deliberately carries
  none. Declare the queries you run in the manifest and call them by name through
  `@phis/phi-server/data:v1`: `context.capabilities.data.select("mine", { ... })`. Core derives the
  statements once, puts the Site filter into every one of them, and writes the scope columns itself.
- **No scheduler of your own.** Declare a job and let `phis addon job` start it. A `setInterval` in an
  Add-on fires once per serving instance for one intended run, and there is no way for you to know how
  many instances there are.
- **No PII beyond what your actor could already see.** The request context carries a user *id*. A
  display name comes from `@phis/phi-server/groups:v1`, and only for someone the acting user shares a
  group with; an email address is not on offer at all. If you need a person to receive a message, that
  is Core's to send, not yours to address.
- **No authorization of your own over Core's scopes.** If a table is `ownerScoped` or `groupScoped`,
  Core wrote those columns and Core answers about them: declare `@phis/phi-server/authorization:v1` and
  ask `context.capabilities.authorization.mayActOnRow({ table, id, intent })`. Rebuilding the ladder
  locally is the parallel contract the Module guide forbids, and it will drift from Core's the first
  time a level changes -- which has already happened once.
- **No global registration and no import-side-effect registration.** Both are covered by the
  no-top-level-side-effects rule and are not extension APIs.
- **No unbounded work.** A handler is raced against its declared `timeoutMs`, and losing that race
  answers the caller but does **not** cancel the handler. The context carries an `AbortSignal`;
  honour it. A handler that writes after its timeout will commit changes the caller was told did not
  happen.
- **No assumption of being alone.** The process is shared by every Site on the instance.

## 5. How it is installed and activated

`phis-cli` is the only thing that may install, and installation is an operator action, never a Site
configuration action.

```text
phis addon install --artifact ./dist/addon.mjs
phis addon reconcile --release <release id>
phis addon migrate  --release <release id> --addon @acme/status
phis addon enable   --addon @acme/status
phis addon reconcile --release <release id>
```

What each step is for:

1. **`install`** copies the artifact into the install root under its derived path, computes its
   SHA-256, imports it once to read the manifest, validates the manifest in full, checks the id, the
   package name, the version, and the ABI range, and records the entry as **disabled**. Nothing is
   reachable yet. A rejected artifact is removed again rather than left half-installed.
2. **`reconcile`** writes what is installed into the database registry for the named release.
3. **`migrate`** derives and applies the schema. The Add-on is still disabled while this runs.
4. **`enable`** marks it enabled in the desired state.
5. **`reconcile`** publishes that to the registry, and the next request picks it up.

Installation never enables an Add-on, and an Add-on cannot enable itself.

### Upgrading

```text
phis addon upgrade --addon @acme/status --artifact ./dist/addon.mjs
phis addon migrate  --release <release id> --addon @acme/status   # only if the schema version rose
phis addon reconcile --release <release id>
```

The new artifact goes into its own version directory beside the old one, and the desired state is
repointed. The running process picks it up on the next dispatch, because the digest is the module's
cache key: a new digest is a different specifier. Requests already in flight finish on the version
they resolved.

**Replacing an artifact without moving the version is allowed**, and is what a security patch looks
like. The file is replaced through a rename, so a process holding the old bytes is not disturbed.

**Between `upgrade` and `reconcile` the Add-on answers 503.** The desired state names a version the
registry does not, and the dispatcher refuses rather than guesses. A schema bump keeps it refusing
until `migrate` has run. Both are the intended failure; run the following commands promptly rather
than treating the gap as a window to leave open.

Rolling back is the same command with the older artifact -- the predecessor is still in the install
root, and `remove` is what eventually takes every version with it.

The upgraded-away version stays resident in the process until it restarts, because an ES module cannot
be unloaded. That costs roughly three times the artifact size per version and is what a periodic
rolling restart is for.

### Removing

The reverse path enforces its own order, and the order is not a formality:

```text
phis addon disable --addon @acme/status
phis addon reconcile --release <release id>
phis addon remove  --addon @acme/status
phis addon purge   --addon @acme/status
```

`remove` refuses while the Add-on is enabled, and `purge` refuses while it is installed. `remove`
deletes the artifact from the install root and the entry from the desired state; `purge` drops the
schema and every record. They are separate because uninstalling an Add-on and discarding its data are
separate decisions.

## 6. What happens at runtime

The server never holds your code in its build. On each dispatch it resolves the Add-on id to an entry,
and the entry's loader is:

```text
file://<install root>/<scope>/<name>/<version>/addon.mjs?v=<artifact digest>
```

The digest is verified against the file before the first load. It is also the cache key, and that is
what makes an upgrade work: a new digest is a different specifier, so the next dispatch loads the new
module. Requests already in flight finish on the version they resolved.

Three properties follow from Node, not from a choice:

- **A superseded version stays resident.** An ES module cannot be unloaded. Upgrades are therefore
  cheap but not free -- roughly three times the artifact size per version, never reclaimed -- and a
  periodic rolling restart is what clears them.
- **Disable takes effect immediately** for routes and hooks, because the loader is simply not called
  again. The registry, not anything baked into a build, is what decides at request time.
- **Resident artifacts are not released by disable.** Timers, listeners, pools, and jobs an Add-on
  started keep running until the process restarts. This is the reason for the no-top-level-side-effects
  rule, and the reason a job-owning Add-on needs a restart to go away.

An Add-on that throws answers 503 with the request id and leaves the process healthy. An Add-on that
is enabled in the registry but whose artifact is missing on this instance answers as unavailable and
is logged; it does not take anything else down.

## 7. Multiple instances

The artifact is per-instance state, the registry is shared. Both halves have to be true at once:

- the artifact must be present, with a matching digest, on **every** instance
- only then may the registry report the Add-on as enabled

Installing on one instance and enabling globally makes the Add-on answer on that instance and fail on
the others -- behind a load balancer, per request. Deploy the artifact everywhere first, confirm it,
and enable last.

## 8. Checklist before handing an artifact over

- one `addon.mjs`, ESM, no bare imports left in the output
- no native or asset-carrying dependency anywhere in the tree; load the artifact once before handing it
  over
- every builtin written with the `node:` prefix, and nothing else left as a bare import
- exactly one export, `phiServerAddon`, and nothing happens at module scope
- every descriptor's `handler` exists in the matching handler map
- the Add-on id carries no `_` and no `.`, and the package name ends in `-server`
- `serverAbi` matches the release you are installing into
- constraints are in the first schema version; columns and indexes may come later
- handlers honour `context.signal` and stop when it aborts
- the digest of the file you hand over is the digest you tell the operator
