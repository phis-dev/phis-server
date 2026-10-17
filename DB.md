# Database Model

This document contains the database-facing contract for `phis`.
It covers the target PostgreSQL schema, table-level contracts, and the site/global translation model.

Before v1, `scripts/sql/001_create_phis.pgsql` is the only Core schema source of truth. ABI-breaking
changes are integrated there directly and the development database is recreated or adjusted in place;
there are no incremental Core migration scripts.

**A column added here does not reach a database that already exists, and nothing reports it.** The
script creates with `CREATE TABLE IF NOT EXISTS`, so an existing table is skipped whole, and
`phis schema check` reads `CREATE TABLE` lines against `pg_tables` -- table names only, blind to every
column, constraint and index. An installation missing a column a change added is told that all declared
tables are present, which is true and useless. Recreating or altering the development database by hand
is therefore part of making the change, not a step somebody may discover later.

The script declares every column and every check inside its `CREATE TABLE`, and nothing is added to a
table afterwards. It used to carry `ADD COLUMN IF NOT EXISTS` for a dozen columns, which read like the way
to make a change and was not one: it upgraded whoever reapplied the script and left every other
installation exactly as blind as the paragraph above describes. The only `ALTER TABLE` left is a pair of
circular foreign keys -- `threads.last_message_id` and `media_spaces.addon_id` -- which cannot be declared
until both tables exist, and each is dropped before it is added so the script stays runnable twice. Those
two are structure, not migration, and both say so where they stand.

That is a pre-v1 arrangement and ends with v1: the CLI has to learn to compare columns and to carry an
alter path before an installation exists that cannot be recreated. See
[TODOS.md](./TODOS.md), "Post-v1: Core schema evolution".

## Target phis schema

The target PostgreSQL schema for `phis` is:

### Smallint / flag contracts

- `phis.registration_intents.status SMALLINT`
  - `0 = pending`
  - `1 = verified`
  - `2 = superseded`
  - `3 = expired`
  - `4 = consumed`
- `phis.registration_intents.flags INT`
  - `1 << 0 = newsletter opt-in`
- `phis.site_content.type SMALLINT`
  - `0 = news`
  - `1 = page`
  - `2 = legal`
  - `3 = snippet`
  - `4 = asset`
  - `5 = text`
  - `6 = html`
  - `7 = markdown`
  - `8 = blog`
- `phis.site_content_versions.asset_id INT`
  - each version of a site-owned asset content row references the canonical `media_assets.id`
  - versions of type `asset` rows must set this column
- `phis.site_content.status SMALLINT`
  - `0 = draft`
  - `1 = published`
  - `2 = archived`
- `phis` CMS page revision payload `page.pageType`
  - `0 = standard`
  - `1 = landing`
  - `2 = legal`
  - `3 = system`
  - `4 = redirect`
- `phis` CMS page revision payload `page.layoutConfig.redirect`
  - `target.area` and `target.path` define the redirect destination
  - `status` is optional and defaults to a permanent redirect when omitted
- `phis` CMS page / area revision payload `status`
  - `0 = draft`
  - `1 = published`
  - `2 = archived`
  - `3 = deleted` for page delete drafts; publishing such a page revision makes the live page resolve as not found while preserving revision history
- `phis` CMS revision payload `regionType`
  - `10 = header_top`
  - `11 = header_main`
  - `12 = header_bottom`
  - `25 = hero`
  - `20 = sider_left`
  - `21 = sider_right`
  - `30 = content`
  - `39 = footer_top`
  - `40 = footer`
  - `41 = footer_bottom`
  - `50 = drawer`
- `phis` CMS revision payload `layoutNodes[].widgetType`
  - namespaced layout type identity, for example `@phis/ui/layouts/content/layout`
- `phis` CMS revision payload `contentWidgets[].widgetType`
  - namespaced widget type identity, for example `@phis/ui/widgets/simple-text`
- `phis` CMS revision payload `slotIndex`
  - canonical slot position inside a layout-owned `slots[]` contract
- `phis` CMS revision payload `contentWidgets[]` carries no content id and no version pin: a Widget's
  content is the `site_content` row whose `instance_id` is the Widget's id ([CONTENT.md](./CONTENT.md)).
  The bound field (`contentBinding.sourceField`) is removed from the stored config once the Widget has
  content.
- `phis` CMS write payload `contentWidgets[].contentVersionId`
  - the content version the writer read; a write's base, compared and never stored
- `phis.sites.flags INT`
  - `1 << 0 = active`
- `phis` CMS revision payload `flags` (`PhiCmsFlags` in `@phis/contracts/cms`; not every flag applies to every row kind)
  - `1 << 0 = site_custom`
  - `1 << 1 = hidden`
  - `1 << 2 = mobile_only`
  - `1 << 3 = desktop_only`
  - `1 << 4 = collapsed` (Regions)
  - `1 << 5 = no_translate`
  - `1 << 6 = no_index` (Pages)
- `phis` CMS revision payload `viewportFlags SMALLINT`
  - `0 = unrestricted`
  - `1 << 0 = compact`
  - `1 << 1 = medium`
  - `1 << 2 = wide`
  - canonical persisted values are `0..6`; `7` normalizes to `0`
- `phis` CMS revision payload `visibilityMask`, and the `area_id` / `target_area_id` columns
  (`PhiCmsVisibilityContext` in `@phis/contracts/cms`)
  - `1 << 0 = public_area`
  - `1 << 1 = app_area`
  - `1 << 3 = admin_area`
  - `1 << 4 = editor_area`
  - `1 << 6 = accounting_area`
  - `1 << 8 = builder_area`
  - bits `2`, `5`, and `7` are unassigned
- `phis` CMS revision flags
  - `1 << 0 = draft`
  - `1 << 1 = published`
  - `1 << 2 = deleted` for page revisions whose payload marks the page as deleted
- `phis.site_nav_scopes.flags INT`
  - no bit is assigned
- `phis.user_accounts.flags INT` (`PhiUserAccountFlag`)
  - `1 << 0 = disabled`
  - `1 << 1 = must change password`
  - `1 << 2 = Theme light`, `1 << 3 = Theme dark`; neither = follow the browser
- `phis.user_emails.flags INT` (`PhiUserEmailFlag` in `@phis/contracts/access`)
  - `1 << 0 = primary`; the partial unique index `user_emails_primary_user_idx` is defined on this bit
- `phis.user_emails.source SMALLINT` (`PhiUserEmailSource` in `@phis/contracts/access`)
  - `1 = operator`, `2 = admin`, `3 = registration`, `4 = self`, `5 = directory`, `9 = provider`
  - `20 = Google`, `21 = Apple`, `22 = Microsoft`, `23 = GitHub`
- `phis.user_site_role_claims.role_flags INT`
  - Core role matrix (`PhiBaseRole`) governed by `AUTHORIZATION.md`
- `phis.user_site_memberships.user_site_flags INT`
  - `1 << 0 = disabled`
  - `1 << 1 = newsletter opt-in`
- `phis.user_sessions.auth_state SMALLINT` (`PHI_AUTH_SESSION_STATES`)
  - `1 = factor enrollment required`
  - `2 = factor challenge required`
  - `3 = complete`
- `phis.site_media_config.flags INT` (`PhiSiteMediaFlags`)
  - `1 << 0 = User Spaces available`
  - `1 << 1 = Group Spaces available`
- `phis.media_spaces.kind SMALLINT`
  - `1 = site`, `2 = user`, `3 = group`, `4 = addon`
- `phis.media_upload_sessions.purpose SMALLINT` (`PhiMediaUploadPurpose`)
  - `1 = Media Asset`
  - `2 = Add-on Asset`
- `phis.server_addons.flags INT`
  - `1 << 0 = globally enabled`
- `phis.site_server_addons.flags INT`
  - `1 << 0 = enable requested for the Site`
- `phis.server_instances.flags INT`
  - `1 << 0 = ready`

### `phis.sites`

- `id SMALLSERIAL PRIMARY KEY`
- `key VARCHAR(64) NOT NULL UNIQUE`
- `name VARCHAR(128) NOT NULL`
- `hostname VARCHAR(255) NOT NULL UNIQUE`
- `default_locale VARCHAR(8) NOT NULL DEFAULT 'en'`
- `available_locales VARCHAR(8)[] NOT NULL DEFAULT ARRAY['en']::VARCHAR(8)[]`
- `flags INT NOT NULL DEFAULT 0`
- `theme JSONB NOT NULL DEFAULT '{}'::jsonb`
- `public_base_url VARCHAR(512) NOT NULL`
- `mail_from VARCHAR(320) NOT NULL`
- `mail_from_name VARCHAR(160) NOT NULL`
- `support_email VARCHAR(320) NOT NULL`
- `contact_recipient VARCHAR(320) NOT NULL`
- `medusa_base_url VARCHAR(512) NULL`
- `medusa_publishable_key VARCHAR(320) NULL`
- `customer_number_prefix VARCHAR(32) NULL`
- `form_guard_secret CHAR(64) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `sites` stores the Site-wide runtime and business configuration: canonical hostname, locales, public URL, mail identity, commerce handoff values, and the form guard secret.
- The immutable Site source locale is not a column. It is `sites.overrides.<siteKey>.sourceLocale` in the runtime configuration, with `translation.sourceLocale` as the installation fallback; see [TRANSLATIONS.md](./TRANSLATIONS.md).
- `theme` stores public-facing presentation configuration only. Its shape is the `theme` member of `PhiBlockRuntimeSite` in `phis-ui/types/widget-runtime.ts`: `mode`, `blocks`, `derivedFrom`, `preset`, `presetVersion`, `shape`, `fonts`, `rem`, `brand`, `contact`, `shell`, `root`, `palette`, `style.token`, `buttons`, `typography`, and `components`.
- `theme` must not become a raw dump of arbitrary `ConfigProvider` state; it is a Site-owned theme contract that the frontends map into Ant Design.
- `theme` must not hold widget-instance configuration. Widget config belongs to the CMS revision trees.

### Media Spaces, Folders, and Storage

The behavior of general Site groups, Media Spaces, folders, quotas, Storage Profiles, Assets, variants,
uploads, and delivery is defined in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). The sections below
describe the tables.

There is no global Storage switch, no per-Asset provider, bucket, or public URL column, and no
`flags`-based Asset visibility.

- `sites.theme.brand.logo.light` and `.dark` are the brand logos. A logo with `sourceKind: "asset"` references the Asset by `assetId`; its `url` is a delivery projection and never the source of truth. `sourceKind: "url"` carries an external `sourceUrl`.
- The binary payload lives in the object store selected by the Asset's concrete Storage Profile; the database stores metadata, ownership, quota accounting, and storage keys only.
- Ownership, lifecycle, delivery, and presentation are four separate closed contracts. No single `flags` column expresses access any more.

### `phis.media_storage_profiles`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `key VARCHAR(160) NOT NULL`
- `provider_id VARCHAR(255) NOT NULL`
- `config JSONB NOT NULL DEFAULT '{}'::jsonb`
- `secret_reference VARCHAR(512) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `probe JSONB NULL`
- `probed_at TIMESTAMPTZ NULL`
- `checksum_algorithm VARCHAR(16) NULL`
- `UNIQUE (site_id, key)` and `UNIQUE (id, site_id)`
- CHECK: `provider_id` is a namespaced id; `config` is a JSON object

Contract:
- One profile is one concrete, operator-configured Storage target for one Site.
- `provider_id` is a namespaced service-provider id such as `@phis/server/storage-local` and is validated against the manifest-declared provider registry; an unavailable provider fails closed.
- `secret_reference` names a secret in the server secret store (`phis.server_secrets`), for example `site:acme:addon:@phis/storage-s3:secret-access-key`. Credentials never live in this row, in Site administration, or in any browser payload.
- `flags` has no assigned bit.
- `probe` is what `phis storage probe` (or the first upload that needs it) found the endpoint can do, as `PhisMediaStorageProbe` from `@phis/contracts`: whether it is writable, which digests it verifies against the bytes it stores, and whether a digest survives a multipart object. It is an observation, not configuration, and every probe replaces the previous one. `probed_at` is `NULL` when nothing was recorded; a Local Profile is answered without a recorded probe.
- `checksum_algorithm` is the digest this Profile records, chosen once from the probe. Every Asset, variant, and font cut stored through the Profile records its digest under this algorithm, so digests within one Profile stay comparable.
- Every Asset and every generated variant binds to a concrete profile. There is no global Storage switch and no persisted canonical public URL.

### `phis.media_spaces`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `kind SMALLINT NOT NULL`
- `user_id INT NULL` (composite FK to `user_site_memberships`, `ON DELETE CASCADE`)
- `group_id INT NULL` (composite FK to `site_groups`, deferred, no cascade)
- `addon_id VARCHAR(255) NULL` (FK to `server_addons`, `ON DELETE CASCADE`)
- `default_storage_profile_id INT NOT NULL` (composite FK to `media_storage_profiles`, deferred)
- `quota_bytes BIGINT NULL`
- `used_bytes BIGINT NOT NULL DEFAULT 0`
- `reserved_bytes BIGINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (id, site_id)`

Contract:
- `kind` is the closed owner contract: `1 = site`, `2 = user`, `3 = group`, `4 = addon`. A CHECK constraint enforces that exactly the matching owner column (`user_id`, `group_id`, `addon_id`, or none for the Site Space) is set.
- A Site has at most one Site Space, one Space per member, one Space per group, and one Space per Add-on; partial unique indexes enforce that.
- The Site Space owns Site presentation, CMS content, theme, and published download Assets. CMS, Builder, Editor, and `phis:asset` resolution are pinned to it.
- An Add-on Space holds the files of one Add-on on one Site, so its quota is the Add-on's quota. It is removed with the Add-on's `server_addons` row.
- A group Space is not removed with its group: the deferred foreign key fails, at commit, a transaction that deletes a group whose Space still exists, while a whole-Site delete still succeeds.
- `quota_bytes` is an explicit Space-level override. `NULL` inherits the Site default for the Space kind from `site_media_config` (User, Group, or Add-on); a `NULL` Site default means no limit. The Site Space has no Site default. `used_bytes` is committed usage and `reserved_bytes` is in-flight upload reservation; both are non-negative.
- Composite foreign keys on `(user_id, site_id)` and `(group_id, site_id)` make a cross-Site owner unrepresentable rather than merely rejected in code.

### `phis.media_folders`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `space_id INT NOT NULL` (composite FK to `media_spaces`)
- `parent_id INT NULL REFERENCES phis.media_folders(id) ON DELETE CASCADE`
- `name VARCHAR(160) NOT NULL`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (id, space_id)`

Contract:
- A Folder is a presentation-level bucket inside exactly one Space. It never crosses Spaces and never carries authorization.
- Folder names are unique per Space and per parent, case-insensitively.
- `flags` follows `PhiMediaFolderFlags` (`collapsed`, `hidden`, `locked`) and is display state only.
- The server vocabulary is Folder. `groupId` and `groupPath` are retired and must not reappear as aliases.

### `phis.site_media_config`

- `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`
- `default_user_quota_bytes BIGINT NULL`
- `default_group_quota_bytes BIGINT NULL`
- `max_user_quota_bytes BIGINT NULL`
- `max_group_quota_bytes BIGINT NULL`
- `default_addon_quota_bytes BIGINT NULL`
- `max_addon_quota_bytes BIGINT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `max_object_bytes BIGINT NOT NULL DEFAULT 134217728`
- `user_space_content_kinds VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[]`
- `group_space_content_kinds VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[]`
- `allowed_storage_profile_ids INT[] NOT NULL DEFAULT ARRAY[]::INT[]`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- CHECK: every quota column is `NULL` or non-negative; `max_object_bytes > 0`

Contract:
- Site-level media policy applied when a Space is resolved and when an upload is initialized.
- `flags` carries Space availability per `PhiSiteMediaFlags`: `1 << 0` User Spaces, `1 << 1` Group Spaces. Availability is a capability and is separate from quota, so an unavailable Space kind is rejected as `space_kind_unavailable` rather than as an exhausted quota. The default `0` makes default-deny structural. The Site Space and Add-on Spaces are never governed by these flags.
- `flags`, `user_space_content_kinds`, and `group_space_content_kinds` are materialized, not administered. `materializeSiteMediaAvailabilityWithDb` (`src/db/media-spaces.ts`) recomputes them when an Area is published, from `tree_json #> '{preset,config,modules,mediaSpaces}'` of every published Area revision of the Site. A `user` or `group` entry in that object makes the kind available; its `kinds` array contributes content kinds. The result is the union across Areas, deduplicated and sorted. Neither the administration route nor the installation configuration writes these columns. See [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) section 7.
- `user_space_content_kinds` and `group_space_content_kinds` list the `PhiMediaKind` values a User or Group Space accepts; upload init refuses any other kind with `415 content_type_not_allowed`. An empty list accepts nothing. The Site Space and Add-on Spaces are not restricted by these columns.
- `default_user_quota_bytes`, `default_group_quota_bytes`, and `default_addon_quota_bytes` are inherited live by every Space of that kind whose own `quota_bytes` is `NULL`, so changing a default moves all non-overridden Spaces. A Space-level `0` is an explicit revocation, and lowering a limit below current usage blocks new reservations without deleting or hiding an Asset.
- `max_user_quota_bytes`, `max_group_quota_bytes`, and `max_addon_quota_bytes` are the ceilings a Space-level override may not exceed; `NULL` is no ceiling.
- `max_object_bytes` is the largest single object a Site accepts, in Media and in an Add-on's `storage:v1` store alike. The default is 128 MiB: what a conversation carries -- a log, a recording of a fault, an archive of both -- rather than what a transport imposes, since the proxied path carries 2 GB and a single S3 PUT 5 GB. It is not a per-path limit and does not know which Storage Profile will serve the object; `uploads/init` checks it before it resolves the Space. Nothing reads it from configuration, so it is the one column here a Site starts with rather than inherits.
- The row is materialized once, seeding `default_user_quota_bytes` and `default_group_quota_bytes` from `media.defaults.userQuotaBytes` and `media.defaults.groupQuotaBytes` in `config/phis-config.json`. After that the row is authoritative and there is no request-time fallback to configuration, so raising an installation default never widens an existing Site.
- `allowed_storage_profile_ids` is not evaluated by any read path.

