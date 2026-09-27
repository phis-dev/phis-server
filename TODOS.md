# Phi Server TODOs

This backlog records approved work that is not implemented yet. It is not a compatibility contract and
must not be used to infer that an item is already available in `phis-cli` or at runtime. Designs behind
several items live in [design/](./design/README.md). Items marked `phis-ui` are carried out there but
tracked here because the server contract depends on them.

## Page addresses and references

- **Site Page against Module addresses.** The path-change collision check looks only in
  `site_page_scopes`; Site against Module is unchecked in both directions. Implement
  [PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 1.
- **Collision dialog** (`phis-ui`): say whether a taken Public address is already published
  ([PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 2).
- **Standing list of Public addresses**, editable while every Module stays enabled, and the update command
  reporting a Module deactivated by a colliding Public path before rollout
  ([PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 3).
- **Durable redirects** for published Site Page paths that move
  ([PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 4).
- **Page references ignore publication.** `POST /api/v1/site/references` and
  `projectSiteNavigationOverlayTargets` answer a path for any Scope that is not tombstoned, published or
  not. Undecided; collect the cases before changing it. Folder addresses check publication themselves.
- **Pending path display** (`phis-ui`): the Builder shows a pending path only in the rename message, not in
  the Page catalog, the Page settings, or the navigation target pickers, where
  [REFERENCES.md](./REFERENCES.md) requires it.
- **Breadcrumb segment links** (`phis-ui`): the breadcrumb Widget shows Site, Area, and the whole path as
  one unlinked segment. A folder segment should link exactly when its folder address resolves to a Page.
- **Sitemap split** (`phis-ui`): a Site with more than 50,000 URLs needs several sitemap files.

## Media and storage

- **Provider disable and restore.** `media_storage_profiles.flags` is carried through reads and never
  interpreted; the only fail-closed path is an unregistered provider id. Decide what happens to Assets
  bound to a disabled profile, give the operator a surface for it, then enforce and test it.
- **`site_media_config.allowed_storage_profile_ids` is not read anywhere.** Enforce it together with
  per-Space profile selection.
- **Profile selection on the Site side.** `phis storage use` sets the Site Space only. Which profile a
  User or Group Space uses, the allowed list, and per-user User Space quota overrides need a Site
  administration surface over Core services, with no S3-specific UI or endpoint. A Site surface that
  writes a profile reconciles the bucket's CORS and lifecycle rules through
  `reconcilePhiMediaStoragePoliciesWith`, as the CLI does.
- **Presigned PUT versus proxied stream** has no setting; the S3 Provider always issues `presigned-put`.
- **`max_object_bytes` does not know which path an object takes.** One Site number bounds a proxied
  body and a presigned PUT alike, although the two carry wildly different sizes. Making it
  Profile-aware means moving the size check in `uploads/init` after the Space resolution
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 6).
- **Abandoned staging objects and unfinished assemblies are cleaned up by the storage now, and what is left
  is the Local Provider.** The storage contract has `applyLifecyclePolicy` beside `applyCorsPolicy`, and the
  same occasion writes both: an abort rule for uploads nobody completed and an expiry rule for staged bodies,
  reconciled whenever a Profile is written. Measured against Garage v2.3.0, and the rules are read back from
  the bucket in the live suite. Expiry waits one day longer than an upload session may live, because a
  lifecycle rule takes whole days and is evaluated asynchronously.

  **The expiry sweep cleans up too, now that it can.** `releaseExpiredMediaUploadSessions` returns each
  released session's Profile, staging key and the Provider's name for an unfinished assembly instead of only a
  count -- the row being the only record of those, and deleting it being what frees the reservation. `init`
  removes them after its response, over the Provider it already opened for that Space, and leaves sessions on
  another Profile to that storage's rule. So the two layers divide the work: the sweep clears up while there
  is traffic, the rule catches what no request ever comes back for.

  Two things still open here:

  - **The Local Provider needs no rule but still has a gap of its own.** It answers `applyLifecyclePolicy`
    as a no-op, rightly: its files are Core's own and a lifecycle rule is for a storage Core cannot see into.
    The expiry sweep now removes what it left, so the ordinary case is covered -- what is not is a staged file
    whose session row was deleted before the sweep learned to return it, or one whose removal failed. Those
    stay in `/var/phis/media`, and `phis media check --fix` is about ownership rather than about this.
  - **A Provider that refuses the rule keeps its objects.** The reconciliation reports the two halves apart
    and does not fail on the lifecycle one, which is right -- a storage without object lifecycle still has a
    CORS rule worth writing -- but nothing then tells an operator that this particular storage will go on
    accumulating. It is a line in `phis storage cors` output and nothing more.
- **An upload sent in parts survives the page it was started from, and what is left is the crash.** A body
  above one part leaves its parts at the Provider, and until now a reload threw them away: the Client
  reported `cancelled` on `pagehide`, which is the teardown. It reports `interrupted` instead where the plan
  was an assembly, the session keeps its row, its reservation and its parts at status `Interrupted`, and the
  next `uploads/init` for the same file answers with that session -- signed addresses for the parts still
  missing, and the entity tags of the ones already stored, which exist nowhere else now that the page that
  read them is gone. The Provider is asked what it holds (`resumeUploadPlan` over `ListParts`); Core keeps no
  tally that could disagree with the storage. Identity is the `sha256-composite` and nothing weaker, and the
  `expires_at` is never moved, so continuing is not a way to hold a Space's capacity open. Verified against
  Garage v2.3.0, including that the assembled object carries the same digest a single run would have
  produced.

  What is left:

  - **A browser that crashes reports nothing, so its parts are not offered.** `pagehide` covers a reload, a
    closed tab and a navigation away, which is the ordinary case; a killed process, a power cut or a crashed
    tab sends no beacon at all, and that session sits at `Pending` until the sweep removes it and aborts its
    assembly. Offering those too would mean treating a session that may have a page sending into it right
    now as resumable, and two pages writing the same part numbers is worse than one re-upload. It would take
    something a page renews while it is delivering -- a heartbeat on the session -- to tell the two apart.
  - **Continuing is only ever offered for a file the person picks again.** A `File` handle cannot survive a
    reload, so nothing can restart by itself; what the digest buys is that re-picking the same file is
    recognised as the same bytes rather than merely the same name. A person who renames the file before
    picking it again uploads it again, because the Asset takes its name from the session.
  - **An Add-on's own reservation cannot be carried on.** `assets:v1` never asks for `mayAssembleFromParts`,
    so its plan is a single PUT at any size and there is nothing to continue. The Client half is shared and
    already carries what it would need.
- **Digests for direct uploads, and what is left of it.** A body delivered straight to an S3 endpoint used
  to reach `finalize` with an `md5` read off the ETag, which duplicate detection never compares -- so no
  Asset stored through an S3 Profile was deduplicable, at any size. The Client now hashes before it asks
  for a session and `uploads/init` signs that digest into the upload request, which is what makes a figure
  Core never computed recordable: the endpoint refuses a body that does not match it. Measured against
  Garage v2.3.0, and so is everything below.

  Above one part the digest is per part and the assembled object carries `sha256-composite`. That is not a
  weaker answer, it is the only one available: `ChecksumType: FULL_OBJECT` is accepted for `CRC32`,
  `CRC32C` and `CRC64NVME` alone, while `SHA1` and `SHA256` take `COMPOSITE` -- so the whole-object digest
  the old `mayAssembleFromParts` waited for can never exist, and the permission it gated never opened. It
  is a size question now. A part's digest has to be *signed*, and a presigner puts it in the query string:
  a checksum header outside the signed set is refused, sent alone or repeating the signed value. Which is
  why the division is a contract rule both sides compute rather than a Provider's arithmetic, and why the
  Client hashes per part at all -- Web Crypto has no incremental digest, so hashing a two-gigabyte file
  whole would mean holding it in memory.

  What is left:

  - **The part-size rule is frozen now that objects can exist under it.** `resolvePhiMediaUploadPartSizeBytes`
    and `PHIS_MEDIA_UPLOAD_MAX_PART_COUNT` decide what a `sha256-composite` value means, and the value
    names the division so a changed rule is a non-match rather than a false match. Changing either is a
    decision about every object already stored, not a tuning knob, and there is nothing in the build that
    would stop somebody editing them.
  - **Assets stored before this can be given a digest, by an operator.**
    `POST /api/v1/media/checksums/recompute?site=<key>&limit=<n>` reads each object back and records the digest
    a Provider would report for it -- a plain SHA-256 where the object arrived whole, the composite where its
    ETag says it was assembled, and nothing where the divisions are not this system's. Bounded by `limit`,
    because each one is a whole object read from storage, and it answers with how many are left. Idempotent: an
    Asset with an identity-grade digest is no longer selected.

    What it cannot do is decide about what it finds. A digest that turns out to name another Asset in the same
    Space is recorded and reported, because which of two Assets holding the same bytes should go is a decision
    with owners, Folders and references behind it. There is no surface that shows an operator those reports
    other than the response and the log.
  - **A Profile recording SHA-512 gets no digest for a direct upload.** These are SHA-256 digests and a
    SHA-512 Profile cannot compare them, so the claim is dropped. Garage verifies a declared `SHA256` but
    accepts a wrong `SHA512`, so in practice no probed endpoint here chooses SHA-512 -- but a Profile could
    still be recorded that way, and then its large objects silently carry nothing.
  - **The 2 GB ceiling is per request, so multipart clears it after all.** `nginx` caps a body at 2 GB on
    `phis.dev` and on `s3.phis.dev` alike, so no single PUT passes it whatever S3 would allow -- but a part
    is its own request of 16 MiB, so an assembled object is bounded by part size times
    `PHIS_MEDIA_UPLOAD_MAX_PART_COUNT` (16 GiB before the part grows instead of the count) and not by nginx.
    An earlier note here said the opposite.

    What does bound it today is the Site's own `max_object_bytes`, and on this installation that is 128 MiB.
    So multipart is in effect for bodies between 16 and 128 MiB until an operator raises the figure in the
    Admin media settings -- which is where the entry above about that figure not knowing which transport
    carries it becomes practical rather than theoretical.
- **An S3 Profile whose endpoint is `http://` is unusable from an `https://` Site, and the error says
  nothing.** The browser blocks the presigned PUT as mixed content and the page sees `TypeError: Failed to
  fetch` -- not a CORS message, not a status, nothing naming the cause. `publicEndpoint` is what solves it
  (the address a browser resolves, signed for, while Core keeps talking to the internal one), so the fix is
  to require it: a Profile whose `endpoint` is `http` and whose `publicEndpoint` is unset cannot serve a
  browser on any Site that is served over TLS, and neither `storage add` nor the probe says so. Measured
  from a real browser against the dev Garage.
- **Object key prefix ownership.** Core writes `sites/<key>/…` and an S3 profile may add its own bucket
  prefix, so a profile configured with `sites/<key>` stores under `sites/<key>/sites/<key>/…`. Decide the
  owner, and have a profile form state what Core prepends.
- **Provider readiness across instances.** Before a Site profile becomes available, prove that every
  serving instance carries the same provider manifest and can resolve the profile's secrets.
- **Custody and audience.** `canDeliverMediaAsset` still requires a `User` Asset to sit in its owner's User
  Space. Change it together with the first Asset transfer, which waits for a Module handler context as its
  first caller ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) sections 1-2).
- **Audience validation at publish**
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 3).
- **Signed delivery URLs**
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 4).
- **Storage migration job** with operator-visible progress
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 5), plus provider health
  and capacity diagnostics, optional scanning or quarantine integration, and a CDN projection. Prefix
  listing stays a maintenance tool and never replaces the Asset catalog.
