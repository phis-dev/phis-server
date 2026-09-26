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
  writes a profile reconciles bucket CORS through `reconcilePhiMediaStorageCorsWith`, as the CLI does.
- **Presigned PUT versus proxied stream** has no setting; the S3 Provider always issues `presigned-put`.
- **`max_object_bytes` does not know which path an object takes.** One Site number bounds a proxied
  body and a presigned PUT alike, although the two carry wildly different sizes. Making it
  Profile-aware means moving the size check in `uploads/init` after the Space resolution
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 6).
- **Abandoned staging objects have no sweeper.** Expiry releases the reservation and leaves the object,
  which `DB.md` now states correctly. The two owners the code names do not exist: the storage contract has
  `applyCorsPolicy` and no lifecycle counterpart, so an S3 Profile cannot be given an expiry rule the way
  it is given CORS through `reconcilePhiMediaStorageCorsWith`; and there is no operator command for the
  Local Provider (`phis media check --fix` is about file ownership). Multipart makes this urgent rather
  than untidy: an incomplete multipart upload is billed until it is aborted and does not appear in
  `ListObjectsV2`, so the lifecycle rule it needs is `AbortIncompleteMultipartUpload`, reconciled the way
  CORS already is.
- **Multipart is built and cannot be granted, and the reason is the checksum.** `multipart-put` exists end
  to end: the plan kind, `provider_upload_id` on the session, the S3 Provider signing a `UploadPart` per
  part, the Client slicing and retrying, `completeUpload` assembling, and a reported failure aborting the
  assembly. What gates it is `mayAssembleFromParts`, which Core grants from the Profile's probe answering
  `verifiesWholeMultipartObject` -- and that answer can never be yes. **Measured against Garage v2.3.0,
  and it is the S3 specification rather than a Garage limitation:** `ChecksumType: FULL_OBJECT` is accepted
  only for `CRC32`, `CRC32C` and `CRC64NVME`; `SHA1` and `SHA256` take `COMPOSITE` alone. So the probe
  pairs the verified strong algorithm with a type the API forbids, the grant never arrives, and the branch
  is unreachable on every compliant endpoint.

  The decision that unblocks it is which digest a multipart object carries:

  - **A `COMPOSITE` SHA-256** is `SHA256` over the concatenated binary part digests with `-<parts>`
    appended. It is as collision-resistant as SHA-256 for "are these the same bytes", so it *is* a usable
    duplicate-detection key -- but only within one partitioning. Ours is reproducible, because
    `resolveMultipartPartSize` is a pure function of the size and the same file has the same size. Two
    conditions come with it: it must be its own algorithm in `PHIS_MEDIA_CHECKSUM_ALGORITHMS` carrying the
    part size, never recorded as `sha256`; and the part-size rule is frozen once objects exist under it,
    or the corpus splits the way the checksum-algorithm comment already warns about. The part count is in
    the value, so a differing partitioning is a non-match and never a false match.
  - **A `FULL_OBJECT` CRC** is verified over the whole object but is not comparable -- CRC is linear, which
    `PHIS_MEDIA_COMPARABLE_CHECKSUM_ALGORITHMS` already excludes. It is integrity evidence, not identity.
  - **Neither**, which is what `GROUPS_AND_STORAGE.md` already promises: "accepted and fully verified, part
    by part; it simply carries no digest that duplicate detection can use." `finalize` needs no change for
    this -- it records nothing where nothing can be attested and skips the duplicate query.

  **The measurement that decides it, and it has not been made:** whether S3 requires a checksum on every
  part once the upload is opened with `ChecksumAlgorithm`, and whether that requirement survives a part URL
  whose signature does not cover the header. Without it the composite is the Client's claim rather than
  something the endpoint verified, and then only the third option is honest. Garage runs locally, so this
  is cheap -- see the reference note on running the live suite.

  Two findings from the same run, unrelated to the grant: the S3 probe never deleted its own object, so
  every `storage add` and `storage set` left a nineteen-byte object in the bucket (fixed); and Garage
  verifies a declared `SHA256` but accepts a wrong `SHA512`, which the probe reports as a finding rather
  than a verified algorithm.

  Transport ceilings, unchanged: `nginx` caps a proxied body at 2 GB, and on this installation
  `s3.phis.dev` is also behind `nginx` with the same 2 GB, so the "single PUT up to 5 GB" figure does not
  apply here.
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
- **Rolling release.** Health-check a candidate before promotion, keep a previously healthy Instance
  serving throughout, remove an Instance from routing before replacing it, and stop on failure with the
  previous release active. A single-Instance Site needs a temporary candidate slot on a distinct port,
  socket, or network namespace.
- **Post-operation verification.** After init, reconcile, update, or rollback, verify routes, dependency
  graph, build, health endpoint, active release, and proxy target; a failed verification never promotes a
  partial scaffold or leaves every Instance unavailable.

## Multi-host Instances

- **Upstreams from healthy Instances.** Proxy configuration resolves one primary Instance from
  `SiteLocation` in `config/phis-runtime.json` (`src/lib/site-deployment-config.ts`). Generate upstreams
  from the healthy, same-release rows of `phis.server_instances`. Instances on one host need distinct ports
  or isolated sockets.
- **Release distribution** to remote hosts with authenticated transport, host health checks, drain and
  promotion, rollback, and a consistent release inventory.
- **Direct Source proxy mode** stays development-only.

## PostgreSQL high availability

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
