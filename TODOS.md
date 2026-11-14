# Phi Server TODOs

This backlog records approved work that is not implemented yet. It is not a compatibility contract and
must not be used to infer that an item is already available in `phis-cli` or at runtime. Designs behind
several items live in [design/](./design/README.md). Items marked `phis-ui` are carried out there but
tracked here because the server contract depends on them.

## At the next release

- **Released as `@phis/server` 0.3.0 together with `@phis/ui` 0.5.0**, both already in `package.json`; the
  entries below are why neither works with the other's previous version. `@phis/contracts` is unchanged
  (0.7.7). Tagged 14.11.2026; this section goes once every installation has the columns below.
- **Columns added since the installed release.** Releases carry `CREATE` only, so a running installation
  needs these by hand before the new Server starts (dev has them):
  `ALTER TABLE phis.media_upload_sessions ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ NULL;`
  `ALTER TABLE phis.site_media_config ADD COLUMN IF NOT EXISTS default_user_storage_profile_id INT NULL REFERENCES phis.media_storage_profiles(id) ON DELETE SET NULL;`
  `ALTER TABLE phis.site_media_config ADD COLUMN IF NOT EXISTS default_group_storage_profile_id INT NULL REFERENCES phis.media_storage_profiles(id) ON DELETE SET NULL;`
- **Server and `phis-ui` go out together.** The Media management projection no longer carries `meta`
  (`focalRect` and `font` instead) and the Asset PATCH takes `focalRect` instead of `meta`; an older
  `phis-ui` would lose focal rectangles and font metrics in the editor. The references endpoint's `preview`
  flag and the upload `heartbeat` are additive.

## Payments

- **Pricing policies in the sandbox.** PAYMENTS.md section 12 and the Stripe mapping of PAYMENTS_STRIPE.md
  section 8 are implemented and unit-tested against recorded Sessions. A real test-mode run per policy is
  open: a net checkout with a Swiss tax registration, a gross (inclusive) checkout, a stated coupon, a
  customer promotion code and, once the account is eligible, a Managed Payments checkout. The development
  database carries the altered `phis.payments` check constraints only after the in-place alter of DB.md.
The approved v1 contracts in [PAYMENTS.md](./PAYMENTS.md) and [PAYMENTS_STRIPE.md](./PAYMENTS_STRIPE.md)
now have Core persistence/execution, grants, CLI controls, notification inbox, owner-directed outbox,
registered Payment capabilities/service/event and the independent Stripe Provider. Fault/concurrency
checks run against PostgreSQL. The real sandbox Core/Stripe checkout and partial/idempotent refunds
passed with isolated test fixtures. A separate compiled test installation's Core was subsequently updated
and its public proxy accepted a genuine Stripe checkout expiry notification (HTTP 200); signed smoke
requests and missing/invalid/body-mismatched signature rejection also passed. The enabled test
profile currently has no consumer grants. A subsequent installed `@phis/payment-probe` test verified
correlated settlement through genuine public Stripe notifications, durable inbox/owner-event delivery
and one persisted fulfilment, without a completion/refresh grant or browser completion command.
Concurrent duplicate replays preserved the Payment version and fulfilment count, and a full refund's
idempotent repeat reused its identities. All test purchases were refunded and all Core receipts/events
processed.

- Extend the sandbox matrix with a real decline, manual authorization/final partial capture,
  authorization cancellation and an external Dashboard refund. Automated Provider/Core tests cover
  these mappings and transaction boundaries; the real sandbox run so far covered automatic payment.
- Define administrative retention/export before adding any destructive financial purge.

## Shop

- **A sandbox checkout through the Shop** on `stripe-sandbox`: a manager creates a destination for `CH`
  (`net`/`provider`) and a product, then `POST /api/addons/phis/shop/orders` and the hosted page.

## Page addresses and references