- **Explicit Media response projection.** `serializeMediaAssetForTile` and `…Detail` expose the full
  management record minus storage fields (`projectPublicMediaAsset` in `src/lib/media-response.ts`),
  including `meta`, the checksum, and audit ids, to any Media-role viewer. Replace the subtraction with an
  explicit field list, as the public reference projection has.
- **Variant requests for non-image Assets.** DB.md says they return a fixed SVG preview icon;
  `src/app/api/site/media/[id]/variants/[variantKey]/route.ts` answers 404, and no client requests such a
  URL because `thumbnailUrl` is null for non-images. Implement the icon or amend DB.md.
- **Fonts without coverage.** A font uploaded before `meta.font.coverage` existed has `coverage: null` and
  is delivered whole. Re-read its metrics in a `phis maintain` task or leave re-upload to the operator.
- **Font licences** (`phis-ui`): subsetting modifies the file, which some commercial webfont licences
  forbid; say so where a font is uploaded.

## Groups and directories

- **Provider-ready group projections.** Add authority metadata and per-operation capabilities to the
  `groups:v1` routes and a Directory-binding repository boundary
  ([DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md) sections 3 and 5). The `directory_*` tables
  exist and are unused. Do not implement an external Directory Provider in v1, and do not let the local
  UI or API assume every resource is writable.
