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
- **`max_object_bytes` is a default nobody chose**, and it bounds three different things through one
  number -- Site policy, what a Storage path can carry, and how much `storage:v1` holds in memory.
  Raising it to 128 MiB and giving `storage:v1` a streaming shape land together
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 6).
- **Multipart upload plan.** The upload-plan ABI knows `proxy-stream` and `presigned-put`. Add multipart as
  a plan kind when the S3 Provider implements it, with abort and expiry cleaning staged parts and
  reservations. Until then `nginx` caps a proxied body at 2 GB and S3 accepts a single PUT up to 5 GB.
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
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 5).
- **Storage migration job** with operator-visible progress
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 6), plus provider health
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

- **Support teams on general groups.** Support keeps its own `support_team_members`
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 4).
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
  `server-helpers/runtime.ts`, `server-helpers/cms-request.ts`, `next/navigation-target-route.ts`, and
  `plugins/runtime-modules/resolver.ts` write through `console.*` instead of `net/log.ts`, so journald
  receives more than one format. Keep `net/log.ts` field-identical with `src/lib/log.ts`.

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