### `phis.media_assets`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `space_id INT NOT NULL` (composite FK to `media_spaces`)
- `folder_id INT NULL` (composite FK to `media_folders`, `ON DELETE SET NULL (folder_id)`)
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `owner_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL` — authority, not history:
  who may act on the Asset now, seeded from the creator and moved by a handover. `created_by_user_id`
  never moves. See [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md), "Owner is not author".
- `storage_profile_id INT NOT NULL` (composite FK to `media_storage_profiles`)
- `storage_key VARCHAR(512) NOT NULL`
- `original_name VARCHAR(255) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `variant_version SMALLINT NULL`
- `bytes BIGINT NULL`
- `checksum_algorithm VARCHAR(16) NULL`, `checksum_value VARCHAR(128) NULL`, both set or both null
- `width SMALLINT NULL`
- `height SMALLINT NULL`
- `blur_data_url TEXT NULL`
- `meta JSONB NULL`
- `title VARCHAR(255) NULL`
- `alt_text VARCHAR(255) NULL`
- `lifecycle_status SMALLINT NOT NULL DEFAULT 1`
- `delivery_policy SMALLINT NOT NULL DEFAULT 1`
- `delivery_revision INT NOT NULL DEFAULT 1`
- `presentation_flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (id, site_id)` and `UNIQUE (storage_profile_id, storage_key)`

Contract:
- `site_id` plus `space_id` is the hard ownership boundary. Composite foreign keys pin the Space and the Folder to the same Site and Space, so a cross-Site or cross-Space Asset is unrepresentable.
- `storage_key` is the object key inside the bound Storage Profile. It is unique per profile, never globally, and is never a delivery address: browser delivery resolves by Asset id and variant key.
- No canonical public URL is persisted. The server returns a delivery projection per request.
- `lifecycle_status` is closed: `1 = pending`, `2 = ready`, `3 = archived`, `4 = quarantined`, `5 = failed`. Only `ready` is deliverable.
- `delivery_policy` is closed: `1 = public`, `2 = authenticated`, `3 = user`, `4 = group`, `5 = internal`. It is evaluated before any physical lookup:
  - `public` is unauthenticated and immutably cacheable
  - `authenticated` requires any valid Site session
  - `user` requires the requesting session to own the User Space
  - `group` requires effective membership in the owning group of a Group Space
  - `internal` requires the internal API token and is never browser-reachable
- `delivery_revision` invalidates previously granted delivery. A request carrying the current revision receives an immutable cache header; any other revision receives `max-age=0, must-revalidate`. Non-public policies are always `private, no-store`.
- `presentation_flags` carries non-security display properties only, per `PhiMediaAssetFlags`: `1 << 0` background, `1 << 3` featured, `1 << 4` locked, `1 << 5` mask. It never influences delivery or authorization. Bits `1` and `2` are free; they carried `archived` and `restricted` before lifecycle and delivery became columns of their own.
- A flag names what an Asset is offered for, never where it came from. Provenance lives in `meta.source` (`preset` for an Asset a Preset installed, `iconify` for a mask fetched from the icon catalogue, absent for an ordinary upload), because the list filter is an OR over the bit field (`presentation_flags & mask <> 0`) and could not ask for a purpose and an origin at once.
- Image variants inherit the lifecycle and delivery policy of their original; `variant_key` selects the rendition shape and `variant_version` is only the technical cache-buster.
- `next/image` optimization is the canonical path for `public` Assets only; every other delivery policy is treated as `unoptimized` in the browser-facing contract. A `public` SVG original is `unoptimized` as well (`isPhiMediaAssetOriginalOptimizable`): the optimizer refuses `image/svg+xml`, and delivery URLs carry no `.svg` suffix by which `next/image` would notice on its own. Generated variants are raster and stay optimizable.
- `blur_data_url` is an optional preview placeholder that can be generated for image assets and reused by remote `next/image` renderers.
- `meta` is a generic JSONB extension point for asset-specific metadata. v1 starts with image focus data under `meta.image.focus.x` and `meta.image.focus.y`, both normalized to the `0..1` range. Later image regions and other asset-type metadata may reuse the same field under their own namespaced keys.
- `meta.font` carries what a typeface states about its own proportions, read once at upload by `lib/font-metrics.ts`: `unitsPerEm`, `ascent`, `descent`, `lineGap`, `capHeight`, `xHeight`, `xWidthAvg` with its `xWidthAvgSource`, the container `format`, the `familyName`, and a `category` of `serif`, `sans-serif`, `monospace` or `null`. It exists so a Theme can write a fallback `@font-face` with `size-adjust` and the `*-override` descriptors, which is what keeps the substitute from reflowing the page when the real file lands -- a render must never open a font file to find them. `coverage` lists which `unicode-range` cuts the file can yield: `subsets`, the `PhiFontSubsetKey` values of the named ranges the font maps at least one codepoint in, and `restRanges`, the font's own codepoints outside every named range as at most 256 `[start, end]` pairs, which is what the `rest` cut (`15`) contains. It is `null` for fonts read before the reader knew it; those are delivered whole. `xWidthAvg` is the frequency-weighted advance of the characters running text is made of, which is a tenth narrower than a flat mean over the same glyphs and the difference between a substitute that fits and one that does not. `category` is `null` where the file classifies itself in neither PANOSE nor the `OS/2` family class, which is common; the substitute is then the Theme's decision rather than a guess recorded as fact.
- `content_type` is still stored as the exact MIME type, but the stable v1 media-kind filter contract should use these UX classes:
  - `image` for `image/*`
  - `video` for `video/*`
  - `audio` for `audio/*`
  - `pdf` for `application/pdf`
  - `markdown` for `text/markdown`
  - `document` for Office/text-document MIME families such as `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/rtf`, `text/plain`, and `application/vnd.oasis.opendocument.text`
  - `archive` for archive MIME families such as `application/zip`, `application/x-7z-compressed`, `application/x-rar-compressed`, and `application/x-tar`
  - `font` for the registered `font/*` tree and the older `application/...` spellings of the same bytes (`application/font-woff`, `application/x-font-ttf`, `application/vnd.ms-fontobject`). A typeface is neither read nor downloaded but loaded by a stylesheet, and a Theme that owns its lettering must be able to find it again after the Module that brought it is gone -- which is a query on the kind, not a guess about content types. `media-content-sniffer.ts` recognizes `wOF2`, `wOFF`, `OTTO`, `ttcf` and the TrueType magic, so an uploaded font is stored as a font rather than falling through to `application/octet-stream`
  - `binary` for arbitrary bytes offered as a download
  - `other` for anything that does not fit the above classes
- List consumers must not read the media library unbounded. The public `GET /api/site/media` contract is paginated and requires `page` plus `pageSize`; detail reads belong on `GET /api/site/media/:id`.
- `pageSize` is capped at `100`.
- The list contract may additionally filter by `id`, `since`, `until`, `folderId`, `kind` (repeatable), `presentationFlags`, and `q`, and accepts `sort`.
- `sort` accepts only `created_at_desc`.
- The canonical "last 100 images" use-case is `page=1&pageSize=100` with `sort=created_at_desc`.
- `since` and `until` filter by `created_at` in the Space-scoped media library.
- The list query stays index-backed by `(space_id, folder_id, created_at DESC, id DESC)`; the accessible Space is resolved once per request, never once per Asset.
- `checksum_algorithm` names the digest in `checksum_value` (`PHIS_MEDIA_CHECKSUM_ALGORITHMS` in `@phis/contracts`: `sha256`, `sha512`, `sha256-composite`, `xxhash128`, `crc64nvme`, `crc32c`, `crc32`, `md5`). A value is never stored without the algorithm that produced it. The same pair, with the same CHECK, exists on `media_upload_sessions`, `image_asset_variants`, and `font_asset_subsets`.
- Duplicate detection uses the partial index `(space_id, checksum_algorithm, checksum_value)` `WHERE checksum_value IS NOT NULL AND checksum_algorithm IN ('sha256', 'sha512', 'sha256-composite')`. It is scoped to one Space and compares only identity-strength digests; weaker digests still verify transfer integrity but are never compared.
- An Asset stored before Core asked the Client for a digest carries an `md5` off its ETag, or nothing, and is outside duplicate detection until an operator runs `POST /api/v1/media/checksums/recompute`, which reads the object back and records the form a Provider would report for it.
- `sha256-composite` is what an object assembled from parts carries: SHA-256 over the concatenated part digests, recorded as `<digest>-<partCount>-<partSizeBytes>`. The division is in the value because two composites mean the same thing only under the same division, and the rule that produces it (`resolvePhiMediaUploadPartSizeBytes` in `@phis/contracts`) is frozen once objects exist under it. It is identity-grade: a whole-object SHA-256 cannot be had for such an object at all, since the S3 API accepts `ChecksumType: FULL_OBJECT` for the CRC algorithms alone.
- `(space_id, owner_user_id) WHERE owner_user_id IS NOT NULL` is indexed for owner-scoped listings.
- The list response should expose `pagination.total` so previewers and pagers can render accurate counts without loading the whole library.
- Deleting a media asset must remove its owned `site_content(type=asset)` wrapper rows, but must be rejected while any widget/layout/page/area/navigation tree or the Site Theme still references that content or asset.
- The delete guard reads the maintained `site_cms_references` index rather than scanning revision JSON. It therefore protects exactly what that index records, which is why the reference forms in [REFERENCES.md](./REFERENCES.md) are normative rather than conventional.

### `phis.media_upload_sessions`

- `token VARCHAR(128) PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `actor_user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `space_id INT NOT NULL` (composite FK to `media_spaces`)
- `folder_id INT NULL` (composite FK to `media_folders`, `ON DELETE SET NULL (folder_id)`)
- `storage_profile_id INT NOT NULL` (composite FK to `media_storage_profiles`)
- `status SMALLINT NOT NULL`
- `filename VARCHAR(255) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `size_bytes BIGINT NOT NULL`
- `kind VARCHAR(16) NOT NULL`
- `checksum_algorithm VARCHAR(16) NULL`, `checksum_value VARCHAR(128) NULL`, both set or both null
- `meta JSONB NULL`
- `presentation_flags INT NOT NULL DEFAULT 0`
- `upload_plan_kind SMALLINT NOT NULL DEFAULT 1` (CHECK `IN (1, 2, 3)`)
- `purpose SMALLINT NOT NULL DEFAULT 1`
- `purpose_ref JSONB NULL`
- CHECK: `size_bytes > 0`; `(purpose = 1 AND purpose_ref IS NULL) OR (purpose = 2 AND purpose_ref IS NOT NULL)`
- `staging_storage_key VARCHAR(512) NOT NULL`
- `final_storage_key VARCHAR(512) NULL`
- `provider_upload_id VARCHAR(512) NULL`, CHECK `(upload_plan_kind = 3) = (provider_upload_id IS NOT NULL)`
- `expires_at TIMESTAMPTZ NOT NULL`
- `uploaded_at TIMESTAMPTZ NULL`
- `finalized_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- The upload session is a transient workflow row, not a durable history record.
- `token` is the public lookup key and primary key.
- Initialization binds Site, actor, Space, Folder, and concrete Storage Profile, and reserves `size_bytes` against the Space quota atomically. The browser never supplies Space ownership or a Storage target.
- The session carries only transport/policy data from the upload init step.
- `folder_id`, `presentation_flags`, and `meta` may optionally be supplied at init time as a starting context for the eventual asset row.
- Upload-session `meta` is transient transport metadata and is copied to `media_assets.meta` during finalize. It is intended for durable source descriptors such as imported icon metadata, not for secrets or large payloads.
- Title and alt text are added later on the actual asset via the inspector PATCH flow.
- `kind` reuses the existing `PhiMediaKind` contract from `@phis/server` and `phis-ui`.
- `staging_storage_key` points to the staging object inside the bound profile; `final_storage_key` is the target key after finalize.
- `checksum_algorithm` / `checksum_value` carry the digest recorded for the upload, as on `media_assets`.
- `purpose` decides what the finished object becomes: `1` a Media Asset, `2` an Asset on an Add-on row. `purpose_ref` is required for `2` and names the Add-on, table, owner row, and slot (`{ addonId, table, ownerId, slot }`).
- Finalize verifies the stored object before the Asset reaches `ready` and commits the quota reservation.
- Successful finalize deletes the session row and, where the plan staged onto a different key, the staging object with it. A failure the Client reports to `POST /api/site/media/uploads/:token/report` deletes the row, releases the reservation, and removes that session's staging object -- the Profile, the key and the authority are all in hand there. Expiry deletes the row and releases the reservation, and hands back where the remains are: `releaseExpiredMediaUploadSessions` runs on whichever request next wants that Space's capacity and returns each expired session's `storage_profile_id`, `staging_storage_key` and `provider_upload_id` -- the row being the only record of them. That request removes the ones on the Profile it already opened, after its response rather than before its plan, and leaves any naming another Profile alone: those objects are in another storage, and opening it would mean reading a second secret for an upload unrelated to it. For S3 that object belongs to a bucket lifecycle rule, which **now exists**: the storage contract's `applyLifecyclePolicy` is written beside the CORS rule whenever a Profile is written, and it carries both an expiry for the staging prefixes and an abort for multipart uploads nobody completed -- the latter being the only way such an upload ever stops being billed, since it appears in no object listing. For Local it still belongs to a deliberate operator command, which **does not exist yet** ([TODOS.md](./TODOS.md), "Media and storage"). A retry requests a fresh token in every case except one: an assembly whose Client reported `interrupted` keeps its row and its parts, and the next init for the same file answers with that same token (see the plan-kind entry below).
- `(space_id, status, expires_at)` and `(site_id, actor_user_id, created_at DESC)` are indexed. The resumable lookup is served by the first of those: it is a transient table, and a Space's interrupted sessions are few.
- The browser-facing contract is `POST /api/site/media/uploads/init`, `POST /api/site/media/uploads/:token/finalize`, and whatever the issued plan names for the body itself; no multipart parser is involved in the large-file path.
- `upload_plan_kind` records which plan init issued: `1 = proxy-stream` (the body streams through `PUT /api/site/media/uploads/:token`), `2 = presigned-put` (the Provider takes the body directly), `3 = multipart-put` (the Provider assembles the body from parts, and `provider_upload_id` is its name for that assembly). It is a property of the session rather than of the Storage Profile, because a Provider may answer differently for different bodies. It decides two things no later request can work out on its own: whether Core may receive this body at all, and whether "the body arrived" is a status Core set itself or something only the stored object can attest.
- `status` is `PhiMediaUploadSessionStatus`: `0 Pending`, `1 Uploading`, `2 Uploaded`, `3 Finalizing`, `4 Completed`, `5 Failed`, `6 Expired`, `7 Aborted`, `8 Interrupted`. The last one is not a flavour of `Aborted` but its opposite: an abort is the teardown -- row gone, reservation released, remains discarded -- while `8` is the one ending where what arrived is worth keeping. It is reached only from `upload_plan_kind = 3`, when the Client reports `interrupted` to the report route because the page carrying the body went away, and it is the only status an upload may be carried on from. A session still at `0` or `1` may have a page sending into it right now.
- **A body sent in parts may be carried on rather than started again, and `uploads/init` is where that happens.** A Client that reports `interrupted` leaves the row, its reservation and the parts already at the Provider in place. The next init for the same file finds that session through `findResumableMediaUploadSession` -- same Site, Space, actor, filename, `size_bytes` and recorded digest, status `8`, not expired -- asks the Provider through `resumeUploadPlan` which parts it actually holds, and answers with signed addresses for the ones still missing plus the entity tags of the ones already there. Identity is the `sha256-composite` digest and nothing weaker: joining parts to a body that is not the same file would assemble an object out of two files and record a digest as true of the result. The reservation is not taken twice and `expires_at` is not moved, so continuing an upload can never be a way to hold a Space's capacity open. Where the Provider no longer holds the assembly the session is aborted there and then -- it was holding a reservation for parts that do not exist -- and the fresh upload proceeds. A session naming another Storage Profile is left to a fresh upload for the reason expiry gives: reaching it would mean opening a storage, and reading its secret, for an upload unrelated to it.
- Duplicate detection and the size check happen at finalize, where every plan passes, rather than at the transport that happened to carry the body.

### `phis.image_asset_variants`

- `PRIMARY KEY (asset_id, variant_key)`
- `asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE CASCADE`
- `variant_key SMALLINT NOT NULL`
- `storage_profile_id INT NOT NULL REFERENCES phis.media_storage_profiles(id) DEFERRABLE INITIALLY DEFERRED`
- `storage_key VARCHAR(512) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `bytes BIGINT NULL`
- `checksum_algorithm VARCHAR(16) NULL`, `checksum_value VARCHAR(128) NULL`, both set or both null
- `width SMALLINT NOT NULL`
- `height SMALLINT NOT NULL`
- `blur_data_url TEXT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (storage_profile_id, storage_key)`

Contract:
- `image_asset_variants` stores image-only renditions for the canonical original row in `media_assets`.
- The original image row remains the source of truth for asset identity, ownership, and original metadata.
- `variant_key` is a compact semantic UI contract and follows the same enum-style approach as other smallint contracts in `phis`.
- The initial v1 variant keys are:
  - `0 = thumbnail`
  - `1 = preview`
  - `2 = card`
  - `3 = hero`
  - `4 = avatar`
  - `5 = logo`
- Shared helper code should resolve these numeric keys to readable names such as `thumbnail`, `preview`, `card`, `hero`, `avatar`, and `logo`.
- Next.js `Image` does not define or require specific variant keys; these keys are our own CMS/rendering contract.
- `width` and `height` on `media_assets` describe the original image dimensions.
- `width` and `height` on `image_asset_variants` describe the concrete rendition dimensions.
- `blur_data_url` is optional and may be generated for the original asset, for renditions, or both.
- A variant binds to its own concrete Storage Profile and object key. Renderers resolve it through the Asset-id/variant delivery route and still provide `width`, `height`, and optional `blurDataURL` to `next/image` when rendering remote images.
- The rendition table exists for images only; videos, PDFs, and other media types should not be squeezed into the same size-variant contract.
- `GET /api/site/media/[id]/variants/[variantKey]` answers `404` when no variant row exists after `ensureImageAssetVariant`, which is the case for every non-image Asset; such requests create no `phis.image_asset_variants` rows.

### `phis.font_asset_subsets`

- `PRIMARY KEY (asset_id, subset_key)`
- `asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE CASCADE`
- `subset_key SMALLINT NOT NULL`
- `subset_version SMALLINT NOT NULL`
- `storage_profile_id INT NOT NULL REFERENCES phis.media_storage_profiles(id) DEFERRABLE INITIALLY DEFERRED`
- `storage_key VARCHAR(512) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `bytes BIGINT NULL`
- `checksum_algorithm VARCHAR(16) NULL`, `checksum_value VARCHAR(128) NULL`, both set or both null
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (storage_profile_id, storage_key)`

Contract:
- `font_asset_subsets` stores `unicode-range` cuts of a `font` Asset, one woff2 file per range; the original row and object in `media_assets` stay untouched and are what every cut is derived from.
- `subset_key` is `PhiFontSubsetKey` from `@phis/contracts/media`: `0 = latin`, `1 = latin-ext`, `2 = cyrillic`, `3 = cyrillic-ext`, `4 = greek`, `5 = greek-ext`, `6 = vietnamese`, `7 = math`, `8 = symbols`, `15 = rest`. The ranges behind each key live beside the vocabulary (`PHI_FONT_SUBSET_RANGES`, following Google's font CSS), not in the row; For `rest`, the `unicode-range` text a Theme writes comes from the Asset's `meta.font.coverage.restRanges`.
- Cuts are produced on first request to `/api/site/media/[id]/subsets/[key]` by `ensureFontAssetSubset` and stored beside the original under `<storage_key>.__subsets/<key>.woff2`. The cutter reads the codepoints from the original file itself, not from `meta`; a key the font maps no codepoint in answers 404 and creates no row.
- `subset_version` is compared against `PHI_FONT_SUBSET_VERSION`; a row with an older version is recut on its next request, so changing the ranges or the cutter means bumping that constant.
- It is not a row in `image_asset_variants`: that table is images-only, and a shared key column would make one number mean a thumbnail or a script depending on another table.
- Discarding an Asset removes its cuts' storage objects together with its variants.

### `phis.user_site_avatars`

- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `asset_id INT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (user_id, site_id)`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`
- `FOREIGN KEY (asset_id, site_id) REFERENCES phis.media_assets(id, site_id) ON DELETE CASCADE`
- index on `asset_id`

Contract:
- One avatar per user per Site. It is Site-scoped because the Asset lives in that Site's User Space; both composite keys carry the Site, so a cross-Site avatar is unrepresentable.
- An avatar is a personal setting, not a published reference: it has no `site_cms_references` row, and deleting the Asset removes the binding instead of being blocked.

### `phis.media_discarded_objects`

- `id BIGSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `storage_profile_id INT NOT NULL`
- `storage_key VARCHAR(512) NOT NULL`
- `discarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (storage_profile_id, storage_key)`
- index on `(site_id, discarded_at, id)`

Contract:
- A retry list for storage objects whose rows are already gone. An object store cannot join a transaction, so the transaction that removes Asset rows (and their variants), or an Add-on's Media Spaces, writes each object's key here; the object removal that follows deletes the note.
- A note that survives is retried: later deletes drain the oldest notes of the Site in bounded batches (`drainPhiDiscardedMediaObjects` in `src/lib/media-asset-delete.ts`).
- Discarding the same object twice is one note.

### `phis.user_accounts`

- `id SERIAL PRIMARY KEY`
- `preferred_locale VARCHAR(8) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `id` is the one global Phi user id and remains the same across Sites.
- `preferred_locale` stores the user's preferred UI locale when explicitly captured from registration or later settings updates.
- `flags` stores global non-role state: `1 << 0` disabled, `1 << 1` must change password, `1 << 2` Theme
  light, `1 << 3` Theme dark. Neither Theme bit means the account chose no half and the browser's
  `prefers-color-scheme` speaks for it, so a new account is already right at `flags = 0`; both set is a
  contradiction nothing writes and is read as neither.
- `user_accounts` contains no email, password, provider, commerce-account, or Site-membership shortcut.
- Global account existence resolves here; durable login identities and Site admission resolve through the
  normalized relations in [AUTHENTICATION.md](./AUTHENTICATION.md).
- The view `phis.user_account_directory` projects each account's primary address (or, without one, its
  most recently verified address) as `email_normalized`.

### `phis.user_emails`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `email_normalized VARCHAR(320) NOT NULL UNIQUE`
- `verified_at TIMESTAMPTZ NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `source SMALLINT NOT NULL` (CHECK `IN (1, 2, 3, 4, 5, 9, 20, 21, 22, 23)`)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- An accepted durable email belongs to exactly one global user; registration-intent email snapshots are
  not durable account-email rows.
- `flags & 1` marks the primary address. The partial unique index `user_emails_primary_user_idx` on
  `(user_id) WHERE (flags & 1) <> 0` enforces at most one primary row per user, so the bit position is
  fixed.
- `source` records where the address came from (`PhiUserEmailSource`): values below `20` are Core
  origins (`1` operator, `2` admin, `3` registration, `4` self, `5` directory, `9` an unnamed provider);
  `20` and above are named providers (`20` Google, `21` Apple, `22` Microsoft, `23` GitHub). There is no
  unknown value.
- Email is a verified contact/discovery attribute, not an external identity key or unconditional linking
  proof.

### `phis.user_password_credentials`

- `user_id INT PRIMARY KEY REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `password_hash TEXT NOT NULL`
- `changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Password hashing, verification, rehashing, reset, and revocation policy are Core-owned.
- Site policy determines whether the global credential may be used on that Site.

### `phis.user_auth_identities`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `issuer VARCHAR(512) NOT NULL`
- `subject VARCHAR(512) NOT NULL`
- `provider_key VARCHAR(64) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_used_at TIMESTAMPTZ NULL`
- `UNIQUE (issuer, subject)`

Contract:
- `(issuer, subject)` is the sole durable external-login identity. Email, provider username, client id,
  access token, and display name never replace it.
- One global user may own several external identities; one external identity belongs to one user.
- A Site/provider installation is validated before this global identity mapping is resolved.

### `phis.user_site_memberships`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `user_site_flags INT NOT NULL DEFAULT 0`
- `authorization_revision INT NOT NULL DEFAULT 0`
- `last_login_at TIMESTAMPTZ NULL`
- `module_state JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (user_id, site_id)`

Contract:
- `user_site_flags` stores site-local state such as enabled/disabled access and newsletter consent.
- `last_login_at` stores the last successful login for this user on this site.
- `authorization_revision` increments whenever the user's Core role claim or effective group membership
  on the Site changes, and participates in authorization-sensitive cache identity.
- `user_site_memberships` is the Site membership and Site-state source. Core role authority is stored in
  `user_site_role_claims`, Add-on roles in `site_addon_user_roles`, and group membership in
  `site_group_members`. `user_accounts` carries no role authority.
- `module_state` holds what a person decided, under keys a Module owns: an object whose keys are
  `<package>/<key>` and whose values follow the shapes in `@phis/contracts/user-state` (`flag`, `marker`,
  `value`, `set`). It is deliberately not `meta`: Core writes its own columns, a Module writes only
  through the validating route, and separate names keep a stray write across that line out of the
  question. A key that was never written is absent rather than defaulted, and what absence means belongs
  to the Module that declared the key. Core's own account facts stay bit flags in `user_site_flags` and
  `user_accounts.flags`; this exists because bits cannot be allocated to an unknown number of Modules.
  Every write names one key and sets that path alone, so two Modules writing at the same moment do not
  overwrite each other. The column is not read while a session resolves -- `user_sessions` selects only
  `user_site_flags` from this row, and a value paid for on every request would be the wrong trade for
  something a minority of renders needs.
- If no `user_site_memberships` row exists for `user_id + site_id`, the viewer cannot receive a Site
  session or authenticated Site role authority.
- This relation is the only Site-admission source; `user_accounts` carries no parallel Site list.
- The Core roles, their meaning, and Area access are defined in [AUTHORIZATION.md](./AUTHORIZATION.md).

### `phis.user_site_role_claims`

- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `provider_id VARCHAR(255) NOT NULL` (CHECK: namespaced id)
- `role_flags INT NOT NULL` (CHECK `role_flags > 0`)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (user_id, site_id, provider_id)`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`

Contract:
- The row with `provider_id = '@phis/server/core'` stores the assigned Core role matrix (`PhiBaseRole`).
  Core writes only that provider.
- A row for another provider counts only while that provider is available in the Site capability
  snapshot (`resolveEffectivePhiViewerRoleClaims`).
- Zero assignments are represented by deleting the provider row.
- Add-on roles are not bit flags and are not stored here; see `phis.site_addon_user_roles`.

### `phis.site_auth_config`

- `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`
- `config_version SMALLINT NOT NULL DEFAULT 1` (CHECK `= 1`)
- `policy_revision INT NOT NULL DEFAULT 1` (CHECK `> 0`)
- `config JSONB NOT NULL` (default: password sign-in only, automatic registration, `verified-email-confirm` linking)
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- One row is the only Site-level Auth configuration source of truth.
- Every configuration write increments `policy_revision`. A session established under an older revision is
  re-evaluated against the current policy on its next read (see `user_sessions.auth_policy_revision`).
- The closed version-1 document contains `policy`, `methods`, and `providers`.
- Policy contains registration, linking, password, passkey, factor, recovery, session, and callback-origin
  settings.
- Methods contain the enabled method/stage combinations, order, installation key, and public
  presentation metadata.
- Providers contain installation key, provider key, issuer, client id, opaque secret reference,
  non-secret adapter configuration, and enabled state.
- Provider secret values never enter the JSON. The deployment secret store is authoritative.
- Core parses and validates the complete document on every read and writes it atomically under a row lock.
- Site Auth settings may mutate only the current Site row through authorized Core operations.

### `phis.user_site_external_accounts`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `provider_key VARCHAR(64) NOT NULL`
- `external_account_id VARCHAR(512) NOT NULL`
- `customer_number VARCHAR(64) NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`
- `UNIQUE (site_id, provider_key, external_account_id)`
- `UNIQUE (user_id, site_id, provider_key)`

Contract:
- Medusa customer ids and equivalent domain-system ids are Site-scoped mappings, never global user
  identity fields.
- An explicit customer number is Site-scoped here. Otherwise it is derived from the Site prefix and
  global user id.
- An external domain account is not an authentication identity unless a separate validated Auth adapter
  resolves it through `user_auth_identities`.

### `phis.user_auth_factors`

- `id UUID PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `factor_type SMALLINT NOT NULL` (CHECK `IN (1, 2, 3)`)
- `factor_key BYTEA NULL`
- `factor_data JSONB NOT NULL DEFAULT '{}'::jsonb`
- `secret_ciphertext TEXT NULL`
- `secret_iv CHAR(24) NULL`
- `secret_auth_tag CHAR(32) NULL`
- `label VARCHAR(128) NULL`
- `confirmed_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_used_at TIMESTAMPTZ NULL`
- `consumed_at TIMESTAMPTZ NULL`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`
- `UNIQUE (user_id, site_id, factor_type, factor_key)`; partial unique index on `factor_key` where `factor_type = 1`

Contract:
- Factor types are closed and numeric: `1 = passkey`, `2 = TOTP`, `3 = recovery code`.
- A CHECK enforces the storage shape per type: TOTP rows carry the encrypted secret triple, no
  `factor_key`, and are never consumed; passkey and recovery-code rows carry `factor_key` and no secret.
- `factor_key` is raw binary WebAuthn credential-id material for passkeys and the raw hash for recovery
  codes; it is not a UUID or a repeated textual method label. A passkey credential id is unique across
  all users.
- Passkeys store only public WebAuthn credential material and RP/origin scope; private keys remain on the
  authenticator.
- TOTP seeds are encrypted, recovery codes are hashed, and successful enrollment requires a confirmed
  challenge (`confirmed_at`). A used recovery code sets `consumed_at`.

### `phis.auth_transactions`

- `id UUID PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `provider_installation_key VARCHAR(64) NULL`
- `user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `method_key VARCHAR(64) NOT NULL`
- `stage VARCHAR(32) NOT NULL` (CHECK `IN ('primary', 'second-factor', 'step-up', 'recovery')`)
- `state_hash CHAR(64) NOT NULL UNIQUE`
- `nonce_hash CHAR(64) NULL`
- `payload_ciphertext TEXT NOT NULL`
- `payload_iv CHAR(24) NOT NULL`
- `payload_auth_tag CHAR(32) NOT NULL`
- `next_path VARCHAR(1024) NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `consumed_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- index on `expires_at`

Contract:
- An Auth transaction is opaque, expiring, and one-use. It binds the trusted Site, provider installation
  or method, stage, the user when known, OAuth/OIDC correlation data, and a safe relative return
  destination (`next_path`).
- Only hashes of the state and nonce are stored; the rest of the transaction payload is encrypted.
- Consumption is one conditional `UPDATE` on `(site_id, state_hash)` that requires `consumed_at IS NULL`
  and an unexpired row, so a replayed state finds nothing.
- Expired rows, and rows consumed more than a day ago, are deleted by `deleteExpiredAuthTransactions`.

### `phis.user_sessions`

- `id UUID PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `session_secret_hash CHAR(64) NOT NULL`
- `authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `assurance_level SMALLINT NOT NULL DEFAULT 1` (CHECK `>= 0`)
- `auth_state SMALLINT NOT NULL DEFAULT 3` (CHECK `IN (1, 2, 3)`)
- `auth_policy_revision INT NOT NULL DEFAULT 1` (CHECK `>= 0`)
- `auth_method_keys VARCHAR(64)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(64)[]`
- `next_path VARCHAR(1024) NOT NULL DEFAULT '/'`
- `expires_at TIMESTAMPTZ NOT NULL`
- `last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `revoked_at TIMESTAMPTZ NULL`
- `ip_address INET NULL`
- `user_agent VARCHAR(512) NULL`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`

Contract:
- Every session belongs to exactly one Site membership. A session for one Site is never accepted as a
  session for another Site.
- The browser receives only the opaque id/secret cookie transport; the stored secret is hashed.
- Authentication methods and assurance describe how this session was established and support server-side
  step-up checks; they are not role claims.
- `auth_state` is `3 = complete` only when the Site policy is satisfied. `1` (factor enrollment required)
  and `2` (factor challenge required) sessions are not accepted as authenticated Site sessions; they
  only carry the user through the factor workflow. Completing it sets `auth_state = 3` and assurance `2`.
- `auth_policy_revision` is the `site_auth_config.policy_revision` the state was evaluated under. When the
  Site policy revision is newer, the session is re-evaluated on read and rejected unless it is still
  complete. A Core role change sets the live sessions of that membership to `0`, because the policy's
  role scope may reach them now. A session under a grace deadline that has not passed keeps its old
  revision, so it is asked again on every read until the deadline has.
- `next_path` is the normalized relative destination requested at sign-in, recorded with the session.
- Provider access tokens are not session fields. Tokens retained for provider API access belong to a
  separate encrypted integration/Add-on store.

### `phis.user_password_reset_tokens`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `token_hash CHAR(64) NOT NULL UNIQUE`
- `expires_at TIMESTAMPTZ NOT NULL`
- `consumed_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`
- indexes on `(user_id, site_id, expires_at DESC)` and `(site_id, expires_at DESC)`

Contract:
- A reset token is Site-scoped through the membership it belongs to.
- Only the SHA-256 hex digest of the token is stored; the token itself is sent to the user once.
- The lifetime defaults to two hours and is never shorter than 60 seconds.
- Consuming a token sets `consumed_at` once; a consumed or expired token is not accepted.

### `phis.user_profiles`

- `user_id INT PRIMARY KEY REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `first_name VARCHAR(128) NOT NULL`
- `last_name VARCHAR(128) NOT NULL`
- `company_name VARCHAR(256) NULL`
- `phone VARCHAR(64) NULL`
- `mobile VARCHAR(64) NULL`
- `fax VARCHAR(64) NULL`
- `address_1 VARCHAR(255) NULL`
- `address_2 VARCHAR(255) NULL`
- `postal_code VARCHAR(32) NULL`
- `city VARCHAR(128) NULL`
- `province VARCHAR(128) NULL`
- `country_code CHAR(2) NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `user_profiles` stores Phi-owned global profile data.
- A Site-specific commerce profile may remain Medusa-owned and is reached through the matching
  `user_site_external_accounts` relation; it does not change global identity ownership.

### `phis.registration_intents`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `email VARCHAR(320) NULL`
- `first_name VARCHAR(128) NULL`
- `last_name VARCHAR(128) NULL`
- `company_name VARCHAR(256) NULL`
- `password_ciphertext TEXT NULL`
- `password_iv CHAR(24) NULL`
- `password_auth_tag CHAR(32) NULL`
- `locale VARCHAR(8) NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `status SMALLINT NOT NULL DEFAULT 0`
- `verification_token_hash CHAR(64) NOT NULL`
- `verification_token_expires_at TIMESTAMPTZ NOT NULL`
- `verified_at TIMESTAMPTZ NULL`
- `consumed_at TIMESTAMPTZ NULL`
- `meta JSONB NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Temporary registration consent flags should be stored in `registration_intents.flags` instead of standalone boolean columns.
- On successful confirmation, relevant site-scoped consent bits should be copied into `phis.user_site_memberships.user_site_flags`.
- On successful confirmation, `registration_intents.user_id` should be linked to the final `user_accounts` row.
- `registration_intents.user_id = NULL` means a new account registration intent.
- `registration_intents.user_id IS NOT NULL` means a confirmed account update intent, such as an email change.
- A confirmed profile email change writes `phis.user_emails`; it never restores an email field on
  `user_accounts`. Site-scoped commerce synchronization is a separate external-account workflow.
- After an intent reaches `consumed`, redundant personal snapshot fields such as `email`, `first_name`, `last_name`, and `company_name` should be cleared to `NULL` for data minimization.
- Final account-existence checks should resolve against `phis.user_accounts`, not against the intent row itself. If an intent needs to be correlated after consumption, that should happen through `user_id`.
- Re-registering the same email on the same site should supersede older pending intents and create one fresh pending intent.

### `phis.form_definitions`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `owner_module_id VARCHAR(160) NOT NULL`
- `form_id VARCHAR(255) NOT NULL`
- `version INT NOT NULL DEFAULT 1`
- `status SMALLINT NOT NULL DEFAULT 1`
- `flags INT NOT NULL DEFAULT 0`
- `title VARCHAR(128) NOT NULL`
- `description TEXT NULL`
- `category VARCHAR(64) NULL`
- `tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
- `descriptor JSONB NOT NULL`
- `submit_handler_key VARCHAR(128) NULL`
- `confirm_handler_key VARCHAR(128) NULL`
- `preview_handler_key VARCHAR(128) NULL`
- `default_config JSONB NOT NULL DEFAULT '{}'::jsonb`
- `variant VARCHAR(64) NULL`
- `config JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, form_id, version)`

Contract:
- `form_id` is the complete lowercase namespaced identity `<npm-package>/forms/<form-key>`.
- `owner_module_id` records the Runtime Module that owns the preset or Site override lifecycle; it is
  metadata and never forms a second identity with `form_id`. Its package namespace must match the
  package namespace in `form_id`; SQL checks reject mismatches and malformed namespaced ids.
- `status = 0` is the reserved Working Draft state, `status = 1` is Published, and `status = 2` is an
  archived Published revision. Partial unique indexes allow at most one Working Draft and one Published
  revision per Site and Form.
- `descriptor` is one atomic versioned document with `schemaVersion = 1`, `fields`, and `actions`; a SQL
  CHECK enforces that shape.
- Split `fields` and `validation` columns are not part of v1.
- The descriptor owns visual layout, fields, validation-provider references, labels, and actions only.
- Execution targets, status, CSRF/guard policy, and server security stay in dedicated columns/config and
  flags. `flags & 1` means the published form may request a server-issued Form guard.
- `descriptor.key` must equal normalized `form_id`; persistence rejects mismatches before SQL execution.

### `phis.site_content`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `type SMALLINT NOT NULL`
- `slug VARCHAR(255) NOT NULL`
- `status SMALLINT NOT NULL DEFAULT 0`
- `current_version_id INT NULL`
- `published_version_id INT NULL`
- `submitted_version_id INT NULL`
- `instance_id VARCHAR(16) NULL`, unique per Site where set
- `published_at TIMESTAMPTZ NULL`
- `expires_at TIMESTAMPTZ NULL`
- `sort_order INT NOT NULL DEFAULT 0`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, type, slug)`

Contract:
- `site_content*` remains the canonical redaction/publishing store for site-owned content.
- Content widgets are bound to `site_content` by their instance id (`instance_id`) instead of embedding copy in widget config.
- `asset` is the content type for a reusable image/media wrapper and must point at `media_assets.id` through `site_content_versions.asset_id`.
- Widget-owned content (`asset`, `text`, `html`, `markdown`) follows [CONTENT.md](./CONTENT.md): it is
  bound to its Widget by `instance_id`, every changed save appends a version and moves
  `current_version_id`, and only a publish moves `published_version_id`. The live Site reads the
  published version, editors and previews the current one; a structure publish never moves either.
- `submitted_version_id` is the version put forward for publication; a publish clears it.
- `news` states its terms in its own columns as well, and two authorities write them. A save is `PHI_ACCESS_CONTENT_EDITING`: it appends a version, writes `title`, `subtitle` and
  `content` as `site_content_version_text` rows and moves `current_version_id`. A publish is
  `PHI_ACCESS_PUBLISHING`: it sets `status`, points `published_version_id` at `current_version_id` and
  states `published_at` and `expires_at`. An edit after a publish is therefore kept back until it is
  published in turn.
- A `news` entry is answered publicly while `status = published`, `published_at <= NOW()` and
  `expires_at` is null or in the future. A schedule and an expiry are read filters, not states: nothing
  runs at the appointed minute, and an expired entry keeps its row and its publication.
- A `news` version's `meta` states how its words are to be read, and nothing else: `sourceLocale` is the
  language they are written in (`null` for the Site's own), `translate` whether a reader in another
  language may be served a translation. They sit on the version rather than the entry because a later
  version may be written in another language, and a save states both every time.
- `news` text is kept under a spoken translation context -- `news entry title`, `news entry subtitle`,
  `news entry body` -- which is part of a message's identity and is handed to the provider as a hint. The
  context is deliberately not per entry: one phrase for all titles keeps identical sentences on one row.
  The read path states the same values, so a cached translation lands on the row the entry points at.
- `news` translations are pulled, never pushed. A save translates nothing; the first read in a language
  that has no translation yet asks for one and caches it. An entry written in another language than the
  Site's own takes the external route: translated into the Site's language as its own message, the
  original kept as the answer for its own language, every further language derived from the canonical one.
  A corrected text is a new message row, so nothing is invalidated.
- A `news` entry's tags are plain strings in the content row's `meta`, trimmed and lower-cased: the string
  is the tag's identity, so two spellings would be two tags. They are translated on read like the other
  fields, under the context `news tag`, and become messages the first time they are read in another
  language -- the translator ensures a message for whatever it is handed, so nothing registers them first.
- A `news` body is Markdown and is translated where it is rendered, paragraph by paragraph, so its
  structure never reaches a provider. `GET /api/v1/entries/news` therefore answers `content` as it was written,
  with `sourceLocale` beside it.
- A published `news` entry must be withdrawn before it can be deleted. Withdrawal clears
  `published_version_id`, `published_at` and `expires_at` and leaves every version in place.
- `site_content(type=asset)` is created on demand when a widget binds to a media asset, not eagerly on media upload.
- `text` is the canonical content type for database-backed `simple-text` widget copy.
- Rich text should use its own dedicated `site_content(type=html)` path instead of overloading `type=text`.
- The CMS POST path is the authoritative HTML trust boundary. For `contentBinding.storage=html`, the
  backend sanitizes the declared source field before persisting the immutable `site_content(type=html)`
  version; the Widget config does not keep the field. Client-side authoring checks are advisory and cannot replace this
  write-time enforcement.
- `site_content(type=html)` and `site_content(type=markdown)` are the declared internal content channel
  from [REFERENCES.md](./REFERENCES.md). The write sanitizer accepts `phis:page/<reference>` and
  `phis:asset/<asset-id>` there, and `img` exists in that channel because an Asset reference is expressed
  as an image source. Every other sanitizer caller keeps the external-only scheme set.
- Only the canonical literal reference form survives. A value that reaches a `phis:` scheme through
  percent-encoding or other obfuscation loses its `href`/`src` attribute rather than being repaired,
  and a well-formed scheme with an invalid reference grammar is dropped the same way.
- Both channels index their surviving references into `site_cms_references` with `source_kind = content`
  in the same transaction as the content write, so path-change reporting and delete guards see content
  bodies and not only revision trees.
- Already persisted HTML is not re-sanitized by Public or App clients. Server-rendered presets, external
  documents, and translation-provider output remain separate trust boundaries and must be sanitized
  before they reach an HTML rendering sink.
- Inline markdown should use `site_content(type=markdown)` with `site_content_version_text.field_name = markdown`.
- URL-backed markdown remains external-source content and should not create a `site_content` row.
- The backend write path must not hardcode those persistence routes by concrete widget `typeKey`.
- The CMS widget write payload should instead carry explicit content-binding metadata, for example storage channel plus source config field, and persistence should follow that declarative contract.
- A preset node keeps its shipped value in config until a content write binds it; a structure save never
  creates a row for a preset node.
- A widget-owned row is deleted with the last revision that places its Widget; a preset node's row is not
  swept by revision deletion.
- Structure and placement are modeled through CMS revision trees, not through separate relational layout/widget tables.

### `phis.site_area_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `area_id SMALLINT NOT NULL DEFAULT 1`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `working_module_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, area_id)`

Contract:
- One area scope exists per `site + area`.
- `area_id` is the Area's visibility-mask bit from `PhiCmsVisibilityContext` (public `1`, app `2`, admin `8`,
  editor `16`, accounting `64`, builder `256`), not an ordinal. The same holds for `site_page_scopes.area_id`
  and `site_cms_references.target_area_id`.
- The scope stores one published revision pointer and two Working Draft pointers: `working_draft_revision_id`
  for the Area structure and `working_module_draft_revision_id` for the Area's Module selection. Both
  drafts are ordinary `site_area_revisions` rows carrying a whole Area; each publish writes only the
  fields its draft owns into the published revision and reads the rest from it.
- Published live reads resolve directly through `site_area_scopes.published_revision_id` into the area revision payload.
- No separate materialized live shell tables should sit between the published revision pointer and runtime rendering.

### `phis.site_page_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `area_id SMALLINT NOT NULL DEFAULT 1`
- `path VARCHAR(512) NULL`
- `draft_path VARCHAR(512) NULL`
- `owner_module_id VARCHAR(255) NULL`
- `preset_key VARCHAR(255) NULL`
- `tombstoned_at TIMESTAMPTZ NULL`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `CHECK ((path IS NOT NULL AND owner_module_id IS NULL AND preset_key IS NULL) OR (path IS NULL AND owner_module_id IS NOT NULL AND preset_key IS NOT NULL))`
- `CHECK (owner_module_id IS NULL OR owner_module_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$')`
- `CHECK (draft_path IS NULL OR path IS NOT NULL)`
- Partial unique index on `(site_id, area_id, path)` where `path IS NOT NULL`
- Partial unique index on `(site_id, area_id, draft_path)` where `draft_path IS NOT NULL`
- Partial unique index on `(site_id, area_id, owner_module_id, preset_key)` where `owner_module_id IS NOT NULL`
- Index on `(site_id, area_id, tombstoned_at, id)`

Contract:
- A Site-authored exact Page has one immutable Scope id, one mutable canonical `path`, and no
  module-preset identity. The unique `(site_id, area_id, path)` constraint protects route allocation but
  does not make the path the Page identity.
- A module route snapshot has one scope per `site + area + owner_module_id + preset_key`; its concrete request path is not part of the scope identity, including for dynamic `:id` routes.
- Exactly one address kind is populated. Path lookup is never used as a compatibility alias for a module-preset scope.
- `area_id` is the internal numeric area identifier for the concrete area. It is not a visibility mask.
- The scope stores the current published revision pointer and the current working draft pointer.
- Site Page path mutation follows [REFERENCES.md](./REFERENCES.md#explicit-path-change-command): it is an
  explicit Scope command, independent of revisions and Undo/Redo. Module Page paths remain
  descriptor-owned and immutable to the Site.
- `draft_path` is the pending path of a Site Page: the path change command writes it, publishing the Page
  moves it into `path` and clears it, and discarding the Page draft clears it. Pending paths contend for
  addresses exactly as live paths do, through their own partial unique index.
- Site Page deletion retains the Scope row and its canonical path. The deleted Page revision state is the
  logical tombstone; `tombstoned_at` is the published side of it and is written only by
  `publishSitePageRevision`: publishing a revision marked deleted sets it, keeping the time a first
  publish of that deletion wrote, and publishing a revision that is not marked deleted clears it, which is
  the restore. A draft that marks the Page deleted writes no Scope state at all, so the published Page
  keeps resolving until the deletion is published, and discarding or deleting that draft revision leaves
  the published row exactly as the last publish left it. The path stays reserved by the existing unique
  key. Creating or restoring a Site Page at that path reactivates this Scope and reuses its immutable id
  rather than inserting another Scope. Runtime reference resolution remains id-based and never falls back
  to path matching.
- Published Page listings, the sitemap, Navigation folder-address resolution, and Module usage ignore
  Scopes whose `tombstoned_at` is set. They therefore see a deletion when it is published and not before.
  The address rules are the exception and count a tombstoned Scope as holding its path, because deletion
  reserves it.
- `tree_json.page.path` is not an independently writable source of truth. A read/render projection may
  carry the currently resolved path, but persistence resolves Site paths from the Scope column and Module
  paths from the active route descriptor.
- Published live reads resolve directly through `site_page_scopes.published_revision_id` into the page revision payload.
- No separate materialized live page tables should sit between the published revision pointer and runtime rendering.

### Internal Page and Asset references

Stable Page references and `phis:page/...` / `phis:asset/...` document references follow
[REFERENCES.md](./REFERENCES.md). Structured internal targets persist a Page Scope id or a derived Module
Page id, never a copied path. Asset targets reuse `media_assets.id` and remain Site/access constrained.

`phis.site_cms_references` is the maintained projection, updated transactionally by the same writes that
persist the referencing data. Revision JSON is never scanned to answer a reference lookup.

### `phis.site_cms_references`

- `id BIGSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `source_kind SMALLINT NOT NULL`
- `source_scope_id INT NOT NULL`
- `source_revision_id INT NULL`
- `source_location VARCHAR(1024) NOT NULL`
- `target_kind SMALLINT NOT NULL`
- `target_area_id SMALLINT NULL`
- `target_page_scope_id INT NULL REFERENCES phis.site_page_scopes(id) ON DELETE RESTRICT`
- `target_asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT`
- `fragment VARCHAR(512) NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, source_kind, source_scope_id, source_revision_id, source_location)`

Contract:
- `source_kind` is closed: `1 = page` (revision `tree_json`), `2 = navigation` (revision `tree_json`), `3 = content` (a trusted `site_content` HTML or Markdown body), `4 = area` (revision `tree_json`), `5 = theme` (revision `tree_json`).
- `source_scope_id` is the owning Page Scope, Navigation Scope, Area Scope, Theme Scope, or `site_content.id` for the matching source kind. Writers replace the reference set of the revision they persist -- one `(site_id, source_kind, source_scope_id, source_revision_id)` -- in the same transaction; a Content source, which has versions rather than revisions, replaces its whole set.
- An Asset reference in persisted config is a positive id in a field named `assetId` or in one whose name ends in `AssetId`; `phis:asset/<id>` is the form for trusted Markdown and HTML bodies. The collector reads exactly these two, so an Asset stored under any other shape has no index row and is deletable while the Site renders it. Normative in [REFERENCES.md](./REFERENCES.md).
- `source_location` is a JSON-Pointer-style path into the source value, with `~0`/`~1` escaping and an appended `@<offset>` when several references are embedded in one string. Content sources use the persisted field name as the root, for example `/html@42`.
- `target_kind` is closed: `1 = Site Page Scope`, `3 = Asset`. A CHECK constraint enforces that exactly the matching target columns are set. `2` was the Module preset Page and is retired: a Module Page target is not indexed at all, because the Site owns neither the Page nor its path, switching the Module off is reversible and gives its routes back, and there is no row a foreign key could point at. The absence of a row therefore does not mean nothing points at a Module Page. The numbers of the two remaining kinds are unchanged, so a stored value keeps its meaning.
- Asset targets are validated against the Site Media Space on write; a reference to an Asset outside it aborts the transaction.
- `ON DELETE RESTRICT` on both target columns makes the index the enforcement point for Page and Asset deletion, not just a reporting aid.
- The projection is read for path-change affected-reference counts, Page and Asset deletion diagnostics, and delete guards. It never rewrites reference owners: a stable identity already resolves to the new path.
- Because a Widget body is persisted both in the revision `tree_json` and in its `site_content` row, one authored reference legitimately produces one Page-source row and one Content-source row. The per-source breakdown keeps that visible; the sum is a location count, not a distinct-authored-reference count.
- The Area source is the `tree_json` counterpart to the Page source, written by the Area draft save inside the same transaction. Area-owned trusted bodies reach the index through the Content source; the Area source covers references in Area widget or Region config, which carry no content binding.
- The Theme source is the Site-wide carrier no CMS tree reaches. One Scope per Site, a key without an Area prefix, and it holds the Root background a Module's ground was taken over into plus the brand logo. A Theme row names no Area, and a Page reference in a Theme is invalid because a Site-wide Scope has no Area to resolve one in. Written by the Theme draft save and rewritten by the Theme publish, which may promote a revision other than the current draft.
- `source_revision_id` is what makes a row's own liveness readable. Page, Navigation, Area, and Theme sources index the revision that was just written, and a draft save leaves the published revision's rows -- and an Area's Module draft rows beside its structure draft -- standing. A row naming a revision its Scope points at from none of its pointers is dead, and every pointer change, restore and history delete drops such rows in its own transaction: under `ON DELETE RESTRICT` a dead row would otherwise refuse the delete of an Asset the guard reports as unreferenced. The readers that would act on a row -- the Asset delete guard and the affected-reference count behind a path change -- still disregard one over the same Scope joins. An Area Scope has three such pointers: `published_revision_id`, `working_draft_revision_id`, and `working_module_draft_revision_id`, the Working Draft a Module writes for what it contributes. A publish that merges a tree instead of only promoting a pointer -- both Area publishes -- rewrites the set for the tree it published. Publishing promotes the draft revision rather than creating one, so a published reference keeps matching. Content sources are exempt: their revision is a content version, and the orphan collector already removes their rows when a discarded Draft leaves the content unreferenced.

### CMS node identity target contract

- Layout, Widget, Overlay, and resolved Navigation item instances use one canonical 96-bit `PhiCmsInstanceId`, serialized as exactly 16 Base64URL characters and stored exclusively in revision `tree_json`.
- Layout-parent and Page/Region root-Layout references use the target Layout `instanceId`. Signal receivers use `cms:<instanceId>` and `cms:<instanceId>:<subcontrolKey>`; Widget/Layout kind is registry metadata.
- Layout type keys are exactly `<plugin-key>/<layout-type>`. Padding, background, border, radius, shadow, and effect are normal Layout config; no presentation kind or type-key suffix is persisted.
- Region padding is stored flat as `padding`, `paddingTop`, `paddingRight`, `paddingBottom`, and `paddingLeft` inside the Region config in `tree_json`.
- Codec v1 uses one version/origin header byte and one explicit closed domain byte (`area`, `page`, or `navigation`). Draft-origin ids then use six bytes for a safe 48-bit owning Draft revision id and four bytes for the Draft-local sequence. The complete id is never represented as one JavaScript number, and the earlier pre-domain v1 byte layout is invalid.
- Every Area, Page, or Navigation Draft persists one monotonic `nextNodeSequence`: Area and Page Drafts in revision `meta_json.draft.nextNodeSequence`, Navigation Drafts in `site_nav_revisions.next_node_sequence`. Deleted sequence values are never reused, and concurrent writes require Draft revision/version conflict detection.
- Preset ids use a versioned Preset header, the domain byte, and an 80-bit deterministic hash of `(contractVersion, domain, ownerModuleId, presetKey, nodeKey)`. Preset version, Site, concrete Area key, route, browser/storage path, and node type do not participate.
- Identity is independent of revision state and remains unchanged through Draft, review, preview, publish, reset, move, and config edits. Duplication or portable import creates a new target-owned Draft id; inserting into an in-memory fallback creates its Draft first.
- Publish validates encoding/active-context uniqueness and every structural/signal reference, then updates the selected revision and its scope pointer in one transaction without identity materialization.
- Exact backup/restore preserves ids, revisions, pointers, and DB sequences. Portable CMS import creates a target Draft and centrally remaps every internal reference; module-owned domain data participates only through declared module export/import hooks.
- There is no numeric CMS node id, negative-id lifecycle, CMS-node `instanceKey`, UUID alias, or compatibility reader.

### `phis.site_area_revisions`

- `id SERIAL PRIMARY KEY`
- `area_scope_id INT NOT NULL REFERENCES phis.site_area_scopes(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `tree_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `message VARCHAR(256) NULL`
- `meta_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `source_revision_id INT NULL REFERENCES phis.site_area_revisions(id) ON DELETE SET NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Area revisions are the persisted authoring source of truth for area drafts and published area state.
- A Working Draft revision keeps its draft version and `nextNodeSequence` in `meta_json.draft`.
- A Working Draft is one row rewritten in place, so `created_at` stays the first save. Every rewrite stamps `meta_json.saved = { at, byUserId }` (`updateSiteDraftRevisionWithDb`); the revision history answers it as `savedAt` and `savedByLabel`. A row without `saved` was never rewritten.
- `tree_json` stores the concrete area as string field `area`.
- `tree_json.controllerSettings` is mandatory: what the tree tells its Controllers, an array of `{ type, instanceKey, mountScope, config }` keyed by `type` and `instanceKey`, `mountScope` being the tree's own scope (`area` here, `page` on a Page). It is the same contract on a Page and on an Area; `config.signalRoutes` is checked like a node's routes against the tree's own nodes, and there is no `enabled` (`validateCmsPageWriteInput`, `validateCmsAreaPresetWriteInput`). A tree that configures nothing stores `[]`.
- `tree_json.sourcePreset` is mandatory and stores `ownerModuleId`, `presetKey`, and the positive `sourcePresetVersion` of the Area shell snapshot.
- Forking a Draft from a Published snapshot preserves that source version. A newer installed preset never rewrites an existing Draft or Published snapshot.
- `flags` currently distinguish at least:
  - `Draft`
  - `Published`
- `revision=<id>` resolves exactly one draft revision for preview when the caller is authorized.
- Publish updates the scope pointer to the selected revision instead of materializing into legacy live tables.

### `phis.site_page_revisions`

- `id SERIAL PRIMARY KEY`
- `page_scope_id INT NOT NULL REFERENCES phis.site_page_scopes(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `tree_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `message VARCHAR(256) NULL`
- `meta_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `source_revision_id INT NULL REFERENCES phis.site_page_revisions(id) ON DELETE SET NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Page revisions are the persisted authoring source of truth for page drafts and published page state.
- A Working Draft revision keeps its draft version and `nextNodeSequence` in `meta_json.draft`.
- A Working Draft is one row rewritten in place, so `created_at` stays the first save. Every rewrite stamps `meta_json.saved = { at, byUserId }` (`updateSiteDraftRevisionWithDb`); the revision history answers it as `savedAt` and `savedByLabel`. A row without `saved` was never rewritten.
- `tree_json` stores the concrete area as string field `area`.
- `tree_json.controllerSettings` is mandatory: what the tree tells its Controllers, an array of `{ type, instanceKey, mountScope, config }` keyed by `type` and `instanceKey`, `mountScope` being the tree's own scope (`page` here, `area` on an Area). It is the same contract on a Page and on an Area; `config.signalRoutes` is checked like a node's routes against the tree's own nodes, and there is no `enabled` (`validateCmsPageWriteInput`, `validateCmsAreaPresetWriteInput`). A tree that configures nothing stores `[]`.
- `tree_json.sourcePreset` is either `null` for a Site-authored exact Page or stores `ownerModuleId`, `presetKey`, and positive `sourcePresetVersion` for a module route snapshot.
- Forking a Draft from a Published snapshot preserves that source version. A newer installed preset never rewrites an existing Draft or Published snapshot.
- `flags` currently distinguish at least:
  - `Draft`
  - `Published`
- `revision=<id>` resolves exactly one draft revision for preview when the caller is authorized.
- Publish updates the scope pointer to the selected revision instead of materializing into legacy live tables.

### `phis.site_content_versions`

- `id SERIAL PRIMARY KEY`
- `content_id INT NOT NULL REFERENCES phis.site_content(id) ON DELETE CASCADE`
- `version_no INT NOT NULL`
- `asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (content_id, version_no)`

Contract:
- `asset_id` lives on the version because the live Site shows the published version: an image swapped
  in a draft must not reach the published page before the content is published.
- A media asset stays referenced while any version still names it.

### `phis.site_content_version_text`

- `id SERIAL PRIMARY KEY`
- `version_id INT NOT NULL REFERENCES phis.site_content_versions(id) ON DELETE CASCADE`
- `field_name VARCHAR(64) NOT NULL`
- `msg_id INT NOT NULL REFERENCES phis.tr_site_msg(id) ON DELETE CASCADE`
- `UNIQUE (version_id, field_name)`

### `phis.site_nav_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `key VARCHAR(64) NOT NULL`
- `label VARCHAR(128) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, key)`

Contract:
- One navigation scope exists per `site + area:key`.
- `site_nav_scopes.key` is a canonical `area:key` identifier. Area base modules declare built-in surfaces and Sites
  may add additional keys inside the same Area namespace.
- Runtime widget contracts reference declared navigation surfaces by `key`, not by database `id`.
- Area definitions in `phis-ui/plugins/runtime-modules/area-definitions.ts` declare the built-in keys, for
  example `public:header`, `public:footer`, `public:quicklinks`, `app:header`, `app:sidebar`,
  `app:account`, `admin:sidebar`, and `builder:sidebar`.
- The scope stores the current published revision pointer and the current working draft pointer.
- Published live reads resolve directly through `site_nav_scopes.published_revision_id` into the navigation overlay payload.

### `phis.site_nav_revisions`

- `id SERIAL PRIMARY KEY`
- `nav_scope_id INT NOT NULL REFERENCES phis.site_nav_scopes(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `next_node_sequence BIGINT NOT NULL DEFAULT 1` (CHECK `BETWEEN 1 AND 4294967296`)
- `tree_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `message VARCHAR(256) NULL`
- `meta_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `source_revision_id INT NULL REFERENCES phis.site_nav_revisions(id) ON DELETE SET NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Navigation revisions persist site-authored overlays over the active module descriptor tree.
- Every Navigation Draft persists the monotonic `next_node_sequence` used by the central
  `PhiCmsInstanceId` codec for Site-owned navigation items. Deleted values are never reused.
- The navigation overlay is stored in `tree_json`; no resolved navigation tree or route href is persisted.
- `tree_json` stores:
  - the Area-owned `navKey`
  - an optional surface `label` override
  - `itemOverrides` keyed by resolved preset-origin Navigation `PhiCmsInstanceId`
  - optional per-item `label`, `icon`, and `placement` overrides
  - `customItems` keyed by centrally allocated Draft-origin Navigation `PhiCmsInstanceId`
  - `tombstones` containing hidden preset-origin Navigation `PhiCmsInstanceId` values
- A placement contains `parentId` plus the sibling `index`.
- Package descriptor `itemKey` values remain compile/injection anchors and are never persisted as resolved identity.
- Missing modules leave their overrides and tombstones dormant; reinstalling the module reactivates them.
- Route targets and hrefs are immutable descriptor data and are never accepted in the persistence ABI.
- Runtime resolution combines active Area/module descriptors with the published overlay and translates the resulting labels in Shared UI.
- `icon` overrides store a namespaced icon reference string resolved by `PhiIcon` in phis-ui:
  - `antd:<icon-key>` (or a bare key) for Ant Design icons
  - `iconify:<icon>` for Iconify icons
  - `asset:<path>` for static assets served from the Site `public/` tree
  - `<package>/layouts:<motif>` and `<package>/widgets:<motif>` for Builder icons
- Any other namespace requires a shared contract update in `PhiIcon` before it is stored.

### `phis.site_theme_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `key VARCHAR(64) NOT NULL DEFAULT 'default'`
- `label VARCHAR(128) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, key)`

Contract:
- One default theme scope exists per site for site-wide branding and frontend theme tokens.
- The initial canonical key is `default`; additional keys require an explicit product contract update before frontends consume them.
- The scope stores the current published revision pointer and the current working draft pointer.
- Published runtime reads continue to resolve through `phis.sites.theme`.
- Theme scopes are not widget instances. Widget-owned branding settings belong to their own widget config or a later dedicated contract.

### `phis.site_theme_revisions`

- `id SERIAL PRIMARY KEY`
- `theme_scope_id INT NOT NULL REFERENCES phis.site_theme_scopes(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `tree_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `message VARCHAR(256) NULL`
- `meta_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `source_revision_id INT NULL REFERENCES phis.site_theme_revisions(id) ON DELETE SET NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Theme revisions are the persisted authoring source of truth for brand/theme drafts and published theme state.
- `tree_json` stores a full theme snapshot with:
  - `key`
  - optional `label`
  - `theme`, matching the JSON shape written to `phis.sites.theme`
- Publish updates `site_theme_scopes.published_revision_id`, clears the working draft pointer, and writes the selected `tree_json.theme` to `phis.sites.theme`.
- Both the draft save and the publish replace this Scope's set in `phis.site_cms_references` under source kind `5`, in their own transaction. A ground a Module shipped becomes an Asset of this Site the moment somebody edits it, and the brand logo names one too; without those rows the delete guard reads the Theme as referencing nothing.
- The published site runtime object remains the live rendering source for pages, shells, navigation, and brand builder preview consumers unless they explicitly request a draft.

### `phis.site_groups`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `provider_id VARCHAR(255) NOT NULL` (CHECK: namespaced id)
- `key VARCHAR(160) NOT NULL` (CHECK `~ '^[a-z0-9][a-z0-9._-]{0,159}$'`)
- `name VARCHAR(255) NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `retired_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, provider_id, key)` and `UNIQUE (id, site_id)`
- index on `(site_id, LOWER(name), id)`

Contract:
- The group contract is defined in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md).
- `flags` follows `PhiSiteGroupFlags`: `1 << 0` shows each member's company to the other members.
- `retired_at` carries group retirement, which replaces deletion: the row and its key stay, and a retired
  group grants nothing. It is its own column because `updated_at` moves on every later edit. See
  [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md#retiring-a-group).
- The composite foreign key from `media_spaces` deliberately does not cascade: deleting a group that
  still has a Space fails at commit instead of taking the Space and its contents along.

### `phis.site_group_members`

- `group_id INT NOT NULL`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `source_provider_id VARCHAR(255) NOT NULL` (CHECK: namespaced id)
- `source_connection_key VARCHAR(160) NOT NULL DEFAULT 'local'`
- `source_binding_or_assertion_key VARCHAR(512) NOT NULL`
- `membership_flags SMALLINT NOT NULL`
- `valid_until TIMESTAMPTZ NULL`
- `provider_revision VARCHAR(255) NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (group_id, user_id, source_provider_id, source_connection_key, source_binding_or_assertion_key)`
- `FOREIGN KEY (group_id, site_id) REFERENCES phis.site_groups(id, site_id) ON DELETE CASCADE`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`
- indexes on `(site_id, user_id, group_id)` and `(site_id, group_id, user_id, valid_until)`

Contract:
- One row is one source's assertion of one user's membership in one group. The effective membership is the
  union of the user's active rows for that group, so removing one source never removes another source's
  contribution.
- `membership_flags` is one of the cumulative levels of `PhiGroupMembershipFlags`: Member `1`, Author `3`,
  Editor `7`, Manager `15`. A CHECK rejects any value that skips a lower bit.
- Both composite keys carry `site_id`, so a member without a matching Site membership, or a cross-Site
  membership, is unrepresentable.
- Changing a user's effective membership increments that user's `user_site_memberships.authorization_revision`.

### `phis.directory_connections`, `phis.directory_user_bindings`, `phis.directory_group_bindings`

- `directory_connections`: `id SERIAL PRIMARY KEY`, `site_id`, `provider_id`, `connection_key`,
  `config JSONB` (object), `secret_reference`, `state SMALLINT DEFAULT 1`,
  `max_staleness_seconds INT DEFAULT 86400`, `provider_revision`, `cursor JSONB`, `last_completed_at`,
  `last_error_at`, `created_at`, `updated_at`; `UNIQUE (site_id, provider_id, connection_key)`
- `directory_user_bindings`: `site_id`, `user_id`, `provider_id`, `connection_key`, `external_subject`,
  `status SMALLINT DEFAULT 1`, `provider_revision`, `last_observed_at`, `created_at`, `updated_at`;
  primary key `(site_id, provider_id, connection_key, external_subject)`; foreign keys to
  `user_site_memberships (user_id, site_id)` and `directory_connections`, both cascading
- `directory_group_bindings`: the same shape with `group_id` instead of `user_id` and a foreign key to
  `site_groups (id, site_id)`

Contract:
- These tables are reserved for external Directory Providers and are neither read nor written by Core.
  Their contract is [design/DIRECTORY_PROVIDERS.md](./design/DIRECTORY_PROVIDERS.md).

### `phis.support_ticket_types`

- `id SMALLSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `key VARCHAR(64) NOT NULL`
- `name VARCHAR(128) NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `close_policy SMALLINT NOT NULL DEFAULT 0`
- `requester_window_days SMALLINT NULL`
- `requester_allowance SMALLINT NULL`
- `requester_allowance_period SMALLINT NOT NULL DEFAULT 0`
- `forward_target VARCHAR(512) NULL`
- `retired_at TIMESTAMPTZ NULL`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, key)`
- `UNIQUE (id, site_id)`
- `CHECK (requester_allowance_period IN (0, 1, 2) AND (requester_allowance IS NULL) = (requester_allowance_period = 0) AND (requester_allowance IS NULL OR requester_allowance >= 0))`

Contract:
- What kinds of Support work a Site handles is the Site's own catalogue, not a vocabulary compiled into the server.
- `flags` are `PhisSupportTicketTypeFlag` from `@phis/contracts/support`:
  - `1 = External`: the conversation of tickets of this type is mirrored to a linked external system.
  - `2 = CodeChange`: the work is a code change.
  - `4 = Requestable`: a requester may choose this type. Off by default, so a type a Site adds is Staff-only until the Site says otherwise.
- `External` is a flag rather than a type of its own because it cuts across every type; a bug may be handled internally or in the open.
- `close_policy` is `PhisSupportClosePolicy`:
  - `0 = Confirm`: a Supporter confirms.
  - `1 = CodeAccepted`: a merged pull request completes the task, and the ticket resolves when every engineering task is done.
- `CodeAccepted` requires the `CodeChange` flag: a type with no merge to wait for must not wait for one.
- Neither policy resolves a ticket because an external issue was closed as not planned; that is a decision about the external work.
- `requester_window_days` narrows or widens the Site default in `site_thread_config`; `NULL` takes it, and `0` means a Supporter closes the ticket.
- `(id, site_id)` is unique so a ticket's composite foreign key cannot point at another Site's type.
- `retired_at` replaces deleting a type, as `site_groups` does it: the row and its key stay, a retired type is offered to nobody, and the tickets already opened with it keep naming it.
- `requester_allowance` is how many of this type one person may open for themselves per period; `NULL` is no limit, which is what a type has until a Site says otherwise. The opposite default from `Requestable`, and not a contradiction: a flag that is off offers nothing, where a limit arriving by default would refuse people on a Site that never asked for one.
- `forward_target` is where a forward of this type's work goes unless the Supporter chooses otherwise, as `<providerKey>#<key>` of a `support-forwarding` target ("GitHub acme/app"). A preselection in the forward dialog and not a rule: a target that is no longer offered is simply not preselected.
- `requester_allowance_period` is `PhisSupportAllowancePeriod`: `0 = None`, `1 = Month`, `2 = Year`. A calendar period, unlike `requester_window_days` on the same row, which is a rolling window because it measures one ticket's silence.
- The pair is written as an equality of two `IS NULL` tests rather than as two cases OR'd together, because `NULL >= 0` is `NULL`, `false OR NULL` is `NULL`, and a CHECK that evaluates to `NULL` passes -- which would let through exactly the half-written pair it exists to refuse.
- Only tickets the person opened for themselves count against it: `channel = 0` and `requester_user_id` theirs. A Supporter opening one on somebody's behalf neither spends the budget nor can be refused for want of it.
- A Site's first type arrives from a Module's declared seed and is created by key, never rewritten afterwards. See `design/SUPPORT.md` section 4.

### `phis.support_queues`

- `id SMALLSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `group_id INT NOT NULL`
- `key VARCHAR(64) NOT NULL`
- `name VARCHAR(128) NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `retired_at TIMESTAMPTZ NULL`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, key)`
- `UNIQUE (id, site_id)`
- `FOREIGN KEY (group_id, site_id) REFERENCES phis.site_groups (id, site_id)`

Contract:
- A queue is where Support work is routed: `support_l1`, `dev`, `billing`. It replaces `support_teams`.
- Membership is not here. A queue names one Site group, and who its people are is `site_group_members`, as it is for every other group on the Site.
- Routing, queue order, and ticket assignment are Support-domain properties and are not generic membership properties, which is why the profile survives the move.
- The group reference deliberately does not cascade, as `media_spaces` does not: no surface deletes a group, so this fails against a stray statement instead of taking a Site's routing with it.
- New tickets default to the queue a Site marks as its entry queue when none is supplied.
- `flags` are `PhisSupportQueueFlag`: `1 = Entry`.

### `phis.support_allowance_grants`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `type_id SMALLINT NOT NULL`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `provider_id VARCHAR(128) NOT NULL`
- `reference VARCHAR(190) NOT NULL`
- `amount SMALLINT NOT NULL`
- `consumed SMALLINT NOT NULL DEFAULT 0`
- `expires_at TIMESTAMPTZ NULL`
- `revoked_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, provider_id, reference)`
- `CHECK (amount > 0 AND consumed >= 0 AND consumed <= amount)`
- `CHECK (provider_id ~ '^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$')`
- `FOREIGN KEY (type_id, site_id) REFERENCES phis.support_ticket_types (id, site_id)`

Contract:
- Requests handed to one person on top of the periodic allowance their ticket type gives everybody.
- A stock, not a raised limit. The limit on the type renews and is lost at each calendar boundary; a grant does not renew and survives the boundary until it is spent or expires.
- A ticket spends the periodic allowance first and reaches a grant only when that is empty, so somebody handed ten does not find them eaten in a month the free ones would have covered.
- Grants are consumed oldest-expiry first, so a stock about to lapse is the one that gets used.
- `type_id` is always set. The allowance a grant adds to is the type's, so a grant naming no type would be a number with nothing to add it to.
- `reference` is the granting Add-on's own name for the occasion, and is what makes granting idempotent: a payment provider retries its webhook, and a second call answers with the first grant rather than a second stock. A retry carrying a different amount never rewrites one already partly spent.
- `consumed` is counted here rather than derived from the tickets: a ticket may be deleted, and a stock that refilled itself when one was would be a way to get more by throwing work away.
- `revoked_at` stops the unspent remainder on a refund or chargeback and leaves the tickets already opened against it standing.
- Who writes it is by design not Support: whether a customer paid for more lives in whatever sold it to them. `support:v1` carries `allowance`, `grant` and `revokeGrant`. See `design/SUPPORT.md` section 5.
- `retired_at` replaces deleting a queue, as `site_groups` does it: nothing routes to a retired queue, and the tickets standing in it are still in it.
- A Site's entry queue and its group arrive from a Module's declared seed, created by key on publish and never rewritten afterwards. See `design/SUPPORT.md` section 4.

### `phis.threads`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `kind SMALLINT NOT NULL`
- `status SMALLINT NOT NULL DEFAULT 0`
- `subject VARCHAR(255) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `owner_provider_id VARCHAR(255) NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `last_message_id INT NULL REFERENCES phis.thread_messages(id) ON DELETE SET NULL`
- `last_public_message_id INT NULL REFERENCES phis.thread_messages(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (id, site_id)`

Contract:
- A thread is a conversation between people on one Site, and no longer a Support-only container; see [design/THREADS.md](./design/THREADS.md).
- `subject` is the name of the whole chain: the inbox row, the heading over the messages, what a notification is called. It is **nullable for the integration path alone** -- a mail can arrive with an empty subject header and is still a conversation, and losing the message to protect a heading would be the wrong trade. A person opening one is asked for it, and `POST /api/site/threads` refuses without it, so `NULL` in practice means an integration had none. A thread with no subject is displayed under the names of whoever is in it.
- `kind` is `PhisThreadKind` from `@phis/contracts/threads`:
  - `0 = direct`, Staff to Staff between people who share a group
  - `1 = group`, inside one group
  - `2 = cross-group`, between groups, each participating as a whole
  - `3 = support`, a requester and a queue's group
- The kind is fixed when the thread is opened. A Site offers a kind only while one of its active Modules declares it in `site_thread_config`.
- `status` is `0 = open`, `1 = archived`. One row carries it, so archiving closes the thread for everyone in it rather than hiding it from one reader.
- `owner_provider_id` is the Add-on that opened the thread with no actor behind it, and is what lets it reach the thread again without one. `NULL` is Core's own, which is every thread a person opened.
- A ticket's conversation is an ordinary thread; the reference lives on `support_tickets.thread_id`.
- `last_message_id` is denormalized so an inbox orders and previews without a lateral join per row. The two tables reference each other, so the constraint is added after `thread_messages` exists.
- `last_public_message_id` is the same for messages without `Internal`. A reader who is not Staff is shown, previewed and counted unread against it, so a note written past a customer does not surface as a change they cannot open.
- `(id, site_id)` is unique so a ticket and its thread cannot end up on different Sites.

### `phis.thread_participants`

- `id SERIAL PRIMARY KEY`
- `thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE`
- `participant_kind SMALLINT NOT NULL`
- `user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `group_id INT NULL REFERENCES phis.site_groups(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `participant_kind` is `0 = user`, `1 = group`, and exactly one of `user_id` or `group_id` is populated.
- A group participates as a group. Its members are resolved when the thread is read, so somebody who joins afterwards is in the conversation and somebody who leaves is not; expanding a group into people here would freeze a membership that keeps moving.
- Membership is `site_group_members`. `support_team_members` is gone, and threads no longer carry a second group system.
- `flags` are `PhisThreadParticipantFlag`:
  - `1 = Requester`: the person a Support thread is about.
  - `2 = ExternalConsent`: this requester has acknowledged that the conversation is mirrored outside, without which their own messages are not exported.
  - `4 = Left`, `8 = Muted`.
- At most one participant per thread carries `Requester`: internal messages are written past that person, so a second one would make "hidden from them" a question with two answers.
- Recommended uniqueness: `(thread_id, user_id)` where `user_id IS NOT NULL`, `(thread_id, group_id)` where `group_id IS NOT NULL`.

### `phis.thread_messages`

- `id SERIAL PRIMARY KEY`
- `thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE`
- `author_kind SMALLINT NOT NULL`
- `author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `author_provider_id VARCHAR(255) NULL`
- `body_text TEXT NOT NULL`
- `body_markdown TEXT NULL`
- `source_lang VARCHAR(8) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- This is the only message table. `support_ticket_messages` is gone: a ticket's conversation is its thread, so an integration synchronizes one model rather than two.
- `author_kind` is `0 = user`, `1 = integration`, `2 = system`. An integration names the provider relaying it and carries the outside author in `meta`; it is not dressed up as a person.
- User deletion must not delete historical messages; `author_user_id` falls back to `NULL` while the kind stays `user`.
- `flags` are `PhisThreadMessageFlag`:
  - `1 = Internal`: only Staff participants may read it. It replaces the ticket message `visibility` column.
  - `2 = Confidential`: it may not leave Core -- not to an integration, not into a notification body, and not to an Add-on, which receives the message with its text withheld.
  - `4 = Edited`, `8 = Redacted`, `16 = Imported`.
  - `32 = LangDetected`: `source_lang` was recognised by a translator, not declared by whoever delivered the message. Core sets it with the value; no caller can ask for it.
- `Internal` and `Confidential` are independent because they answer different questions: who may read it, and where it may go. A customer may set the second on their own message.
- `source_lang` is the language the body is written in, as a locale of `PHI_LOCALE_CAPABILITIES`. It sits on the message and not on the thread because a conversation may hold more than one language, which is the case it exists for.
- **Nobody is asked for it.** No person gets a language picker and no Site route accepts one, because a translator determines the source language itself; a picker would have asked everyone who writes for an answer that is available for nothing.
- **Two things write it, and a flag says which.** An integration declares it through the threads capability's `create` and `reply`, from something it actually has. And translating a message that declared none stores the language the provider recognised -- that arrives as a field on a translation somebody paid for, and dropping it would leave the column empty for every message a person ever wrote. The second carries `LangDetected` and is only ever written where the column is `NULL`: a declaration beats a guess, and two translations of one message cannot race into different answers.
- **What earns it its place is filtering, not translating.** Routing Portuguese enquiries to people who speak Portuguese, or counting which languages enquiries arrive in, needs a stored column, because nothing that comes into being while somebody reads can appear in a `WHERE` clause.
- `NULL` means not declared. It is never to be read as the Site's default language, and it is not a claim that the message needs no translation.
- Core checks that the key is well-formed and not that it is true. An integration asserting `de` over Portuguese text misleads every reader of it, including a filter; no guard exists for that yet, and section 14 says why.
- The vocabulary is the platform capability table and never a translation provider's catalogue. A provider is swapped and a language leaves its list; what a provider can reach decides what is offered at translation time and never what may be stored. See [design/THREADS.md](./design/THREADS.md) section 14 and [TRANSLATIONS.md](./TRANSLATIONS.md).
- `meta` carries the outside author's name and URL, mentions, and equivalent lightweight additions.

### `phis.thread_message_refs`

- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `provider_id VARCHAR(255) NOT NULL`
- `external_id VARCHAR(256) NOT NULL`
- `message_id INT NOT NULL REFERENCES phis.thread_messages(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (site_id, provider_id, external_id)`

Contract:
- What an integration calls a message, so a delivery arriving twice writes one message and an outbound comment can be recognized when it comes back.
- The Site is part of the key: one repository may be linked from two Sites, and the external id would otherwise collide between them.
- `flags` are `1 = Imported`, `2 = Exported`. What came from outside is never sent back out, which is what stops a mirror from echoing.
- It replaces `support_ticket_messages.external_message_ref`, which could hold one reference and could not be looked up by it.

### `phis.thread_message_assets`

- `message_id INT NOT NULL REFERENCES phis.thread_messages(id) ON DELETE CASCADE`
- `asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED`
- `flags INT NOT NULL DEFAULT 0`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (message_id, asset_id)`

Contract:
- What a message carries besides its text. See `design/THREADS.md` section 5.
- **The audience is the message's, never the Asset's Space.** An attachment is readable by whoever may read the message it hangs on, and that is the whole rule. Custody says who pays for the bytes and who administers them, which for one conversation would give a different answer depending on who happened to attach the file — and none of them expresses that an `Internal` note is invisible to the customer reading the thread around it.
- The asymmetry between the two arms is the point. A message that goes takes its links with it, because a link to nothing records nothing; an Asset a message still names does not go at all. That refusal is what stops a submitter pulling the evidence out from under a ticket, and no separate retention rule has to be remembered.
- A deferred `NO ACTION` rather than `RESTRICT`: the same refusal at a different moment, and the only one available. `RESTRICT` is checked the instant the referenced row goes and cannot be deferred, while deleting a Site reaches this table down two cascades in no fixed order. Checked at commit, a Site goes and a single attached Asset still does not.
- Attaching sets the Asset's `delivery_policy` to `5 = Internal`, so no address reaches it by its own id, whichever Space holds it. The only way to its bytes is `GET /api/site/threads/{threadId}/messages/{messageId}/assets/{assetId}`.
- Custody follows the uploader: a person attaches from their own User Space, an Add-on from its own Add-on Space. Attaching somebody else's file is refused.

### `phis.thread_reads`

- `thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `last_read_message_id INT NULL REFERENCES phis.thread_messages(id) ON DELETE SET NULL`
- `read_at TIMESTAMPTZ NULL`
- `PRIMARY KEY (thread_id, user_id)`

Contract:
- Read state is per user and per thread.
- Unread counts are derived by comparing `threads.last_message_id` (Staff) or `threads.last_public_message_id` (everyone else) against `last_read_message_id`. A read mark names a message of the same thread or none.
- This is sufficient for dashboard badges without a separate notification system in v1.

### `phis.site_thread_config`

- `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `requester_window_days SMALLINT NOT NULL DEFAULT 14`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `flags` are `PhisSiteThreadKindFlag`: `1 = Direct`, `2 = Group`, `4 = CrossGroup`, `8 = Support`.
- It is not a switch an administrator flips. It is materialized from what the Site's active Modules declare, the way declared Media Space kinds are: a Site gains a kind by running a Module that needs it.
- A kind that stops being declared hides its threads and deletes nothing; they return with the Module.
- `requester_window_days` is how long a resolved ticket waits for its requester before closing itself, and a ticket type may narrow or widen it. `0` switches automatic closing off for the Site.

### `phis.resource_links`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `thread_id INT NULL REFERENCES phis.threads(id) ON DELETE CASCADE`
- `ticket_id INT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `ticket_task_id INT NULL REFERENCES phis.support_ticket_tasks(id) ON DELETE CASCADE`
- `provider_id VARCHAR(255) NOT NULL`
- `type SMALLINT NOT NULL`
- `external_id VARCHAR(256) NOT NULL`
- `url TEXT NULL`
- `state SMALLINT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, provider_id, type, external_id)`

Contract:
- This is what `resource-links:v1` stores, and it replaces `support_ticket_links`. A ticket is no longer the only thing that may carry a reference.
- Exactly one of `thread_id`, `ticket_id`, or `ticket_task_id` is populated. The subject is a real reference rather than a kind and a bare integer: a polymorphic id has no foreign key, and a link whose subject is gone is a row nothing cleans up.
- `provider_id` is the Add-on that wrote the link and is the whole of the ownership rule: an Add-on reads and writes its own links and sees no others.
- `type` and `state` are the provider's own vocabulary -- an issue, a pull request, open, merged. Core stores and indexes both and interprets neither, as it does not interpret a role name.
- `flags` carry `1 = Synced`, which is also what lets that Add-on reach the subject's thread with no actor. Unlinking ends that reach, so a link that is only a pointer grants nothing.
- Writing a link needs an acting user: it is a person saying these two things belong together, and it is that consent the actorless reach rests on.
- A GitHub issue is linked to a ticket task rather than to the ticket, because one ticket may need several issues and resolving one does not resolve the Support work.

### `phis.support_tickets`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `type_id SMALLINT NOT NULL`
- `status SMALLINT NOT NULL DEFAULT 0`
- `channel SMALLINT NOT NULL`
- `priority SMALLINT NOT NULL DEFAULT 1`
- `severity SMALLINT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `requester_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `requester_email VARCHAR(320) NULL`
- `assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL`
- `allowance_grant_id INT NULL REFERENCES phis.support_allowance_grants(id) ON DELETE SET NULL`
- `thread_id INT NOT NULL`
- `subject VARCHAR(512) NOT NULL`
- `summary TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `first_response_due_at TIMESTAMPTZ NULL`
- `resolution_due_at TIMESTAMPTZ NULL`
- `last_public_message_at TIMESTAMPTZ NULL`
- `last_internal_message_at TIMESTAMPTZ NULL`
- `resolved_at TIMESTAMPTZ NULL`
- `delivered_at TIMESTAMPTZ NULL`
- `closed_at TIMESTAMPTZ NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (thread_id)`
- `FOREIGN KEY (thread_id, site_id) REFERENCES phis.threads (id, site_id)`
- `FOREIGN KEY (type_id, site_id) REFERENCES phis.support_ticket_types (id, site_id)`

Contract:
- Support tickets are Phi-owned workflow records and remain independent from GitHub issues or Medusa records.
- `requester_user_id` is optional so external email-only tickets can exist without a local account.
- `requester_email` may remain populated after `requester_user_id` becomes `NULL`; it is the only allowed lightweight requester fallback in the core ticket row.
- User deletion must not delete the ticket; all user references use `ON DELETE SET NULL`.
- Ticket-level `flags` are reserved for internal workflow/system bits, not for external-system ownership. They are `PhisSupportTicketFlag`: `AwaitingDelivery` (1) holds a resolved ticket's requester window until an integration that tracks releases says the fix is out (`support:v1.awaitDelivery`, `markDelivered`); `delivered_at` is when it said so, and the window counts from there. Any status move clears both, since a delivery belongs to one resolution.
- A ticket is the workflow record -- status, priority, assignment, tasks -- and everything anybody says about it is `thread_id`, the same thread model every other conversation on the Site uses. The ticket has exactly one, and it is not shared.
- `type_id` is the Site's own type, which decides whether the conversation may leave the Site and what ends the ticket.
- Cross-system relationships such as GitHub issues, PRs, Medusa orders, or CMS references belong in `resource_links`, not in dedicated columns on the ticket row. An issue is linked to a ticket task rather than to the ticket.
- `meta` is the free-form extension field for lightweight origin or UI context such as locale, path, or browser hints.
- `allowance_grant_id` is which granted stock this ticket came out of, or `NULL` for the type's periodic allowance. Not a flag: the id is what lets whoever handed the stock over say which requests it was spent on, and "was this a paid one" falls out of the same column.
- `status` moves on the ladder of `PhisSupportTicketStatus`, and part of the ladder moves by itself (`src/db/support-ticket-ladder.ts`): taking a `New` or `Triaged` ticket makes it `Assigned`, putting an `Assigned` one down makes it `Triaged` again, a move to another queue sends an `Assigned` or `InProgress` ticket back to `Triaged`, the first answer to the requester makes an `Assigned` ticket `InProgress`, and the requester answering a `WaitingCustomer` or `Resolved` ticket makes it `InProgress` (from `Resolved` recorded as a reopening). A status somebody sets wins over all of these.
- `resolved_at` and `closed_at` are written by the status move and never by a caller. Arriving at `Resolved` stamps `resolved_at` afresh, leaving it for anything short of `Closed` clears it, and `closed_at` is set only while the ticket is `Closed`.
- `last_public_message_at` and `last_internal_message_at` are set by the message write in the ticket's thread: a person's message the requester can read, and an `Internal` note, respectively. An integration's message sets neither.
- A `Resolved` ticket with a requester closes after the requester window passes in silence: the type's `requester_window_days`, else the Site's (`site_thread_config`), counted from `resolved_at`. A Site at `0` switches this off for every type, a type at `0` waits for a Supporter, and a ticket without a requester always does. The close needs nobody to run anything: every read derives it from one expression (`src/db/support-requester-window.mts`) and shows the ticket `Closed` as of the window's end, and every write that locks the ticket records it first -- so an answer after the window answers a closed ticket. `phis maintain` (`support-requester-window`) writes it down for tickets nobody touches again, at most 500 a run.

### `phis.support_ticket_tasks`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `type SMALLINT NOT NULL DEFAULT 0`
- `status SMALLINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `title VARCHAR(255) NOT NULL`
- `description TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `due_at TIMESTAMPTZ NULL`
- `completed_at TIMESTAMPTZ NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Tasks are internal work items attached to a support ticket and are distinct from the ticket's customer-facing lifecycle.
- One ticket may carry multiple tasks, and resolving a GitHub issue does not by itself resolve the support ticket. An external issue is linked to the task rather than to the ticket, which is what keeps that true.
- Tasks may be assigned independently from the ticket assignee.
- User deletion must not delete the task; user references become `NULL`.

### `phis.support_ticket_assignments`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `from_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `to_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `from_queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL`
- `to_queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL`
- `reason TEXT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Assignment rows are the audit trail for handoffs between users or queues.
- The current assignee lives on `support_tickets`; assignment rows preserve the history of changes.
- Queue or user deletion must not delete assignment history; nullable references fall back to `NULL`.

### `phis.support_ticket_events`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `event_type SMALLINT NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `payload JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Events are the structured audit stream for state changes such as `triaged`, `resolved`, `reopened`, `linked`, or task transitions.
- Messages and events are intentionally separate: not every event is a message, and not every message changes workflow state.
- User deletion must not delete the event row.

### `phis.tr_msg`

- `id SERIAL PRIMARY KEY`
- `msg TEXT NOT NULL`
- `msg_hash BYTEA NOT NULL`
- `ctx VARCHAR(128) NOT NULL DEFAULT ''`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (msg_hash, ctx)`

### `phis.tr_lang`

- `id SERIAL PRIMARY KEY`
- `msg_id INT NOT NULL REFERENCES phis.tr_msg(id) ON DELETE CASCADE`
- `locale VARCHAR(8) NOT NULL`
- `translation TEXT NOT NULL`
- `source_hash BYTEA NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (msg_id, locale)`
- partial index `(locale, source_hash) WHERE source_hash IS NOT NULL`

### `phis.tr_site_msg`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `msg TEXT NOT NULL`
- `msg_hash BYTEA NOT NULL`
- `ctx VARCHAR(128) NOT NULL DEFAULT ''`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, msg_hash, ctx)`

### `phis.tr_site_lang`

- `id SERIAL PRIMARY KEY`
- `msg_id INT NOT NULL REFERENCES phis.tr_site_msg(id) ON DELETE CASCADE`
- `locale VARCHAR(8) NOT NULL`
- `translation TEXT NOT NULL`
- `source_hash BYTEA NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (msg_id, locale)`
- partial index `(locale, source_hash) WHERE source_hash IS NOT NULL`

### `phis.tr_marker` and `phis.tr_site_marker`

- `tr_marker`: `scope VARCHAR(16) PRIMARY KEY CHECK (scope = 'global')`, `marker BIGINT NOT NULL`
- `tr_site_marker`: `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`,
  `marker BIGINT NOT NULL`
- values from `phis.tr_marker_seq`; a store nothing has changed yet has no row

Contract:
- Maintained only by statement-level triggers on `tr_lang` (global) and on `tr_site_lang` and
  `tr_site_msg` (per Site); application code never writes them. See [TRANSLATIONS.md](./TRANSLATIONS.md#change-markers).
- A transaction that ran `set_config('phis.translation_fill', 'on', true)` is skipped. Only the request
  path filling a missing translation may set it.
- Only equality of a marker means anything; it is not a count and not ordered.

### `phis.site_read_marker`

- `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`, `marker BIGINT NOT NULL`
- values from `phis.site_read_marker_seq`; a Site nothing was published for yet has no row

Contract:
- Maintained only by statement-level triggers (`phis.site_read_touch_markers()`): any update of the
  `sites` row; an inserted or deleted row of `site_page_scopes`, `site_area_scopes`, `site_nav_scopes` or
  `site_theme_scopes`; an update there only when `published_revision_id` changed, and for Pages also
  `path` or `tombstoned_at` -- all three of which only a publish writes. Draft pointers do not move it,
  and neither does a draft that marks a Page deleted. An inserted or deleted `site_auth_config` row moves
  it too, and an update there when `config` changed: the auth manifest a Site keeps is read from it.
  Application code never writes it.
- `GET /api/v1/site` carries it as `readMarker` (`"0"` without a row). A Site process refreshes its config
  at most every few seconds and empties its other read caches, Navigation among them, when it moved.
- Only equality of a marker means anything; it is not a count and not ordered.

### `phis.server_addons`

- `addon_id VARCHAR(255) PRIMARY KEY`
- `package_name VARCHAR(255) NOT NULL` (unique)
- `package_version VARCHAR(64) NOT NULL`
- `server_abi VARCHAR(64) NOT NULL`
- `migration_version SMALLINT NOT NULL DEFAULT 0` (CHECK `>= 0`)
- `manifest_digest CHAR(64) NOT NULL`
- `release_build_id VARCHAR(255) NOT NULL` (indexed)
- `schema_name VARCHAR(63) NULL` (CHECK `~ '^phis_addon_[a-z0-9_]+$'`, unique where not null)
- `flags INT NOT NULL DEFAULT 0`
- `installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `upgraded_at TIMESTAMPTZ NULL`
- `activated_at TIMESTAMPTZ NULL`
- `disabled_at TIMESTAMPTZ NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- One row per Add-on registered with the deployment. `phis addon reconcile` writes it from the desired
  state and the installed manifest; `flags & 1` is the deployment-wide enable switch.
- `schema_name` is the PostgreSQL schema holding the Add-on's tables, derived from the Add-on id once and
  recorded. The unique index makes the database refuse a second Add-on whose id derives to the same
  name. `NULL` means the Add-on owns no tables.
- `phis addon purge` removes the row together with the Add-on's Site rows, role grants, migration
  records, capabilities, secrets, schema, and Media Spaces; the Add-on's groups are retired, not deleted.
  The Add-on lifecycle is defined in [SERVER_ADDONS.md](./SERVER_ADDONS.md).

### `phis.server_capabilities`

- `provider_id VARCHAR(255) NOT NULL`
- `capability_id VARCHAR(255) NOT NULL` (unique)
- `interface_digest CHAR(64) NOT NULL`
- `release_build_id VARCHAR(255) NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (provider_id, capability_id)`

Contract:
- The registry of provided capabilities and their interface digests. `phis addon reconcile` rewrites the
  Core rows (`provider_id = '@phis/server/core'`) from `PHIS_CORE_CAPABILITIES` and each Add-on's rows from
  its manifest in the desired state. A capability id has exactly one provider.

### `phis.site_server_addons`

- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT`
- `flags INT NOT NULL DEFAULT 0`
- `configuration_status VARCHAR(32) NOT NULL DEFAULT 'missing'` (`missing`, `ready`, `invalid`)
- `configuration_version SMALLINT NOT NULL DEFAULT 0`
- `provider_account_reference VARCHAR(512) NULL`
- `effective_status VARCHAR(32) NOT NULL DEFAULT 'disabled'` (`available`, `missing`, `disabled`,
  `incompatible`, `misconfigured`, `unavailable`)
- `diagnostic_code VARCHAR(128) NULL`
- `configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `enabled_at TIMESTAMPTZ NULL`
- `disabled_at TIMESTAMPTZ NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `storage_quota_bytes BIGINT NULL`
- `storage_quota_objects INT NULL`
- `storage_used_bytes BIGINT NOT NULL DEFAULT 0`
- `storage_used_objects INT NOT NULL DEFAULT 0` (CHECK: both used counters non-negative)
- `PRIMARY KEY (site_id, addon_id)`; index on `addon_id`

Contract:
- One row per Site that has asked for an Add-on. `flags & 1` is the Site's enable request, written by
  `phis addon site`.
- `configuration_json` holds the Add-on's Site settings, written by `phis addon config`;
  `configuration_status` says whether they satisfy the manifest.
- An Add-on runs on a Site only when it is installed on the instance, enabled deployment-wide, requested
  by the Site, and configured. The capability snapshot derives that from its sources and does not read
  `effective_status`; `effective_status` and `diagnostic_code` are the diagnosis recorded by
  `phis addon reconcile` for operators.
- `storage_quota_bytes` and `storage_quota_objects` are the Core-enforced ceilings of the Add-on's object
  store on this Site (`NULL` is no ceiling), set with `phis addon storage`. The used columns are running
  totals maintained by the writes, not counted on demand.

### `phis.site_addon_user_roles`

- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `role VARCHAR(120) NOT NULL` (CHECK `role <> ''`)
- `granted_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (site_id, addon_id, user_id, role)`; index on `(site_id, user_id)`

Contract:
- One row grants one named Add-on role to one user on one Site. The role vocabulary is declared in the
  Add-on manifest ([SERVER_ADDONS.md](./SERVER_ADDONS.md)); Core stores and answers with the names and never
  interprets them.
- `role` is text, not a foreign key: the manifest is the only catalog. A grant naming a role the current
  manifest no longer declares is reported, never deleted by Core.
- Re-granting keeps the first grant's `granted_by_user_id` and `granted_at`.
- Access checks read these rows through the `addon-roles` access policy defined in
  [AUTHORIZATION.md](./AUTHORIZATION.md).

### `phis.server_addon_migrations`

- `addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT`
- `migration_version SMALLINT NOT NULL` (CHECK `> 0`)
- `migration_id VARCHAR(255) NOT NULL`
- `checksum CHAR(64) NOT NULL`
- `release_build_id VARCHAR(255) NOT NULL`
- `applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (addon_id, migration_version)`

Contract:
- One row per applied Add-on schema version (`migration_id` is `schema-v<version>`), written by
  `phis addon migrate`. Reapplying the same version with the same checksum is a no-op; the same version
  with a different checksum, or a different version, is refused, and the remedy is a purge.

### `phis.addon_hook_deliveries`

- `addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE`
- `delivery_id VARCHAR(255) NOT NULL` (CHECK `<> ''`)
- `received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (addon_id, delivery_id)`
- index on `received_at`

Contract:
- One row per signed hook delivery Core has accepted, written by the dispatcher **after** the signature
  verified and **before** the handler runs. A sender retrying a delivery it is unsure about carries the
  first attempt's id; recognising it here is what keeps one webhook from becoming two messages in a
  thread, and it is done once for every Add-on rather than in each handler.
- The insert is the claim. Two instances handed the same retry both reach the statement and exactly one
  inserts, which is the primary key's answer and not a read followed by a write.
- Only a hook whose descriptor states `verification.deliveryIdHeader` produces rows. No Site column: a
  delivery id is the sender's and is unique in their system, not per Site.
- `phis maintain` (`hook-deliveries`) drops rows older than 30 days -- far past any sender's retry
  window, because the cost of holding one too long is a row and the cost of dropping one too early is a
  duplicate that will look like the Add-on's fault.

## Payment execution

The creation script declares all Payment/outbox columns and constraints directly. As with other v1
Core structural changes, reapplying `001_create_phis.pgsql` does not upgrade existing table columns;
the workspace development database was updated explicitly for this work. On 2026-10-04, the separate
`phis_dev` database behind the compiled Phisys installation also received the Payment tables and an
explicit transactional outbox update, preserving existing thread rows. Coordinate an existing
installation's outbox update before admitting Payment consumers.

Runtime queries live in `src/db/payments.mts`; the same typed functions serve the Core engine and
operator CLI. `PAYMENTS.md` specifies ownership, grants, financial semantics and read-only recovery.
Every money value in a public record is a canonical minor-unit integer string. JSON records below
contain only their corresponding `PhisPayment*` type; Provider credentials, card data and raw webhook
bodies are never stored here. V1 admits redirect checkout; encrypted Provider UI parameters are not
implemented or accepted. Financial records restrict deletion of their Site, consumer and profile;
there is no product purge command. Fixture teardown in database tests is not an administrative API.

### `phis.payment_profiles`

- `(site_id SMALLINT REFERENCES phis.sites ON DELETE RESTRICT, key VARCHAR(64))` primary key;
  the key is lowercase alphanumeric with `.`, `_`, `-`, bounded to 64 characters.
- `provider_addon_id VARCHAR(255) REFERENCES phis.server_addons ON DELETE RESTRICT`.
- `draft JSONB`: `PhisPaymentProfileDraft`, containing the immutable provider key/mode, credential
  references and consumer grants/action policies; no secret values.
- `merchant_identity VARCHAR(255) NULL`, `revision INT NOT NULL DEFAULT 1 CHECK (> 0)`.
- `enabled BOOLEAN NOT NULL DEFAULT FALSE`, `retired BOOLEAN NOT NULL DEFAULT FALSE`.
- `probed_at TIMESTAMPTZ NULL`, `methods JSONB NULL`: the last validated Provider method/features probe.
- Enabling requires a pinned identity, successful probe and non-retired profile. CLI enabling also
  verifies the registered/enabled Provider and matching artifacts/capabilities on ready instances.
- Profile writes increment the revision, clear the probe/methods and disable new creation. They cannot
  replace the provider/mode or reuse a retired key. A new identity discovered after credential rotation
  is refused; existing payment bindings are never migrated. Retirement preserves existing reads and
  remote reconciliation while the Provider remains enabled.

### `phis.payments`

- `id UUID PRIMARY KEY`, `site_id SMALLINT REFERENCES phis.sites ON DELETE RESTRICT`.
- `consumer_addon_id VARCHAR(255) REFERENCES phis.server_addons ON DELETE RESTRICT`.
- `profile_key VARCHAR(64)`, composite FK `(site_id, profile_key)` to `payment_profiles`, `ON DELETE RESTRICT`.
- `provider_key VARCHAR(255)`, `merchant_identity VARCHAR(255)`, `profile_revision INT CHECK (> 0)`:
  immutable payment execution binding; current credentials may rotate within that binding.
- `currency_exponent SMALLINT CHECK (BETWEEN 0 AND 4)`, `method_features JSONB NOT NULL`:
  validated ISO exponent and the selected method's agreed features.
- `binding JSONB NULL`: `PhisPaymentProviderBinding`, server-only remote references/correlation.
- `record JSONB NOT NULL`: `PhisPayment`; identity matches `id`, agreed minor amount is positive and
  bounded, captured amount cannot exceed it, and successful refunds cannot exceed captured funds.
- `generation BIGINT NOT NULL DEFAULT 0`, `lease_token UUID NULL`, `lease_until TIMESTAMPTZ NULL`:
  a bounded execution/observation claim. Token/time are either both present or both absent.
- `created_at`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
- Unique `(site_id, consumer_addon_id, id)` supports scoped operation FKs. A partial unique index on
  `(site_id, profile_key, binding->>'reference')` prevents sharing one established remote binding.
- The unique active-reference index covers `(site_id, consumer_addon_id, record->>'reference')`
  while the payment is nonterminal or reconciliation is required. Captured/refunded payments retain
  the reference; a confirmed failed/expired/canceled attempt permits a new explicit attempt.
- Reservations and claim changes lock this row. No transaction spans a PSP call. Applying a result
  checks generation/token under the same lock; a superseded response cannot overwrite newer facts.
  Public facts/operation/refund changes increment the record's version and enqueue one owner event.
  Updating `lastObservedAt` alone emits no event. Confirmed capture/refund facts cannot regress.

### `phis.payment_operations`

- `id UUID PRIMARY KEY`, `payment_id UUID REFERENCES phis.payments ON DELETE RESTRICT`.
- `site_id SMALLINT`, `consumer_addon_id VARCHAR(255)`; composite ownership FK to `payments`, `ON DELETE RESTRICT`.
- `action VARCHAR(16) CHECK IN (create, complete, capture, cancel, refund)`, `idempotency_key VARCHAR(255)`.
- `request JSONB`: canonical consumer arguments; `command JSONB`: exact Provider command, including
  stable provider idempotency key and canonical callback URLs, excluding the transient AbortSignal.
- `record JSONB`: `PhisPaymentOperation`; checked state `reserved`, `pending`, `succeeded`, `failed`,
  or `indeterminate`. `first_possible_submission_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` precedes HTTP.
- Unique `(site_id, consumer_addon_id, action, idempotency_key)`; a changed canonical request conflicts.
  Unresolved operations have a partial index on `payment_id`.
- A live claim returns the existing reservation; an expired/resumed claim uses Provider `recover`,
  never a new financial execution. Unknown outcomes retain amount reservations and block conflicting
  commands. Time passing never proves an operation failed.

### `phis.payment_refunds`

- `id UUID PRIMARY KEY`, `payment_id UUID REFERENCES phis.payments ON DELETE RESTRICT`.
- `operation_id UUID NULL UNIQUE REFERENCES phis.payment_operations ON DELETE RESTRICT`.
- `remote_reference VARCHAR(255) NULL`, `binding JSONB NULL`, `record JSONB NOT NULL` (`PhisPaymentRefund`).
- Unique `(payment_id, remote_reference)` preserves one identity for each remote refund.
- Amount is positive and bounded; status is `pending`, `succeeded`, `failed` or `canceled`.
- A local reservation has its operation id and no remote binding until confirmed. An observed external
  refund has no local operation and receives a stable Core identity. Pending/indeterminate local
  refunds reserve their amount; only confirmed success increments `refundedMinor`. Failure/cancellation
  releases a reservation. Observation must include every previously bound refund, not a partial list.

### `phis.payment_notification_receipts`

- Primary key `(site_id SMALLINT, profile_key VARCHAR(64), delivery_id VARCHAR(255))`.
- `payment_id UUID REFERENCES phis.payments ON DELETE RESTRICT`; composite profile FK `ON DELETE RESTRICT`.
- `processed BOOLEAN NOT NULL DEFAULT FALSE`, `claim_token UUID NOT NULL`, `claim_until TIMESTAMPTZ NOT NULL`.
- `processed_at TIMESTAMPTZ NULL`.
- Only authenticated Provider delivery ids enter this inbox. A live competing claim is unavailable,
  never a completed duplicate; an expired claim can be reacquired. Final commit requires the receipt
  token and atomically writes payment/refunds/operations, owner outbox and processed receipt. Failure
  leaves the receipt retryable. Raw payloads/signatures are not retained. Lookup-only providers use
  authenticated current-state reconciliation without inventing a signed delivery id.

### `phis.addon_event_outbox`

- `id BIGSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE`
- `event VARCHAR(120) NOT NULL` (CHECK `<> ''`)
- `thread_id INT NULL REFERENCES phis.threads(id) ON DELETE CASCADE`
- `subject_kind VARCHAR(16) NOT NULL DEFAULT 'thread'`
- `payment_id UUID NULL REFERENCES phis.payments(id) ON DELETE RESTRICT`
- `payload JSONB NOT NULL DEFAULT '{}'::jsonb`
- `attempts SMALLINT NOT NULL DEFAULT 0`
- `last_error TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `delivered_at TIMESTAMPTZ NULL`
- partial index `(addon_id, site_id, id) WHERE delivered_at IS NULL`
- `addon_event_outbox_subject_check`: a thread subject has exactly `thread_id` and a thread event;
  a payment subject has exactly `payment_id` and `payment.changed`.

Payment recipients are the stored consuming Add-on, including while it is inactive; there is no
thread link or broadcast. Payload contains payment/reference/version and nullable operation/refund
ids. Delivery checks the owning Add-on's current declaration and activation. The consumer's handler
runs with its declared event identity; merchant actions additionally require its profile policy.
The payment version/state/refunds and this event are committed atomically, independently of consumer
fulfilment. The existing ordered request/operator-driven drain delivers both subject kinds.

Thread contract:
- What Core owes an Add-on about a thread, written in the transaction that caused it
  (`src/db/addon-events.ts`) and dispatched after the commit (`src/lib/addons/event-delivery.ts`).
  Telling an integration from inside the request would tie a person's reply to a third party being
  reachable; telling it before the commit would announce something that may still roll back.
- **Recipients are the synced links and nothing else.** The insert selects the Add-ons holding a
  `resource_links` row with `Synced` on that thread, its ticket, or its ticket task -- the same
  predicate that decides whether an actorless Add-on may read the thread, asked in the other direction.
  Delivering to every Add-on that merely declares the event would be the Site-wide listing `threads:v1`
  refuses, arriving by push instead of by pull.
- The insert joins `site_server_addons` and requires the Add-on to be requested-enabled and `ready`.
  That also keeps the foreign key satisfiable: a link's `provider_id` is free text with a shape, and a
  violation here would roll back the message that caused it.
- **No echo.** The author is excluded, so a message an integration imported is never handed back to it.
- `thread.link.removed` is the exception and is enqueued by name, before the delete, because a moment
  later the link that would have selected it is gone.
- Ordering is by `id`, not by `created_at`: two events in one transaction share a timestamp, and an
  integration applying them out of order would leave the older state as the current one. Delivery stops
  at the first failure for that Add-on and Site.
- There is no attempt ceiling. A row nobody can deliver is a row an operator should see; what removes it
  is the link or the thread going away, which takes it by cascade. `phis addon job run` drains what is
  owed before the job it was asked for.

### `phis.server_secrets`

- `reference VARCHAR(512) PRIMARY KEY`
- `site_id SMALLINT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `addon_id VARCHAR(255) NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE`
- `key_version SMALLINT NOT NULL DEFAULT 1` (CHECK `> 0`)
- `ciphertext TEXT NOT NULL` (hex)
- `iv CHAR(24) NOT NULL` (hex)
- `auth_tag CHAR(32) NOT NULL` (hex)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- partial indexes on `site_id` and on `addon_id`

Contract:
- Every secret the server holds, encrypted, so every instance reads the same store. The decryption key is
  not in the database: it is `secrets.encryptionKey` in each instance's runtime configuration, and
  `key_version` records which key version encrypted the row.
- `reference` is the secret's readable name, for example `core:smtp-password`,
  `site:acme:core:smtp-password`, or `site:acme:addon:@phis/storage-s3:secret-access-key`
  (`src/lib/secrets/reference.ts`). `site_id` and `addon_id` are derived from the reference on write,
  so deleting a Site or an Add-on removes its secrets.
- Secrets are managed with `phis secret`.

### `phis.server_instances`

- `instance_id VARCHAR(255) PRIMARY KEY`
- `release_build_id VARCHAR(255) NOT NULL`
- `addon_manifest_digest CHAR(64) NOT NULL`
- `addon_packages_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `capability_digests_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `flags INT NOT NULL DEFAULT 0`
- `last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- index on `(release_build_id, (flags & 1) <> 0, last_seen_at DESC)`

Contract:
- Each serving instance reports what it holds: its release build, Add-on manifest digest, installed
  Add-on package versions, and capability interface digests. The row is a self-report, never a poll.
- `flags & 1` is readiness. A draining instance clears it and keeps its row; a reader treats an instance
  as ready only when the bit is set and `last_seen_at` is recent, because a killed instance keeps the bit.
- A report under an existing id refreshes the row and keeps `started_at`. `phis instance list` reads the table.

### `phis.notification_outbox`

- `id BIGSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `provider_id VARCHAR(255) NOT NULL DEFAULT '@phis/server/core'`
- `occasion VARCHAR(120) NOT NULL` (CHECK `<> ''`)
- `flags SMALLINT NOT NULL DEFAULT 0`
- `recipient_user_id INT NULL`
- `recipient_address VARCHAR(320) NULL`
- `locale VARCHAR(35) NULL`
- `params JSONB NOT NULL DEFAULT '{}'::jsonb`
- `dedupe_key VARCHAR(200) NULL`
- `attempts SMALLINT NOT NULL DEFAULT 0`
- `next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_error TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `sent_at TIMESTAMPTZ NULL`
- `message_id VARCHAR(255) NULL`
- CHECK exactly one of `recipient_user_id` / `recipient_address`
- CHECK `locale` is present whenever `recipient_address` is
- composite foreign key `(recipient_user_id, site_id)` to `user_site_memberships (user_id, site_id)`
  `ON DELETE CASCADE`
- partial index `(site_id, next_attempt_at, id) WHERE sent_at IS NULL AND (flags & 2) = 0`
- partial unique index `(site_id, dedupe_key) WHERE dedupe_key IS NOT NULL`

Contract:
- Every message Core sends is written here first, and nothing sends without a row. There is one path:
  a password reset goes through it exactly as a circular does, which is what gives the reset the retry
  it never had. The request that wrote the row attempts it once itself; `phis maintain` drains what that
  attempt left. The division is `addon_event_outbox`'s and so is the reason -- telling somebody from
  inside the request ties the answer to a transport being reachable.
- **The recipient is an id wherever one exists**, and the address is resolved at drain time. A corrected
  address is therefore used, and a membership that is gone sends nothing instead of writing to a stale
  copy. `recipient_address` is only for messages that precede an account, where there is no membership
  to point at. Carrying both recipient forms at once is refused by CHECK.
- `flags & 1` means the message was **sent** rather than asked for: consent decided whether the row was
  written at all, and the rendered mail owes an unsubscribe footer. A message the person's own action
  asked for carries no such footer, because offering to withdraw what cannot be withdrawn is the
  misrepresentation `design/CONSENT.md` documents for banners.
- `flags & 2` means the row was **settled without being sent**: by the time it was due, the consent it
  needed had been withdrawn. That is the expected outcome of somebody unsubscribing between the enqueue and
  the drain, not a delivery failure, and conflating the two would make an operator chase a broken address
  that never existed. A dropped row is never claimed again, which is why the flag is in the index
  predicate as well as in the claim.
- `locale` is the language the message is written in, and it outranks the profile. An address has no
  profile to ask and therefore must carry one, which CHECK enforces; beside an account it is optional,
  because there really are two answers -- what somebody chose once, and what language they are reading
  now. Somebody half-way through a reset on the German Site gets a German mail whatever their profile
  says. Empty falls to the profile, then to the Site's default.
- `provider_id` is who declared the occasion and therefore whose words render it -- `@phis/server/core`
  today, an Add-on id once a notification capability exists. Same convention as
  `server_capabilities.provider_id`.
- `dedupe_key` is what makes a repeated run safe: the second run's inserts are refused per row by the
  partial unique index rather than by a count somebody keeps. A caller that names no key gets no
  protection, which is right for a message a person just triggered.
- `attempts` and `next_attempt_at` are the retry; `parseSmtpTargets` failover inside one attempt is not
  one and must not grow into one.
- **`params` is emptied once the row is settled** -- on send, and on the attempt that reaches the ceiling.
  Some parameters are secrets: a reset link carries a token whose whole point is that only its `sha256` is
  kept, and leaving the plain value here would undo that for as long as the row lives. It is here while the
  message is owed, which is minutes, and gone afterwards; `registration_intents` blanks its personal
  fields on consume for the same reason. What stays is who, when, which occasion, and `message_id`.

### `phis.notification_link_salts`

- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `link_salt CHAR(32) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_used_at TIMESTAMPTZ NULL`
- PRIMARY KEY `(user_id, site_id)`
- composite foreign key `(user_id, site_id)` to `user_site_memberships (user_id, site_id)`
  `ON DELETE CASCADE`

Contract:
- The public half of the unsubscribe link carried in every circular. The link is a signature over the
  recipient and this salt; the key that signs it is `notifications.linkSecret` in the runtime config and
  stays out of the database. **Nothing here is secret** -- the salt alone proves nothing.
- **The link does not expire and is not consumed**, unlike `user_password_reset_tokens`. It sits in an
  archived mail, where a dead link is a dead link against an obligation (Art. 21 GDPR, § 7 UWG), and the
  act it authorises is idempotent. This is also why the other tokens' shape does not fit: a stored hash
  cannot be read back, so a durable link could never be rendered a second time.
- One row per membership rather than one per message -- the difference between growing with the audience
  and growing with every send. `last_used_at` moves on every use, because a second click is not an error.
- Acting on a link clears `USER_SITE_FLAG_NEWSLETTER_OPT_IN` for that membership and does nothing else: no
  session, no other Site, no profile. `GET` must not act -- mail clients and scanners fetch links before a
  person sees them -- so `GET` offers the button and `POST` performs it, which is what RFC 8058 one-click
  requires as well.
- Rotation for one person replaces the salt; rotation for everybody rotates the key and invalidates every
  link still in a mailbox. A link whose membership is gone finds no row and says so rather than reporting
  success.

## Content and Translation Model

- The global `tr_*` tables hold Core text, package and preset text, and global label sets that are not tied to any Site.
- Site-facing content uses `tr_site_*` and must be isolated per site.
- `tr_site_msg` is a translation anchor table, not a full content table.
- `tr_site_lang` stores translated variants for a site-specific source message. A non-null
  `source_hash` marks an exact, protected external-source variant; ordinary editable translations use
  `NULL`.
- `tr_site_*` carries `site_id` isolation at the message level so different Sites can safely reuse the
  same canonical source text and context values even when their immutable source locales differ.

Recommended structure:

- `sites`
  - technical site registry with integer `id` and stable `key`
- `site_content`
  - one row per content entity
  - includes fields such as `site_id`, `type`, `slug`, `status`, `current_version_id`, `published_version_id`, `published_at`, and `sort_order`
- `site_content_versions`
  - one row per content version
  - carries version-scoped metadata and authoring history
- `site_content_version_text`
  - one row per translated content field on a specific version
  - links `version_id` and `field_name` to a `msg_id` in `tr_site_msg`

Example usage:

- a `news` entry lives in `site_content`
- its concrete editorial state lives in `site_content_versions`
- its `title`, `subtitle`, and `content` live as separate rows in `site_content_version_text`
- each of those rows points to one `tr_site_msg` row containing the canonical Site-source text
- translated output is resolved through `tr_site_lang`
- an `asset` entry lives in `site_content`
- the `asset_id` of each of its versions points to `media_assets`
- its `title`, `alt`, and `caption` live as separate rows in `site_content_version_text`

Design decision:

- keep `tr_site_msg` small and focused on source text plus translation identity
- keep business fields such as `type`, `slug`, publish state, and ordering in dedicated content tables
- use `ctx` consistently per entity field
- for content entities, stable structural keys are acceptable, for example `news:42:title`, `news:42:subtitle`, `blog:17:body`
- for human-facing translated copy that benefits from better translation context, prefer short natural-language context phrases over machine-style keys
- examples for email/template translation context:
  - `registration verification email subject`
  - `registration verification email body`
  - `registration welcome email subject`
  - `registration welcome email body`
- prefer natural-language context phrases when DeepL translation quality is the priority; use machine-like keys only where storage/disambiguation is the main concern
- global canonical source remains English; each Site has one immutable configured source locale