- **Directory Add-ons** after v1: a first reference Add-on against
  [DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md), then LDAP, Active Directory, SCIM, or Entra
  packages as separate Add-ons.
- **Group regressions.** Add PostgreSQL tests for self and group membership administration and the Core
  role matrix on `/api/v1/groups` and `/api/site/groups`.

## Navigation and the Account surface

- **Account menu as a navigation surface** (`phis-ui`). `PhiAccountMenuState` is a closed union with fixed
  slots, so no Module can contribute an entry. Make it a navigation surface on the existing
  `PhiCmsNavigationInjectionDescriptor` path, with `exportedItemKeys` naming where a foreign Module may
  attach. It stays operator-editable; a missing required Account anchor gets the same fail-closed publish
  diagnostic as a missing `/login` owner, and `phis auth restore-preset` is the recovery. A Module must not
  assume its injected entry is still reachable.
- **Command targets** (logout as a navigation target) wait for a second caller.

## Authentication

- **Auth Module replacement.** One atomic operation for a Site that deactivates conflicting Auth UI
  provider Modules in the affected Areas, activates the replacement's Area projections, verifies that
  exactly one active Public provider owns `/login`, and reports every activation and preset change. Do not
  derive the login path from a package name. Keep it idempotent: preserve unrelated navigation
  customization and historical Page revisions, and clear only the Auth-owned pointers, overrides, and
  tombstones the operation requires.