- **Standing list of Public addresses**, editable while every Module stays enabled, and the update command
  reporting a Module deactivated by a colliding Public path before rollout
  ([PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 3).
- **Durable redirects** for published Site Page paths that move
  ([PUBLIC_ADDRESSES.md](./design/PUBLIC_ADDRESSES.md) section 4).

## Media and storage

- **Profile configuration from the Site side.** A surface that edits a Storage Profile's own configuration
  would reconcile the bucket's CORS and lifecycle rules through `reconcilePhiMediaStoragePoliciesWith`, as
  the CLI does. The Admin Media settings point Spaces at Profiles (the Site Space, the defaults for new User
  and Group Spaces, each existing Space with its own quota, built 14.11.2026) but edit none.
- **`max_object_bytes` does not know which path an object takes.** One Site number bounds a proxied
  body and a presigned PUT alike, although the two carry wildly different sizes. Making it
  Profile-aware means moving the size check in `uploads/init` after the Space resolution
  ([GROUPS_AND_STORAGE_PLANNED.md](./design/GROUPS_AND_STORAGE_PLANNED.md) section 6).
- **An upload sent in parts survives the page it was started from, a crash included.** A body
  above one part leaves its parts at the Provider, and until now a reload threw them away: the Client
  reported `cancelled` on `pagehide`, which is the teardown. It reports `interrupted` instead where the plan
  was an assembly, the session keeps its row, its reservation and its parts at status `Interrupted`, and the
  next `uploads/init` for the same file answers with that session -- signed addresses for the parts still
  missing, and the entity tags of the ones already stored, which exist nowhere else now that the page that
  read them is gone. The Provider is asked what it holds (`resumeUploadPlan` over `ListParts`); Core keeps no
  tally that could disagree with the storage. Identity is the `sha256-composite` and nothing weaker, and the
  `expires_at` is never moved, so continuing is not a way to hold a Space's capacity open. Verified against
  Garage v2.3.0, including that the assembled object carries the same digest a single run would have
  produced. A crashed page, which reports nothing, is covered by a heartbeat (`heartbeat_at`, renewed every
  20 s while parts are sent): a session whose beat lapsed for 60 s is offered like an interrupted one, and the
  take-over is one conditional update, so two attempts cannot both continue it.

  What is left:

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

  - **The part-size rule is frozen**: `src/lib/media-upload-digest.test.ts` pins
    `resolvePhiMediaUploadPartSizeBytes` and `PHIS_MEDIA_UPLOAD_MAX_PART_COUNT`; changing them is a decision
    about every stored object.
  - **Duplicates found by the digest recompute have no surface.** Recomputing is built:
    `POST /api/v1/media/checksums/recompute?site=<key>&limit=<n>` reads each object back and records the digest
    a Provider would report for it -- a plain SHA-256 where the object arrived whole, the composite where its
    ETag says it was assembled, and nothing where the divisions are not this system's. Bounded by `limit`,
    because each one is a whole object read from storage, and it answers with how many are left. Idempotent: an
    Asset with an identity-grade digest is no longer selected.

    What it cannot do is decide about what it finds. A digest that turns out to name another Asset in the same
    Space is recorded and reported, because which of two Assets holding the same bytes should go is a decision
    with owners, Folders and references behind it. Decided (14.11.2026): log only for now, to see whether it
    occurs at all -- each pair is logged as `media.checksum.duplicate_found`. A surface follows only if it does.
  - **The 2 GB ceiling is per request, so multipart clears it after all.** `nginx` caps a body at 2 GB on
    `phis.dev` and on `s3.phis.dev` alike, so no single PUT passes it whatever S3 would allow -- but a part
    is its own request of 16 MiB, so an assembled object is bounded by part size times
    `PHIS_MEDIA_UPLOAD_MAX_PART_COUNT` (16 GiB before the part grows instead of the count) and not by nginx.
    An earlier note here said the opposite.

    What does bound it today is the Site's own `max_object_bytes`, and on this installation that is 128 MiB.
    So multipart is in effect for bodies between 16 and 128 MiB until an operator raises the figure in the
    Admin media settings -- which is where the entry above about that figure not knowing which transport
    carries it becomes practical rather than theoretical.
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
## Groups and directories

- **Provider-ready group projections.** Add authority metadata and per-operation capabilities to the
  `groups:v1` routes and a Directory-binding repository boundary
  ([DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md) sections 3 and 5). The `directory_*` tables
  exist and are unused. Do not implement an external Directory Provider in v1, and do not let the local
  UI or API assume every resource is writable.
- **Directory Add-ons** after v1: a first reference Add-on against
  [DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md), then LDAP, Active Directory, SCIM, or Entra
  packages as separate Add-ons.
- **Group regressions.** The database layer has PostgreSQL tests (`src/db/site-group-*.pg.test.ts`); the
  routes `/api/v1/groups` and `/api/site/groups` and the Core role matrix on them have none.

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
- **Proof-of-work for public contributions (deferred, decided 11.11.2026).** Add an ALTCHA-style
  challenge (MIT library, self-hosted, no third party) to the form guard together with the first form whose
  submissions become publicly visible -- ratings or reviews in Shop/Marketplace, comments on blog entries
  -- or earlier, once spam gets past honeypot, signed timing and rate limit on contact or registration.
  Not before: today no phis form publishes what it receives, and none sees spam. Shape: `issueFormGuard`
  hands out the signed challenge next to the timestamp, `verifyFormGuard` checks the solution; a solved
  challenge counts once (short entry in the cache the rate limit already uses, since the guard is
  stateless today); difficulty per form, optionally raised only once the rate limit trips. `phis-ui`
  places the widget, which only fills a hidden field.

## Site bootstrap and releases

- **`@phis/server` on npm is deferred (20.10.2026).** A `v*` tag releases the Debian package only. The
  server is no runtime that starts once installed -- `phis` or phis-host sets a stage up around it -- and
  the tarball `pnpm package:dist` assembles has never been installed. Publishing is a step added back to
  `release.yml` (npm trusted publishing needs the package to exist first, so the first publish is by hand)
  once it is decided what a registry install is for.
- **One first-install flow.** `phis install` registers a first Site and its administrator, but does not run
  `phis init`, and nothing is rolled back on failure. Provide one transactional flow that registers and
  validates the Site and then materializes its scaffold, leaving neither a partially registered Site nor a
  partial source tree on failure.
- **Release-resolved scaffold dependencies.** `src/lib/site-scaffold.mts` hard-codes dependency and
  package-manager versions. Resolve the exact compatible set from the installed `phis` release and the
  selected package manager, verify availability, and record it in the scaffold manifest and the sole
  lockfile, including the Site's installed Modules.
- **Consistent lifecycle.** `init` installs only with `--install` and never builds; `update` installs,
  checks, builds, and writes a release artifact. The first-install path must produce a verified runnable
  Site in one operation with consistent install, typecheck, build, artifact, and cleanup behaviour.
- **End-to-end scaffold test.** Create a Site in an empty temporary directory, install, typecheck, build
  for production, and verify the generated route families, without a `phis-site-skeleton` checkout.
- **Complete release artifact.** `release.json` (`buildPhiSiteReleaseArtifact`) records the release id,
  scaffold version, build id and app directory; add the lockfile, scaffold manifest, Module projection, and
  bound Add-on capability requirements, so it is one immutable versioned artifact. Production Instances deploy that
  artifact and never build independently.
- **Replace an Instance on one host without dropping a request.** Health-check the candidate before
  promoting it, take the old Instance out of routing before replacing it, and stop on failure with the
  previous release still serving. A single-Instance Site needs a temporary candidate slot on a distinct
  port, socket, or network namespace. This is the one host's own update, and it belongs here; co-ordinating
  it across hosts does not (see [Infrastructure management](#infrastructure-management-belongs-to-phis-host)).
- **Post-operation verification.** After init, reconcile, update, or rollback, verify routes, dependency
  graph, build, health endpoint, active release, and proxy target; a failed verification never promotes a
  partial scaffold or leaves every Instance unavailable.
- **Remove a Site from the host, not only from the database.** `phis site del` deletes the Site's rows and
  its `sites.overrides` entry and nothing else. Removing twoofhearts (14.11.2026) left the systemd unit
  `phis-site-<key>`, the nginx server block in `sites-available`/`sites-enabled`, the Let's Encrypt
  certificate, the Instance symlink under `/srv/phis/instances`, and the source tree with every release
  under `/srv/phis/sites/<key>` -- all of which `phis` generated or built, and all removed by hand. Give it
  the shape of `phis stage remove`: without `--force` it only lists what it would remove and what it finds
  but did not make; stop and disable the unit before the rows go; `--backup <file.tar.gz>`,
  `--keep-certificate`, `--keep-source`; reload the proxy only after its configuration tests clean.
- **Release retention.** `phis update` writes a new release under `<site>/.phis/releases/` every run and
  never removes one: on 14.11.2026 phis held 50 (6.8 GB) and phisys 62 (8.5 GB), about 140 MB each, beside a
  2.3 GB `.next/cache` in the source tree. Keep the active release and a configurable number of previous
  ones for rollback (never the one an Instance symlink points at), prune the rest after a successful
  promotion, and offer `phis release prune --site <key> [--keep <n>]` for what is already there. Whether the
  build cache stays between updates is part of the same decision: it speeds up the next build and is most of
  the source tree's size.
- **Deployment snippets for the web server the stage uses.** The operator UI (`/operator?section=sites`,
  `buildDeploymentBlocks` in `src/components/operator/operator-sites-panel.tsx`) offers the Apache config
  only in the custom mode; docker and systemd show nginx alone. On new.phisys.com (14.11.2026, 0.3.0, systemd,
  `phis proxy config/tls` with Apache) the snippet the operator needed was missing, though
  `buildApacheConfig` in `src/lib/site-deployment-config.ts` is the generator `phis site config apache`
  prints already. Show the server named by `kind` in the stage's `config/phis-proxy.json` first, else
  whichever of apache2/nginx is installed, with the other one collapsed; when that record has `tls: true`,
  the snippet carries the 443 host and the redirect the way `phis proxy config --tls` does for the server.
  Until then: `phis site config apache --key <site key>`.
- **`phis install` leaves the configured directories and the sender unset.** On new.phisys.com
  (14.11.2026, 0.3.0-1+noble, `--mode full`) it created neither `media.local.rootDir` (`/var/phis/media`)
  nor `sites.sourcePathRoot` (`/opt/phis/sources`) nor `sites.instancePathRoot` (`/var/www/phis/sites`),
  and left `email.from` unset. The three paths come only from the `phis-config.json` defaults; INSTALL.md
  says "create it, owned by the service account" for the media root alone, and nothing creates the two
  Site roots. Decided by the owner:
  - `phis install`, in both modes and idempotently, creates all three, owned `phis:phis` with sensible
    modes, and `phis setup status` lists each as a check.
  - Adding a Site -- from the operator UI, `phis site add` or `phis init` -- runs the same creation and
    check, so that path never depends on a manual `mkdir`.
  - The default paths are settled together with this: the defaults in `src/lib/config-core.ts` are not
    the layout this host family uses (`/srv/phis/sites`, `/srv/phis/instances`), and what install
    creates is what `phis stage remove` takes away again.
  - `phis install` asks for the sender (`--email-from`), and `phis setup status` warns while
    `email.from` is unset.
- **A test email through phis.** Nothing verifies that outgoing mail works: on new.phisys.com (14.11.2026,
  `email.from` noreply@phisys.com, `smtp.targets` 127.0.0.1:25 to a local Postfix) the first password
  reset would be the first test. Proposed by the owner:
  - `phis email test --to <address> [--site <site key>]` sends a short message by exactly the configured
    path -- `email.from`/`fromName`, `smtp.targets` in order, `secure`/`ignoreTls`, and with `--site` that
    Site's own sender and SMTP secret -- and prints which target accepted it with the SMTP response and
    queue id, or per target what failed (connect, TLS, auth, sender or recipient refused).
  - The operator UI gets the same as "Send test email" in its email settings, to the signed-in
    operator's address by default.
  - `phis install --email-from` offers it at the end, and `phis setup status` shows the last successful
    test.
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
- **A manifest names the secrets it reads.** Today an Add-on reads a secret by name
  (`capabilities.secrets.read("github-token")`) and nothing in the manifest says which names it will ask
  for; the operator learns them from the Add-on's README, and a missing one shows up only as `null` at the
  first call. A `secrets: [{ name, scope, description, required }]` declaration, beside `settings`, would
  let `phis addon check` and `phis addon site --enable` report what is unset for a Site, let the Admin say
  so, and let `secrets.read` refuse a name the manifest did not declare -- the same closing over the owner
  the capability already does for the Site. Contract change in `@phis/contracts` (manifest type and
  validator); the hook `verification.secret` would name one of the declared entries.

## Code hygiene

- **Add-on capability execution under `src/db/`.** `scripts/validate-db-sql-boundary.mjs` passes only because
  the call sites in `src/lib/addons/data-capability.ts` and `capabilities.ts` carry `db-boundary-exempt`
  markers (14a5a99); the execution itself never moved.
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
- **Deleting unread translations.** `phis translations usage` reports what nothing has read in a while
  (TRANSLATIONS.md, "When a message was last read"); deleting by it is deliberately not built. Once a few
  weeks of reads are in, decide the rule -- a CLI step an operator runs, excluding messages a content
  version still points at -- and whether the orphaned content messages below go the same way.
- **Orphaned content messages.** Deleting a `site_content` row cascades its versions and its
  `site_content_version_text` rows, but the `tr_site_msg` rows they pointed at stay: the foreign key
  cascades from the message to the text row, not the other way. The dev database held 88 such rows on
  30.09., from every content path that ever deleted a row, and the News delete adds to them. A sweep
  belongs to `phis maintain` as a bounded operator-invoked step (`AGENTS.md`), not to the delete -- a
  message may be shared by more than one version, so removing it with one of them is not a local decision.
- **Test placement.** Most tests are co-located as `src/**/*.test.ts`, while `test/` still holds
  `config-core.test.ts`, `html.test.ts`, `locale.test.ts`, `translation-context.test.ts`, and fixtures.
  Pick one convention.
- **CMS route prologues.** Shared readers exist (`requireSite*ApiContext`, `readSiteCmsRequestSearchParam`),
  but each handler in `src/lib/site-cms-*.ts` still repeats the guard and parameter prologue; one context
  builder would serve them.
- **Server-side logging in `phis-ui`.** `navigation-descriptor-resolver.server.ts`,
  `gateway/navigation-target-route.ts`, and `plugins/runtime-modules/resolver.ts` still write through
  `console.*` instead of `net/log.ts`, so journald
  receives more than one format. Keep `net/log.ts` field-identical with `src/lib/log.ts`.

## Post-v1: Core schema evolution

Not v1 work. Until v1 the development database is recreated or adjusted by hand, which is what
[DB.md](./DB.md) states and what every schema change in this repository has relied on.

What ends that arrangement is the first installation nobody may drop. Two things are missing before
then, and both are `phis-cli`. Who alters is settled: the serving role owns the Core schema `phis` and
`schema apply` runs as it (`src/cli/schema.mts`); the migration role owns only Add-on schemas.

- **`schema check` compares table names only.** It reads `CREATE TABLE` lines and asks `pg_tables`, so a
  database missing a column a release added is reported as current. The command's own comment already
  names that as the case it exists to catch. Column, constraint and index comparison is the smaller half
  and the one that has to come first, because nothing can be repaired that nothing can detect.
- **`schema apply` can only create.** There is no `ALTER TABLE` anywhere in `src/cli/` or `src/db/` for
  the Core schema, so applying a changed script to a live database is a no-op for every table that
  already exists.

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
