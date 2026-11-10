# Building, compiling, and installing a `@phis/server` Add-on

This is the practical guide for shipping an Add-on. The normative rules stay in
[SERVER_ADDONS.md](./SERVER_ADDONS.md); where this guide is more specific, it is specific about the
same rules and cannot widen them. [Section 9](#9-a-minimal-add-on-end-to-end) walks through one small
Add-on from package layout to upgrade.

## The one shape

There is exactly one way an Add-on reaches a running server, and it is not a rebuild.

An Add-on is **one self-contained ESM file** that the `phis` CLI places into the install root. The server
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
export const phisAddon = {
  manifest,         // PhisAddonManifestV1
  apiHandlers,      // optional
  hookHandlers,     // optional
  jobHandlers,      // optional
  eventHandlers,    // optional
  serviceFactories  // optional
};
```

The manifest is reached as `phisAddon.manifest`. There is no second entrypoint, no separate
manifest file, and no `package.json` in the install root -- the artifact is the unit.

**The module must have no top-level side effects.** `phis` imports the artifact to read and
validate the manifest during installation, before the Add-on is enabled and before any request has
reached it. Anything your module does while being evaluated happens at that moment, on an operator's
machine, for an Add-on that may then be rejected. Open no connections, start no timers, read no
files, and register nothing at module scope.

## 2. What it must declare

Build every identifier from the Add-on id. The grammar is enforced where it is written.

- **Add-on id** -- an npm package name containing neither `_` nor `.`: `@acme/status`. This is the
  logical identity, and it is what the install path and the database schema name are derived from.
- **Package name** -- normally the same string. It is a separate field because a replacement package
  may be named differently, and the logical id must not follow a repackaging.
- **Package version** -- semver. It appears in the install path, so two versions can sit side by side
  and a rollback is a change of one field.
- **`serverAbi`** -- the Add-on ABI range this artifact was built against, e.g. `^1`.

Routes, hooks, jobs, settings, capabilities, service providers, and the schema and query descriptors
are documented in [SERVER_ADDONS.md](./SERVER_ADDONS.md). Two reminders that catch people out:

- A route `path` is relative to the fixed catch-all, so `ping` and `echo/:token`, never a leading
  slash and never `/api/v1/...`.
- A handler name in a descriptor is a key in `apiHandlers`, `hookHandlers`, or `jobHandlers`. Installation
  validates the manifest, not the handler maps: a descriptor naming a handler the runtime does not export
  installs, and then answers 503 (`addon.handler.missing` in the log) or fails its job run. Check the maps
  before you hand the artifact over.

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

Two steps, both in your own package. Nothing in this section involves `@phis/server`.

**Type-check against the ABI.** `@phis/contracts/addon` carries the types an Add-on declares or
implements. It is not only types: it also exports constants an Add-on uses in its manifest, such as
`PHIS_CORE_CAPABILITIES`, `PHIS_ADDON_MANIFEST_VERSION` and `PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION`.
Whatever of them the Add-on imports is bundled into `addon.mjs` like any other code, so the installed
artifact never needs the package at runtime. Declare it as a `dependency` when the package also has a
Module half, which imports it in the Site; otherwise a `devDependency` is enough.

**Share values with the Module half through the package's own contract.** When the package also has a
Module half, the two halves never import each other, yet they must agree on route paths, a header of
their own, role names, row states and the paths of the Module's Pages the Add-on writes into mails and
payment return addresses. Those values go in one dependency-free file both halves import, copied into
each artifact when it is built; changing one is a breaking change between two separately installed
halves. The layout and the rules are in `@phis/ui`'s
[THIRD_PARTY_MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/THIRD_PARTY_MODULES.md#the-contract-between-a-packages-two-halves).

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
install root imported `pg`, `@phis/server`'s own PostgreSQL driver, successfully. The rule "no import of
anything outside the artifact" is true only while the artifact contains no bare imports; the moment one
is allowed, the rule becomes a promise instead of a property.

Node builtins are the one exception, and they are not a hole: `node:crypto` and its siblings resolve to
the runtime and never walk up. **Always write them with the `node:` prefix**, so that "no bare import
except `node:*`" is something a reader can check at a glance.

If a capability genuinely needs a native module, it does not belong in an in-process Add-on. It belongs
in Core, or in a separate process once the sidecar shape planned in
[ADDONS_PLANNED.md](./design/ADDONS_PLANNED.md) exists. Until then such an Add-on cannot be built.

The failure does at least surface early: `phis addon install` imports the artifact to read its
manifest, so a native dependency touched at module scope is rejected at installation rather than at the
first request. One that is only reached inside a handler is not, which is another reason to keep
module scope empty.

## 4. What it must not do

- **No import of anything outside the artifact**, other than `node:` builtins. Not `@phis/server`, not a
  package name, not a path. The artifact's own relative imports are inlined by the bundler and cease to
  exist, and anything left over resolves upward into directories that are none of an Add-on's business.
- **No dynamic import of a computed specifier.** An Add-on may not become a loader itself.
- **No SQL, no migration steps, no direct database handle.** The request context deliberately carries
  none. Declare the queries you run in the manifest and call them by name through
  `@phis/server/data:v1`: `context.capabilities.data.select("mine", { ... })`. Core derives the
  statements once, puts the Site filter into every one of them, and writes the scope columns itself.
- **No scheduler of your own.** Declare a job with a `schedule` and let Core start it. A `setInterval`
  in an Add-on fires once per serving instance for one intended run, and there is no way for you to know
  how many instances there are; Core's scheduler runs each moment of a schedule on exactly one of them
  ([SERVER_ADDONS.md](./SERVER_ADDONS.md#jobs)). Likewise no polling: a job that would have to run more
  often than every five minutes is waiting for an event, and `emits` with the `events:v1` capability is
  how one Add-on tells another that something happened.
- **No PII beyond what your actor could already see.** The request context carries a user *id*. A
  display name comes from `@phis/server/groups:v1`, and only for someone the acting user shares a
  group with; an email address is not on offer at all. If you need a person to receive a message, that
  is Core's to send, not yours to address: declare the occasion in your manifest and call
  `@phis/server/notifications:v1`. The one address you may hand Core is one a person gave *you* for
  that purpose -- a guest's order confirmation -- and Core keeps it only while the message is owed.
- **No authorization of your own over Core's scopes.** If a table is `ownerScoped` or `groupScoped`,
  Core wrote those columns and Core answers about them: declare `@phis/server/authorization:v1` and
  ask `context.capabilities.authorization.mayActOnRow({ table, id, intent })`. Rebuilding the ladder
  locally is the parallel contract the Module guide forbids, and it will drift from Core's the first
  time a level changes.
- **No global registration and no import-side-effect registration.** Both are covered by the
  no-top-level-side-effects rule and are not extension APIs.
- **No unbounded work.** A handler is raced against its declared `timeoutMs`, and losing that race
  answers the caller with 504 but does **not** cancel the handler. The context carries an `AbortSignal`;
  honour it. A handler that writes after its timeout will commit changes the caller was told did not
  happen.
- **No assumption of being alone.** The process is shared by every Site on the instance.

## 5. How it is installed and activated

The `phis` CLI is the only thing that may install, and installation is an operator action, never a Site
configuration action.

```text
phis addon install --artifact ./dist/addon.mjs
phis addon reconcile
phis addon migrate  --addon @acme/status
phis addon enable   --addon @acme/status
phis addon reconcile
phis addon site     --addon @acme/status --site <site key> --enable
```

What each step is for:

1. **`install`** copies the artifact into the install root under its derived path, computes its
   SHA-256, imports it once to read the manifest, validates the manifest in full, checks the id, the
   package name, the version, and the ABI range, and records the entry as **disabled**. Nothing is
   reachable yet. A rejected artifact is removed again rather than left half-installed.
2. **`reconcile`** writes what is installed into the database registry for the named release.
3. **`migrate`** derives and applies the schema. The Add-on is still disabled while this runs.
4. **`enable`** marks it enabled in the desired state.
5. **`reconcile`** publishes that to the registry. Routes that are not Site-scoped answer from here on.
6. **`site --enable`** records that one Site asks for the Add-on and creates the groups its manifest
   declares there. Site-scoped routes, hooks, jobs, and capabilities answer for that Site from the next
   request. Repeat it per Site; `--disable` withdraws the request.

When the package also has a Module half, add it to the Site and rebuild the Site before step 6
(`phis module add --site <site key> --package <package>`); `site --enable` refuses otherwise.
`--without-module` enables the server half on its own. Settings, storage quotas, and role grants for the
Site follow with `phis addon config`, `phis addon storage`, and `phis addon role`.

Installation never enables an Add-on, and an Add-on cannot enable itself.

### Upgrading

```text
phis addon upgrade --addon @acme/status --artifact ./dist/addon.mjs
phis addon migrate  --addon @acme/status   # only if the schema version rose
phis addon reconcile
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
phis addon reconcile
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

## 6a. Your data on Public pages

A Site renders a Public page **once for every anonymous visitor** and serves it from memory
(`@phis/ui` `STATIC_RENDERING.md`). Two consequences reach an Add-on even though its own routes are never
rendered that way:

- **What your Add-on stores can be up to 60 seconds old on a Public page.** A page is rendered again
  within seconds only when Builder content is published or a translation is written. A write to your
  Add-on -- a booking, an order, a new entry, a price -- does not do that; a Widget that renders the data
  on the server shows it at the next render, at most a minute later. If a write must be visible at once
  -- a slot that is gone, a product that sold out -- the Widget loads that part in the browser from your
  route.
- **A Public page's server render is anonymous.** It carries no visitor session to your routes, and
  whatever it renders is shown to everybody. Per-visitor answers (the visitor's own bookings, a CSRF or
  one-time token, anything role-dependent) are requested by the browser, where the session travels with
  the request.

Signed-in visitors and requests with a query are rendered per request and see current data.

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
- exactly one export, `phisAddon`, and nothing happens at module scope
- every descriptor's `handler` exists in the matching handler map
- the Add-on id carries no `_` and no `.`
- `serverAbi` matches the release you are installing into
- constraints are in the first schema version; columns and indexes may come later
- handlers honour `context.signal` and stop when it aborts
- the digest of the file you hand over is the digest you tell the operator

## 9. A minimal Add-on, end to end

Everything above, applied once to a small Add-on, `@acme/notes`: one Site-scoped table of notes, a
public hook that lists the visible ones, a Site Admin route that adds one, and a job that imports notes
from a feed with a secret token. The files below are complete; they type-check against
`@phis/contracts/addon`, and the manifest passes the validator `phis addon install` runs.

### Package layout

An **Add-on-only** package -- a storage provider, an integration with no surface in the Site -- has two
exports and nothing else:

```text
@acme/notes/
  package.json
  src/addon/manifest.ts     # phisAddonManifest: declares, does nothing
  src/addon/handlers.ts     # the handler functions, exported for tests
  src/addon/runtime.ts      # phisAddon: the one export of the artifact
  dist/addon.mjs            # the artifact, built by "bundle"
```

```json
{
  "name": "@acme/notes",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    "./addon/manifest": { "types": "./dist/addon/manifest.d.ts", "default": "./dist/addon/manifest.js" },
    "./addon/runtime": { "types": "./dist/addon/runtime.d.ts", "default": "./dist/addon/runtime.js" }
  },
  "scripts": {
    "bundle": "esbuild src/addon/runtime.ts --bundle --format=esm --platform=node --target=node24 --outfile=dist/addon.mjs --banner:js=\"import{createRequire as __phisCreateRequire}from\\\"node:module\\\";const require=__phisCreateRequire(import.meta.url);\""
  },
  "devDependencies": {
    "@phis/contracts": "^0.7.1",
    "esbuild": "^0.28",
    "typescript": "^6",
    "vitest": "^3"
  }
}
```

A package that is **Module + Add-on** adds the Module doors beside the Add-on doors, names its Modules in
`phis.modules`, and moves `@phis/contracts` to `dependencies`, because the Module half imports it in the
Site:

```json
{
  "name": "@acme/notes",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./server": { "types": "./dist/server.d.ts", "default": "./dist/server.js" },
    "./client": { "types": "./dist/client.d.ts", "default": "./dist/client.js" },
    "./authoring-client": { "types": "./dist/authoring-client.d.ts", "default": "./dist/authoring-client.js" },
    "./addon/manifest": { "types": "./dist/addon/manifest.d.ts", "default": "./dist/addon/manifest.js" },
    "./addon/runtime": { "types": "./dist/addon/runtime.d.ts", "default": "./dist/addon/runtime.js" }
  },
  "dependencies": { "@phis/contracts": "^0.7.1" },
  "phis": {
    "modules": [
      { "moduleId": "@acme/notes/modules/notes", "category": "integration", "eligibleAreas": ["public", "admin"] }
    ]
  }
}
```

The two halves meet at the server binding, never through an import. The Module definition names the
Add-on as the provider of its server half:

```ts
serverBinding: { providerId: "@acme/notes", requiredCapabilities: [] },
```

and the manifest lists the Module in `modules`, which is what lets `phis addon site --enable` check that
the Site has the other half. The Module never imports from `src/addon/`, and the Add-on never imports the
Module or `@phis/ui` ([SERVER_ADDONS.md](./SERVER_ADDONS.md#3-package-halves-and-module-graphs)).
How the Module half itself is written is `@phis/ui`'s subject, in
[THIRD_PARTY_MODULES.md](https://github.com/phis-dev/phis-ui/blob/main/THIRD_PARTY_MODULES.md).

### The manifest

`src/addon/manifest.ts`. It imports constants and types and nothing else, so `addon/manifest` can be
inspected without running anything.

```ts
import {
  PHIS_ADDON_ABI_VERSION,
  PHIS_ADDON_MANIFEST_VERSION,
  PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION,
  PHIS_CORE_CAPABILITIES,
  type PhisAddonManifestV1,
  type PhisAddonQueryCatalog,
  type PhisAddonSchemaDescriptor,
} from "@phis/contracts/addon";

export const NOTES_ADDON_ID = "@acme/notes";
export const NOTES_ROLE_EDITOR = "editor";
export const NOTES_SETTING_FEED_URL = "feed-url";
export const NOTES_SECRET_FEED_TOKEN = "feed-token";

/** Bit flags of `notes.flags`. Yes/no state is a bit of an integer column, never a boolean column. */
export const NoteFlags = { Hidden: 1 } as const;

const NOTES_SCHEMA: PhisAddonSchemaDescriptor = {
  descriptorVersion: PHIS_ADDON_SCHEMA_DESCRIPTOR_VERSION,
  version: 1,
  tables: [{
    name: "notes",
    // Core adds the Site column, its foreign key, its cascade and its index.
    siteScoped: true,
    columns: [
      { name: "id", type: "identity" },
      { name: "title", type: "string", maxLength: 200 },
      { name: "body", type: "text" },
      { name: "flags", type: "smallInteger", default: { kind: "literal", value: 0 } },
      // Set for notes the import job brought in, so a second run does not insert them again.
      { name: "source_id", type: "string", maxLength: 200, nullable: true },
      { name: "created_at", type: "instant", default: { kind: "now" } },
    ],
    primaryKey: ["id"],
    indexes: [
      { name: "by_created", columns: ["created_at"] },
      { name: "by_source", columns: ["source_id"], unique: true },
    ],
    // Constraints belong in the first version: one added later meets the rows already there.
    constraints: [
      { kind: "notEmpty", name: "title", column: "title" },
      { kind: "range", name: "flags", column: "flags", min: 0 },
    ],
  }],
};

const NOTES_QUERIES: PhisAddonQueryCatalog = {
  parameters: {
    notes_visible: [],
    note_by_source: [{ name: "source_id", type: "text" }],
    notes_insert: [
      { name: "title", type: "text" },
      { name: "body", type: "text" },
      { name: "flags", type: "integer" },
      { name: "source_id", type: "text", nullable: true },
    ],
  },
  queries: [
    {
      kind: "select",
      name: "notes_visible",
      table: "notes",
      columns: ["id", "title", "body", "created_at"],
      // Every row whose Hidden bit is not set.
      where: {
        kind: "flags",
        column: "flags",
        mask: { kind: "literal", value: NoteFlags.Hidden },
        match: "none",
      },
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 50,
    },
    {
      kind: "select",
      name: "note_by_source",
      table: "notes",
      columns: ["id"],
      where: { kind: "compare", column: "source_id", operator: "=", value: { kind: "parameter", name: "source_id" } },
      limit: 1,
    },
    {
      kind: "insert",
      name: "notes_insert",
      table: "notes",
      // The table has no owner and no group, so its writes must name a role.
      requiresRole: NOTES_ROLE_EDITOR,
      values: [
        { column: "title", value: { kind: "parameter", name: "title" } },
        { column: "body", value: { kind: "parameter", name: "body" } },
        { column: "flags", value: { kind: "parameter", name: "flags" } },
        { column: "source_id", value: { kind: "parameter", name: "source_id" } },
      ],
    },
  ],
};

export const phisAddonManifest = {
  manifestVersion: PHIS_ADDON_MANIFEST_VERSION,
  addonId: NOTES_ADDON_ID,
  packageName: "@acme/notes", // keep in step with package.json
  packageVersion: "1.0.0",    // keep in step with package.json
  serverAbi: `^${PHIS_ADDON_ABI_VERSION}`,
  capabilities: [],
  serviceProviders: [],
  requiredCoreCapabilities: [
    PHIS_CORE_CAPABILITIES.data,
    PHIS_CORE_CAPABILITIES.settings,
    PHIS_CORE_CAPABILITIES.secrets,
  ],
  // Only for a package with a Module half; an Add-on-only package leaves the field out.
  modules: ["@acme/notes/modules/notes"],
  apiRoutes: [{
    id: "create-note",
    method: "POST",
    path: "notes", // relative to /api/v1/addons/acme/notes/
    handler: "createNote",
    auth: "site-admin",
    siteScoped: true,
    bodyLimitBytes: 16_384,
    timeoutMs: 10_000,
  }],
  hooks: [{
    id: "notes",
    method: "GET",
    path: "notes", // relative to /api/v1/hooks/acme/notes/
    handler: "listNotes",
    // Told its Site through x-phis-site-key; has no actor, so it may read and never write.
    siteScoped: true,
    bodyLimitBytes: 1_024,
    rateLimitClass: "public-read",
    timeoutMs: 5_000,
  }],
  jobs: [{ id: "import", handler: "importFeed", schedule: { every: "hourly" } }],
  settings: [{
    name: NOTES_SETTING_FEED_URL,
    type: "text",
    // No default: the Site stays "missing" configuration until an operator sets it.
    description: "The JSON feed the import job reads notes from.",
  }],
  roles: [{
    name: NOTES_ROLE_EDITOR,
    description: "May add notes.",
    grantableBy: { siteAccess: "site-admin" },
  }],
  schema: NOTES_SCHEMA,
  queries: NOTES_QUERIES,
  migrationVersion: NOTES_SCHEMA.version,
} satisfies PhisAddonManifestV1;
```

What each part is for:

- `requiredCoreCapabilities` is what arrives in `context.capabilities`. A capability not listed is
  `undefined` there, which is why every handler checks for the ones it uses.
- `schema.version` and `migrationVersion` must be equal; raising both is a new schema version, and
  `phis addon migrate` applies the difference.
- `notes_insert` names a role because the table has no owner and no group: without one Core would have
  nothing to judge the write by, and the validator refuses it. The role must be one the manifest
  declares.
- The hook has no actor. It may read, and every write through `data:v1` is refused before it runs.
  `bodyLimitBytes`, `rateLimitClass` and `timeoutMs` are required on a hook; on a route they are
  optional.
- A setting without a `default` leaves the Site's configuration `missing` until an operator sets it,
  and an Add-on whose configuration is missing does not answer for that Site.
- Secrets are not declared in the manifest. The Add-on reads one by name; the operator sets it with
  `phis secret set`, and an unset one reads as `null`. (The one place a manifest names a secret is a
  hook's `verification.secret`.)

### The handlers

`src/addon/handlers.ts`. Exported so a test can call them; the artifact's only export is still
`phisAddon`, because the bundle's exports are those of `runtime.ts`.

```ts
import type {
  PhisAddonJobContext,
  PhisAddonRequestContext,
} from "@phis/contracts/addon";

import {
  NOTES_SECRET_FEED_TOKEN,
  NOTES_SETTING_FEED_URL,
} from "./manifest.js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The public hook: the visible notes of the Site named by `x-phis-site-key`. */
export async function listNotes(context: PhisAddonRequestContext): Promise<Response> {
  const { data } = context.capabilities;
  if (!data) throw new Error("listNotes needs the data capability.");
  const page = await data.select("notes_visible", {}, { limit: 20 });
  return json({ notes: page.rows, cursor: page.cursor });
}

/** The Site Admin route. The acting user must also hold the `editor` role of this Add-on. */
export async function createNote(context: PhisAddonRequestContext): Promise<Response> {
  const { data } = context.capabilities;
  if (!data) throw new Error("createNote needs the data capability.");
  let input: { title?: unknown; body?: unknown };
  try {
    input = JSON.parse(new TextDecoder().decode(context.body)) as typeof input;
  } catch {
    return json({ error: "The body is not JSON." }, 400);
  }
  if (typeof input.title !== "string" || input.title.trim() === "" || typeof input.body !== "string") {
    return json({ error: "title and body are required." }, 400);
  }
  // A handler that lost its timeout race must not write: the caller was already told 504.
  context.signal.throwIfAborted();
  const row = await data.insert("notes_insert", {
    title: input.title.trim(),
    body: input.body,
    flags: 0,
    source_id: null,
  });
  return json({ note: row }, 201);
}

type FeedItem = { id: string; title: string; body: string };

/** The job, with `fetch` passed in so a test can answer for the feed. */
export async function importFeed(
  context: Pick<PhisAddonJobContext, "capabilities" | "signal">,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const { data, settings, secrets } = context.capabilities;
  if (!data || !settings || !secrets) throw new Error("importFeed needs data, settings and secrets.");
  const feedUrl = await settings.read(NOTES_SETTING_FEED_URL);
  if (typeof feedUrl !== "string" || feedUrl === "") return;
  const token = await secrets.read(NOTES_SECRET_FEED_TOKEN); // null when the operator set none
  const response = await fetchImpl(feedUrl, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: context.signal,
  });
  if (!response.ok) throw new Error(`The feed answered ${response.status}.`);
  const items = (await response.json()) as FeedItem[];
  for (const item of items) {
    context.signal.throwIfAborted();
    const existing = await data.select("note_by_source", { source_id: item.id });
    if (existing.rows.length > 0) continue;
    await data.insert("notes_insert", { title: item.title, body: item.body, flags: 0, source_id: item.id });
  }
}

```

The job inserts through `notes_insert` without anybody holding `editor`: a job runs with the Add-on's
own system authority, so role guards and the row ladder pass. A person reaching `create-note` needs the
Site Admin claim for the route *and* the `editor` role for the query.

### The runtime

`src/addon/runtime.ts`, the bundle's entry point:

```ts
import type { PhisAddonRuntimeV1 } from "@phis/contracts/addon";

import { createNote, importFeed, listNotes } from "./handlers.js";
import { phisAddonManifest } from "./manifest.js";

/** The one export. Nothing else happens at module scope. */
export const phisAddon = {
  manifest: phisAddonManifest,
  apiHandlers: { createNote },
  hookHandlers: { listNotes },
  jobHandlers: { importFeed: (context) => importFeed(context) },
} satisfies PhisAddonRuntimeV1;
```

### Testing

Test the handlers, not the artifact, and give them everything from outside: `fetch` as a parameter,
and a fake `data` capability that answers the declared query names. A fake that refuses names and
parameters the catalog does not declare catches most wiring mistakes before Core does.

```ts
import { describe, expect, it } from "vitest";

import type { PhisAddonJobContext, PhisDataCapabilityV1 } from "@phis/contracts/addon";

import { importFeed } from "./handlers.js";

function fakeCore(settings: Record<string, string>) {
  const inserted: Record<string, unknown>[] = [];
  const data = {
    async select(name: string, args?: Record<string, unknown>) {
      if (name !== "note_by_source") throw new Error(`unexpected select ${name}`);
      return { rows: inserted.filter((row) => row.source_id === args?.source_id), cursor: null };
    },
    async insert(name: string, args?: Record<string, unknown>) {
      if (name !== "notes_insert") throw new Error(`unexpected insert ${name}`);
      inserted.push({ ...args });
      return { id: inserted.length, ...args };
    },
  } as unknown as PhisDataCapabilityV1;
  const capabilities = {
    data,
    settings: { async read(name: string) { return settings[name] ?? null; }, async all() { return settings; } },
    secrets: { async read() { return null; } },
  } as PhisAddonJobContext["capabilities"];
  return { inserted, context: { capabilities, signal: new AbortController().signal } };
}

describe("importFeed", () => {
  it("inserts each feed item once", async () => {
    const core = fakeCore({ "feed-url": "https://feed.example/notes.json" });
    const fakeFetch = (async () =>
      Response.json([{ id: "a", title: "Hello", body: "First" }])) as unknown as typeof fetch;
    await importFeed(core.context, fakeFetch);
    await importFeed(core.context, fakeFetch);
    expect(core.inserted).toHaveLength(1);
  });
});
```

### Bundling

```sh
pnpm run bundle   # the "bundle" script above
```

That is esbuild with the settings of [section 3](#3-how-to-compile-it): one self-contained ESM file,
`dist/addon.mjs`, every dependency inlined, and the `require` shim in the banner for whatever CommonJS
is in the tree (harmless when there is none). Check that nothing but `node:` builtins is imported:

```sh
grep -oE '(from ?|import ?\()"[^"]+"' dist/addon.mjs | sort -u   # expect only "node:..." specifiers
sha256sum dist/addon.mjs                                         # the digest you hand to the operator
```

### Installing and running it

On the server, as the user that owns the phis root:

```sh
phis addon install --artifact ./dist/addon.mjs
phis addon reconcile
phis addon migrate --addon @acme/notes
phis addon enable  --addon @acme/notes
phis addon reconcile

# Module + Add-on only: the Site gets the Module half first, then is rebuilt.
phis module add --site acme --package @acme/notes

phis addon site --addon @acme/notes --site acme --enable

# The setting without a default; until it is set the Site's configuration is "missing".
phis addon config --addon @acme/notes --site acme --name feed-url --value https://feed.example/notes.json
phis addon config --addon @acme/notes --site acme          # lists settings and values

# The secret, from stdin -- never a terminal, and --value would put it in the process list.
phis secret set --name feed-token --addon @acme/notes --site acme < ./feed-token.txt

# Whoever adds notes through the admin route needs the role.
phis addon role --site acme --addon @acme/notes --user <user id> --grant editor

# Run the job once, now. Core runs it hourly by itself from here on, as its schedule says;
# `phis addon jobs --addon @acme/notes` shows each run.
phis addon job --addon @acme/notes --job import --site acme --api-base-url http://127.0.0.1:5301
```

`--api-base-url` is the server's address as reached from where the CLI runs (the Debian package listens
on `http://127.0.0.1:5301`); it has no default, and the command needs `api.internalToken` and a running
server. The hook then answers at `GET <server>/api/v1/hooks/acme/notes/notes` with the header
`x-phis-site-key: acme`; the admin route at `POST <server>/api/v1/addons/acme/notes/notes`, called by
the Site for a signed-in Site Admin. Every command is described in [docs/CLI.md](./docs/CLI.md#addon-server-add-ons).

### Upgrading it

Build the new artifact and point `upgrade` at it:

```sh
phis addon upgrade --addon @acme/notes --artifact ./dist/addon.mjs
phis addon migrate --addon @acme/notes    # only when schema.version rose
phis addon reconcile
```

The same `packageVersion` with different bytes is accepted -- that is a patch in place; the identical
artifact, a different Add-on id, or a lower schema version is refused. Between `upgrade` and `reconcile`
the Add-on answers 503, so run the commands back to back ([Upgrading](#upgrading)).