- **Where the replacement's capability check runs.** The control plane holds no Module metadata, so it
  cannot verify that the chosen projections provide `site-settings`, `account-security`, or in-place
  `primary-login`. The check belongs wherever the Module catalog is resolvable.
- **Passkeys, email OTP, SMS OTP, setup token, and CLI emergency recovery**
  ([AUTHENTICATION_PLANNED.md](./design/AUTHENTICATION_PLANNED.md)).

## Site bootstrap and releases

- **The first release waits on `@phis/contracts@0.4.0` reaching the registry.** The publish itself is
  prepared: `pnpm package:dist` assembles the tarball and validates it, and a `v*` tag ships that one build
  as both `@phis/server` on npm and the Debian package on the GitHub release. What a tag here still needs is
  the sibling it names. The manifest names it the way a published package must -- `^0.4.0` rather than
  `workspace:*` -- and the release installs this repository as a package of its own, so that range is
  answered by the registry and not by the workspace. `@phis/contracts` is tagged `v0.4.0` and carries the
  media upload assembly, the resumption input and the thread and translation shapes this code compiles
  against, but that tag has to be pushed and its own release has to succeed before a tag here can get
  through its typecheck. Nothing changes locally in the meantime: `linkWorkspacePackages` keeps linking the
  local sibling for as long as its version satisfies the range.
- **A Module from a tarball and `transpilePackages`.** `phis module add` records the package, writes the
  dependency and rewrites the projection, and nothing names the package in the Site's `next.config.ts`. A
  Module linked from a workspace resolves to a path outside `node_modules` and Next compiles it either
  way; one installed from a tarball is not compiled, and its `./fonts` boundary -- a `next/font/local`
  call Next evaluates only in a module it compiles -- then contributes no typefaces and says nothing
  ([phis-ui NEXT_INTEGRATION.md](../phis-ui/NEXT_INTEGRATION.md#fonts)). It is not written from the CLI
  today because `next.config.ts` is a Site-owned source file that `reconcile` leaves alone: editing it
  would mean parsing whatever the Site has made of it, and a regex over somebody's config is how a Site
  loses its cache handler. The projection is the place it belongs -- a generated list of the installed
  package names that the scaffold's `next.config.ts` spreads into `transpilePackages`, so the list follows
  what is installed instead of the operator's memory.
- **One first-install flow.** A new Site needs `phis site add` before `phis init`. Provide one documented,
  transactional CLI flow that registers and validates the Site and then materializes its scaffold, leaving
  neither a partially registered Site nor a partial source tree on failure.
- **Release-resolved scaffold dependencies.** `src/lib/site-scaffold.mts` hard-codes dependency and
  package-manager versions. Resolve the exact compatible set from the installed `phis` release and the
  selected package manager, verify availability, and record it in the scaffold manifest and the sole
  lockfile, including the Site's installed Modules.
- **Consistent lifecycle.** `init` installs only with `--install` and never builds; `update` installs,
  checks, builds, and writes a release artifact. The first-install path must produce a verified runnable
  Site in one operation with consistent install, typecheck, build, artifact, and cleanup behaviour.
- **End-to-end scaffold test.** Create a Site in an empty temporary directory, install, typecheck, build
  for production, and verify the generated route families, without a `phis-site-skeleton` checkout.
- **Complete release artifact.** Record the lockfile, scaffold manifest, Module projection, and bound
  Add-on capability requirements in one immutable versioned artifact. Production Instances deploy that
  artifact and never build independently.
- **Replace an Instance on one host without dropping a request.** Health-check the candidate before
  promoting it, take the old Instance out of routing before replacing it, and stop on failure with the
  previous release still serving. A single-Instance Site needs a temporary candidate slot on a distinct
  port, socket, or network namespace. This is the one host's own update, and it belongs here; co-ordinating
  it across hosts does not (see [Infrastructure management](#infrastructure-management-belongs-to-phis-host)).
- **Post-operation verification.** After init, reconcile, update, or rollback, verify routes, dependency
  graph, build, health endpoint, active release, and proxy target; a failed verification never promotes a
  partial scaffold or leaves every Instance unavailable.
- **Direct Source proxy mode** stays development-only.

## Infrastructure management belongs to phis-host

Where the line falls, and why it is drawn here rather than left to whatever gets built first.

**One host is self-sufficient in this repository.** Creating the database and its two roles, applying the
schema, registering and scaffolding a Site, generating its systemd and proxy configuration, building a
release artifact, and replacing that host's own Instance without dropping a request: all of it is `phis` and
its CLI, Apache-2.0, and complete without anything bought. An installation that needed a commercial
component in order to run at all would make that licence a formality, and a reader would be right to say so.

**What begins where a second host does is `phis-host`.** Fleet inventory, authenticated transport between
hosts, central health, drain and promotion across Instances, provisioning for many tenants: operational work
whose value grows with the number of hosts. That is what a company pays for and what a single operator does
not need, so it is a separate product and never a prerequisite. Its licence is decided there, not here.

The consequence for this list: the two entries below were written here before the line existed. They are
kept as a record of what is intended and of where it now goes -- neither is work for this repository.

- **Upstreams from healthy Instances.** Proxy configuration resolves one primary Instance from
  `SiteLocation` in `config/phis-runtime.json` (`src/lib/site-deployment-config.ts`). Generating upstreams
  from the healthy, same-release rows of `phis.server_instances` is the fleet's question. What stays here is
  the single endpoint that configuration names, and that Instances on one host need distinct ports or
  isolated sockets.
- **Release distribution** to remote hosts with authenticated transport, host health checks, drain and
  promotion, rollback, and a consistent release inventory. Building the artifact is this repository's
  (see [Complete release artifact](#site-bootstrap-and-releases)); moving it between hosts is not.

## PostgreSQL high availability

Split by the same line. What this repository owes a highly available database is to work correctly against
**one** endpoint that may fail over beneath it -- reconnecting, not assuming a connection outlives a query,
and never treating replication as multi-primary. Building and operating the topology that endpoint stands in
front of is infrastructure work, and belongs with
[phis-host](#infrastructure-management-belongs-to-phis-host).

- Define and automate a multi-host primary/standby topology with streaming replication, and make the
  asynchronous or synchronous durability choice explicit per deployment class.
- Give every Instance one stable database endpoint, with controlled failover, fencing, and split-brain
  prevention. Do not present replication as multi-primary operation.
- Monitor primary and standby health, replication lag, WAL retention, disk capacity, and failover state.
- Keep disaster recovery separate: tested base backups, WAL archiving, and point-in-time recovery on
  storage outside the database hosts' failure domain.
- Document and rehearse failover, rejoin, restore, and full-host loss before calling the tier highly
  available.

## Server Add-ons

- **One invalid Add-on desired state answers 500 on every viewer resolution.**
  `buildPhisCapabilitySnapshot` validates the whole of `config/phis-addons.json` and throws when any entry
  fails, so `GET /api/v1/site/capabilities` and `GET /api/v1/auth/me` answer 500 and a Site stops rendering
  entirely -- observed when the `mediaStorage` interface digest was raised while the installed
  `@phis/storage-s3` still recorded the previous one. The Module side already degrades gracefully in exactly
  this situation: `resolvePhiRuntimeModuleServerBinding` reports `capability_missing`, the Module leaves
  `activeModuleIds`, and its Widgets raise a local `missing-module` without disturbing anything else. So the
  snapshot should drop an entry it cannot validate and let that path carry it, rather than refusing the
  whole build. Two questions come with it: whether digest validation belongs at install and reconcile only,
  as [SERVER_ADDONS.md](./SERVER_ADDONS.md) describes it ("at install, with the value quoted back, rather
  than at the first call"), and why `phis addon check` validated the same state without complaint while the
  serving process refused it. The pre-v1 rule in `@phis/contracts`' README avoids the trigger; it does not
  make the failure mode acceptable.

## Code hygiene

- **Add-on capability execution under `src/db/`.** `scripts/validate-db-sql-boundary.mjs` still reports
  the call sites in `src/lib/addons/data-capability.ts`, `assets-capability.ts`, and `capabilities.ts`.
  They execute statements Core derived from an Add-on's manifest. Move the execution into typed functions
  under `src/db/`. The guarantee that an Add-on never receives a database handle is pinned by
  `src/lib/addons/data-capability-handle.test.ts` and must stay so.
- **Closed-vocabulary constants without direct references** -- the `SUPPORT_TICKET_*` and
  `SUPPORT_GITHUB_*` families in `src/db/support.ts`, `SITE_CONTENT_TYPE_PAGE/LEGAL/SNIPPET`,
  `PhiCmsPageType`, `PhiCmsRegionStatus`, `PhiCmsRevisionScopeType`, `PhiMediaFolderFlags`, and
  `PHIS_INSTANCE_FLAG_READY` -- document their vocabularies and are kept. Keep this list current so the
  unused-export scan stays honest.
- **Exports used only by tests:** `createPhiAssetUri` and `createPhiPageUri` (server side),
  `createPhiPresetCmsInstanceId`, `createTotpCode`, `encryptAuthTransactionPayloadWithKey`, and
  `hasTranslationContextFlag`. Remove them or give them a production caller.
- **Test placement.** Most tests are co-located as `src/**/*.test.ts`, while `test/` still holds
  `config-core.test.ts`, `html.test.ts`, `locale.test.ts`, `translation-context.test.ts`, and fixtures.
  Pick one convention.
- **CMS route prologues.** The CMS read and write route helpers in `src/lib/site-cms-*.ts` repeat near
  identical guard and parameter prologues; one context builder would serve them.
- **Server-side logging in `phis-ui`.** `gateway/tr.ts`, `navigation-descriptor-resolver.server.ts`,
  `server-helpers/runtime.ts`, `server-helpers/cms-request.ts`, `gateway/navigation-target-route.ts`, and
  `plugins/runtime-modules/resolver.ts` write through `console.*` instead of `net/log.ts`, so journald
  receives more than one format. Keep `net/log.ts` field-identical with `src/lib/log.ts`.

## Post-v1: Core schema evolution

Not v1 work. Until v1 the development database is recreated or adjusted by hand, which is what
[DB.md](./DB.md) states and what every schema change in this repository has relied on.

What ends that arrangement is the first installation nobody may drop. Two things are missing before
then, and both are `phis-cli`:

- **`schema check` compares table names only.** It reads `CREATE TABLE` lines and asks `pg_tables`, so a
  database missing a column a release added is reported as current. The command's own comment already
  names that as the case it exists to catch. Column, constraint and index comparison is the smaller half
  and the one that has to come first, because nothing can be repaired that nothing can detect.
- **`schema apply` can only create.** There is no `ALTER TABLE` anywhere in `src/cli/` or `src/db/` for
  the Core schema, so applying a changed script to a live database is a no-op for every table that
  already exists.
- **The migration role may not be able to alter.** The CLI takes its connection from
  `database.migrationUri` and says why -- migration authority is meant to be separate from the runtime
  role. On the development database every table in `phis` is nevertheless owned by the runtime role,
  and the migration role is in no group that would lend it ownership, so `ALTER TABLE` is refused with
  `must be owner of table`. Creating hides this, because `CREATE TABLE` needs a privilege on the schema
  rather than on a table and makes its creator the owner; it surfaces the first time something changes
  instead of creating. Whichever way it is settled -- the migrator owns the tables, is granted what it
  needs, or `migrationUri` means something narrower than its name -- it has to be settled before an
  alter path is written, or that path will be written against a role that cannot run it.

Whatever is built for it reports what it found before it changes anything, and is idempotent. No silent
backfill and no scheduler, on the same terms as the section below.

## Post-v1: CMS payload migration policy

Not v1 work. v1 accepts ABI breaks and ships no fallback, shim, or compatibility reader, so this section
must not be used to justify one; in v1 the repair is to clean or recreate the affected Draft, Navigation
item, or Area revision.

`readValidatedPageRevisionTree` applies `validateCmsPageWriteInput`, the write validator, to persisted
revisions, so tightening a payload rule invalidates stored data on read and the Builder answers `500`.
`parseSiteNavigationOverlay` guards every Navigation read the same way. An Area revision saved before the
Area reference source existed carries no index row until it is saved again, so the Asset delete guard
cannot see a reference that sits only in its Region or Widget config.

When a versioned payload beyond v1 is introduced:

- Decide whether the read boundary normalizes retired fields for a declared payload version, or a
  validated `phis-cli` repair operation upgrades stored revisions explicitly.
- Keep exactly one path, and do not reintroduce per-field tolerance in the shared validator.
- Report affected scopes and nodes before changing anything, and make the operation idempotent. No silent
  backfill and no scheduler.
