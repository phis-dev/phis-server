# Database Model

This document contains the database-facing contract for `phis`.
It covers the target PostgreSQL schema, table-level contracts, and the site/global translation model.

Before v1, `scripts/sql/001_create_phis.pgsql` is the only Core schema source of truth. ABI-breaking
changes are integrated there directly and the development database is recreated or adjusted in place;
there are no incremental Core migration scripts.

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
- `phis.site_content.asset_id INT`
  - site-owned asset content rows reference the canonical `media_assets.id`
  - type `asset` rows must set this column
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
- `phis` CMS revision payload `contentWidgets[].contentId`
  - direct reference to the canonical `site_content` row consumed by the widget
  - widget ownership remains site-local and must be validated against the referenced content site
- `phis.sites.flags INT`
  - `1 << 0 = active`
- `phis` CMS revision payload `flags`
  - `1 << 0 = site_custom`
  - `1 << 1 = hidden`
  - `1 << 4 = collapsed`
- `phis` CMS revision payload `viewportFlags SMALLINT`
  - `0 = unrestricted`
  - `1 << 0 = compact`
  - `1 << 1 = medium`
  - `1 << 2 = wide`
  - canonical persisted values are `0..6`; `7` normalizes to `0`
- `phis` CMS revision payload `contentWidgets[].flags`
  - `1 << 5 = no_translate`
- `phis` CMS revision payload `visibilityMask`
  - `1 << 0 = public_area`
  - `1 << 1 = app_area`
  - `1 << 3 = admin_area`
  - `1 << 4 = editor_area`
  - `1 << 5 = dev_area`
  - `1 << 6 = accounting_area`
  - `1 << 8 = builder_area`
- `phis` CMS revision flags
  - `1 << 0 = draft`
  - `1 << 1 = published`
  - `1 << 2 = deleted` for page revisions whose payload marks the page as deleted
- `phis.site_nav_scopes.flags INT`
  - reserved for future set-level switches
- `phis.user_accounts.flags INT`
  - `1 << 0 = terms accepted`
- `phis.user_site_role_claims.role_flags INT`
  - site- and provider-scoped role matrix governed by `AUTHORIZATION.md`
- `phis.user_site_memberships.user_site_flags INT`
  - `1 << 0 = disabled`
  - `1 << 1 = newsletter opt-in`

### `phis.sites`

- `id SMALLSERIAL PRIMARY KEY`
- `key VARCHAR(64) NOT NULL UNIQUE`
- `name VARCHAR(128) NOT NULL`
- `hostname VARCHAR(255) NOT NULL UNIQUE`
- `default_locale VARCHAR(8) NOT NULL DEFAULT 'en'`
- `available_locales VARCHAR(8)[] NOT NULL DEFAULT ARRAY['en']::VARCHAR(8)[]`
- `flags INT NOT NULL DEFAULT 0`
- `next_node_sequence BIGINT NOT NULL DEFAULT 1`
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
- `sites` stores the complete site-wide runtime and business configuration, including canonical hostname, available locales, public URL, mail identity, commerce handoff values, and form guard secret.
- `theme` stores public-facing presentation configuration only, such as fonts, shell options, and a constrained Ant Design token/component projection.
- `theme` must not become a raw dump of arbitrary `ConfigProvider` state; it is a site-owned theme contract that the frontends map into Ant Design.
- `theme` must not hold widget-instance configuration. Widget config belongs to widget rows in the CMS tables.
- A first valid shape is:
  - `fonts.body`
- `fonts.mono`
- `shell.header.*`
- `shell.sider.*`
- `shell.footer.*`
- `antd.token`
- `antd.components`
- The old 1:1 `site_config` shape is retired.
- Public translation requests remain disabled by default. `translation.allowPublicReads` controls CDN-backed public reads, while `translation.allowPublicWrites` stays `false` unless a controlled public seed/import window is explicitly enabled.

### Media Spaces, Folders, and Storage

The normative schema and behavior for general Site groups, Media Spaces, folders, quotas, Storage
Profiles, Assets, variants, uploads, and delivery is defined only in
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md). The sections below describe the implemented baseline
tables; where they and the contract document disagree, the contract document wins.

The pre-P0 `media_groups` table, the global `local | s3` Storage switch, the per-asset
`storage_provider` / `storage_bucket` / `public_url` columns, and the `flags`-based visibility model are
retired. They exist neither in `scripts/sql/001_create_phis.pgsql` nor in the typed `src/db/` layer, and
must not be reintroduced as a compatibility path.

- `sites.theme.brand.logoAssetId` is the canonical brand-logo reference when a site uploads a logo through the media library.
- `sites.theme.brand.logoUrl` is a runtime projection of the referenced media asset and should not be treated as the canonical source of truth.
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
- `UNIQUE (site_id, key)` and `UNIQUE (id, site_id)`

Contract:
- One profile is one concrete, operator-configured Storage target for one Site.
- `provider_id` is a namespaced service-provider id such as `@phis/server/storage-local` and is validated against the manifest-declared provider registry; an unavailable provider fails closed.
- `secret_reference` names a runtime-config secret. Credentials never live in this row, in Site administration, or in any browser payload.
- Every Asset and every generated variant binds to a concrete profile. There is no global Storage switch and no persisted canonical public URL.

### `phis.media_spaces`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `kind SMALLINT NOT NULL`
- `user_id INT NULL` (composite FK to `user_site_memberships`)
- `group_id INT NULL` (composite FK to `site_groups`)
- `default_storage_profile_id INT NOT NULL` (composite FK to `media_storage_profiles`)
- `quota_bytes BIGINT NULL`
- `used_bytes BIGINT NOT NULL DEFAULT 0`
- `reserved_bytes BIGINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (id, site_id)`

Contract:
- `kind` is the closed owner contract: `1 = site`, `2 = user`, `3 = group`. A CHECK constraint enforces that exactly the matching owner column is set.
- A Site has at most one Site Space, one Space per member, and one Space per group; partial unique indexes enforce that.
- The Site Space owns Site presentation, CMS content, theme, and published download Assets. CMS, Builder, Editor, and `phis:asset` resolution are pinned to it.
- `quota_bytes` is an explicit Space-level override. `NULL` inherits the Site default from `site_media_config` per [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md) section 7; what an absent Site default itself means is not defined by the contract yet. `used_bytes` is committed usage and `reserved_bytes` is in-flight upload reservation; both are non-negative.
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
- `flags INT NOT NULL DEFAULT 0`
- `max_object_bytes BIGINT NOT NULL DEFAULT 26214400`
- `allowed_content_types VARCHAR(160)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(160)[]`
- `allowed_storage_profile_ids INT[] NOT NULL DEFAULT ARRAY[]::INT[]`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Site-level media policy applied when a Space is resolved and when an upload is initialized.
- `flags` carries Space availability per `PhiSiteMediaFlags`: `1 << 0` User Spaces, `1 << 1` Group Spaces. Availability is a capability and is deliberately separate from quota, so an unavailable Space kind is rejected as `space_kind_unavailable` rather than as an exhausted quota. The default `0` makes default-deny structural: a Site that was never configured grants no User or Group Space, and the Site Space is never governed by these flags.
- `flags` is materialized, not administered. It is recomputed when an Area is published, as the union of `preset.config.mediaSpaceKinds` across every published Area of the Site, and nothing else writes it -- neither the administration route nor the installation configuration. See `GROUPS_AND_STORAGE.md` section 7.
- `default_user_quota_bytes` and `default_group_quota_bytes` are inherited live by every Space of that kind whose own `quota_bytes` is `NULL`, so changing a default moves all non-overridden Spaces. A Space-level `0` is an explicit revocation, and lowering a limit below current usage blocks new reservations without deleting or hiding an Asset.
- The row is materialized once from the versioned `media.defaults.*` installation defaults in `config/phis-config.json`, which seed capacity only. After that the row is authoritative and there is no request-time fallback to configuration, so raising an installation default never widens an existing Site.
- An empty `allowed_content_types` or `allowed_storage_profile_ids` array means "no additional restriction beyond the operator-level profile state", not "nothing allowed".

### `phis.media_assets`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `space_id INT NOT NULL` (composite FK to `media_spaces`)
- `folder_id INT NULL` (composite FK to `media_folders`, `ON DELETE SET NULL`)
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
- `checksum_sha256 CHAR(64) NULL`
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
- `UNIQUE (storage_profile_id, storage_key)`

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
- `presentation_flags` carries non-security display properties only, per `PhiMediaAssetFlags`. It never influences delivery or authorization.
- Image variants inherit the lifecycle and delivery policy of their original; `variant_key` selects the rendition shape and `variant_version` is only the technical cache-buster.
- `next/image` optimization is the canonical path for `public` Assets only; every other delivery policy is treated as `unoptimized` in the browser-facing contract.
- `blur_data_url` is an optional preview placeholder that can be generated for image assets and reused by remote `next/image` renderers.
- `meta` is a generic JSONB extension point for asset-specific metadata. v1 starts with image focus data under `meta.image.focus.x` and `meta.image.focus.y`, both normalized to the `0..1` range. Later image regions and other asset-type metadata may reuse the same field under their own namespaced keys.
- `content_type` is still stored as the exact MIME type, but the stable v1 media-kind filter contract should use these UX classes:
  - `image` for `image/*`
  - `video` for `video/*`
  - `audio` for `audio/*`
  - `pdf` for `application/pdf`
  - `markdown` for `text/markdown`
  - `document` for Office/text-document MIME families such as `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/rtf`, `text/plain`, and `application/vnd.oasis.opendocument.text`
  - `archive` for archive MIME families such as `application/zip`, `application/x-7z-compressed`, `application/x-rar-compressed`, and `application/x-tar`
  - `other` for anything that does not fit the above classes
- List consumers must not read the media library unbounded. The public `GET /api/site/media` contract is paginated and requires `page` plus `pageSize`; detail reads belong on `GET /api/site/media/:id`.
- The list contract may additionally filter by `since`, `until`, `folderId`, `kind`, `presentationFlags`, `query`, and `sort`.
- `sort` is currently limited to `created_at_desc`.
- The canonical "last 100 images" use-case is `page=1&pageSize=100` with `sort=created_at_desc`.
- `since` and `until` filter by `created_at` in the Space-scoped media library.
- The list query stays index-backed by `(space_id, folder_id, created_at DESC, id DESC)`; the accessible Space is resolved once per request, never once per Asset.
- Duplicate / comparison lookups use `(space_id, checksum_sha256)` with a partial `WHERE checksum_sha256 IS NOT NULL` index, so observable duplicate detection is scoped to one Space.
- The list response should expose `pagination.total` so previewers and pagers can render accurate counts without loading the whole library.
- Deleting a media asset must remove its owned `site_content(type=asset)` wrapper rows, but must be rejected while any widget/layout/page/area/navigation tree still references that content or asset.
- The delete guard reads the maintained `site_cms_references` index rather than scanning revision JSON.

### `phis.media_upload_sessions`

- `token VARCHAR(128) PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `actor_user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `space_id INT NOT NULL` (composite FK to `media_spaces`)
- `folder_id INT NULL` (composite FK to `media_folders`, `ON DELETE SET NULL`)
- `storage_profile_id INT NOT NULL` (composite FK to `media_storage_profiles`)
- `status SMALLINT NOT NULL`
- `filename VARCHAR(255) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `size_bytes BIGINT NOT NULL`
- `kind VARCHAR(16) NOT NULL`
- `checksum_sha256 CHAR(64) NULL`
- `meta JSONB NULL`
- `presentation_flags INT NOT NULL DEFAULT 0`
- `upload_plan_kind SMALLINT NOT NULL DEFAULT 1` (CHECK `IN (1, 2)`)
- `staging_storage_key VARCHAR(512) NOT NULL`
- `final_storage_key VARCHAR(512) NULL`
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
- `kind` reuses the existing `PhiMediaKind` contract from `phi-server` and `phi-shared-ui`.
- `staging_storage_key` points to the staging object inside the bound profile; `final_storage_key` is the target key after finalize.
- `checksum_sha256` is available for integrity and duplicate/comparison logic.
- Finalize verifies the stored object before the Asset reaches `ready` and commits the quota reservation.
- Successful finalize deletes the session row. Failed and expired uploads delete it as well, release the reservation, and clean staging objects; retries must request a fresh token.
- `expires_at` is indexed so stale sessions can be cleaned up efficiently; `(space_id, status)` and `actor_user_id` are indexed for operational lookups.
- The browser-facing contract is `POST /api/site/media/uploads/init`, `POST /api/site/media/uploads/:token/finalize`, and whatever the issued plan names for the body itself; no multipart parser is involved in the large-file path.
- `upload_plan_kind` records which plan init issued: `1 = proxy-stream` (the body streams through `PUT /api/site/media/uploads/:token`), `2 = presigned-put` (the Provider takes the body directly). It is a property of the session rather than of the Storage Profile, because a Provider may answer differently for different bodies. It decides two things no later request can work out on its own: whether Core may receive this body at all, and whether "the body arrived" is a status Core set itself or something only the stored object can attest.
- Duplicate detection and the size check happen at finalize, where every plan passes, rather than at the transport that happened to carry the body.

### `phis.image_asset_variants`

- `PRIMARY KEY (asset_id, variant_key)`
- `asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE CASCADE`
- `variant_key SMALLINT NOT NULL`
- `storage_profile_id INT NOT NULL REFERENCES phis.media_storage_profiles(id)`
- `storage_key VARCHAR(512) NOT NULL`
- `content_type VARCHAR(128) NOT NULL`
- `bytes BIGINT NULL`
- `checksum_sha256 CHAR(64) NULL`
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
- Variant requests for non-image media kinds return a fixed SVG preview icon and must not create `phis.image_asset_variants` rows.

### Locale Capability Contract

- Locale support is two-level:
  - `phi-server` defines the platform-wide locale capability superset.
  - each site defines a subset through `sites.default_locale` and `sites.available_locales`.
- The platform-wide superset must cover at least every DeepL target language supported by the configured DeepL provider snapshot.
- Sites must not offer locales that are unknown to the platform capability superset.
- `sites.default_locale` must be one of `sites.available_locales`.
- Locale identifiers should use BCP-47-style values where applicable, for example `de-DE`, `de-CH`, `en-US`, `en-GB`, `fr-FR`, `ja-JP`, `zh-Hans`, `zh-Hant`, `pt-BR`, and `pt-PT`.
- The stored site locale is not necessarily identical to an external provider target:
  - DeepL receives the resolved provider target, for example `de-CH -> DE`, `en-US -> EN-US`, `pt-BR -> PT-BR`, `zh-Hans -> ZH-HANS`.
  - Ant Design receives the resolved UI locale key, for example `de-CH -> de_DE`, `en-GB -> en_GB`, `zh-Hans -> zh_CN`.
  - Intl and `<html lang>` receive the effective site locale.
  - Phi label sets use the resolved fallback chain, for example `de-CH -> de -> en`.
- Locale validation, automatic translation targets, Ant Design locale mapping, text direction, and fallback chains must be derived centrally in `phi-server`, not reimplemented in widgets or site apps.
- Runtime locale resolution is exposed through `GET /api/v1/site/locale`. It returns the effective locale, provider targets, UI targets, direction, and fallback chain for the current request.
- Site configuration can be cached by site key. Resolved runtime locale must not be cached as site config because it can depend on user session, locale cookie, explicit request locale, and `Accept-Language`.
- `phi-shared-ui` only consumes the resolved contract. Its locale-specific UI responsibility is loading the bundled UI locale modules that correspond to the resolved locale, for example Ant Design and Dayjs.
- When DeepL adds target languages, the platform capability superset should be updated first; only then may sites opt into those locales.
- `GET /api/v1/tr` translates a single message.
- `POST /api/v1/tr` accepts either:
  - a single `msg`
  - or a `msgs` array for batch translation
- Both request shapes may also carry `format=text|html`; `text` is the default and `html` means intentional translatable HTML markup.
- Public translation requests must not send `x-phis-site-key`.
- Internal translation requests use these rules:
  - internal token + `x-phis-site-key` => site translation store (`tr_site_msg`, `tr_site_lang`)
  - internal token without `x-phis-site-key` => global translation store (`tr_msg`, `tr_lang`) for `phi-core` text and global label sets
- Public translation requests use the global translation store only, never the site store.

### `phis.user_accounts`

- `id SERIAL PRIMARY KEY`
- `preferred_locale VARCHAR(8) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- `id` is the one global Phi user id and remains the same across Sites.
- `preferred_locale` stores the user's preferred UI locale when explicitly captured from registration or later settings updates.
- `flags` stores global non-role state such as terms acceptance.
- `user_accounts` contains no email, password, provider, commerce-account, or Site-membership shortcut.
- Global account existence resolves here; durable login identities and Site admission resolve through the
  normalized relations in `AUTHENTICATION.md`.
- The former `email_normalized`, `medusa_customer_id`, `password_hash`, `customer_number`, and `site_ids`
  columns are migration input only and must not remain as a parallel target-v1 identity path.

### `phis.user_emails`

- `id SERIAL PRIMARY KEY`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `email_normalized VARCHAR(320) NOT NULL UNIQUE`
- `verified_at TIMESTAMPTZ NOT NULL`
- `is_primary BOOLEAN NOT NULL DEFAULT FALSE`
- `source VARCHAR(64) NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- An accepted durable email belongs to exactly one global user; registration-intent email snapshots are
  not durable account-email rows.
- At most one row per user is primary.
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
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (user_id, site_id)`

Contract:
- `user_site_flags` stores site-local state such as enabled/disabled access and newsletter consent.
- `last_login_at` stores the last successful login for this user on this site.
- `authorization_revision` changes whenever an effective provider claim changes and participates in
  authorization-sensitive cache identity.
- `user_site_memberships` is the Site membership and Site-state source; effective role authority is
  stored in provider-scoped `user_site_role_claims`.
- Authorization checks resolve through the provider-claim contract in `AUTHORIZATION.md`;
  `user_accounts` does not carry role authority.
- If no `user_site_memberships` row exists for `user_id + site_id`, the viewer cannot receive a Site
  session or authenticated Site role authority.
- This relation is the only Site-admission source; `user_accounts` carries no parallel Site list.
- Core roles are additive:
  - `Admin` may perform all site-scoped actions, including user and role administration, site settings, and locale settings.
  - `Developer` may use developer tools and logs and may do everything `Builder`, `Author`, `Publisher`, `Supporter`, and `Accountant` can do, but must not manage users, roles, site settings, or locale settings.
  - `Builder` may create and update builder structure drafts, theme drafts, and navigation drafts, but cannot publish without an additional `Publisher` role.
  - `Author` may perform editorial work, translations, and news/content authoring, but cannot publish drafts.
  - `Publisher` may review, correct editorial content, and publish drafts, but cannot change builder structure, theme, or navigation.
  - `Supporter` may work in support/ticket flows only.
  - `Accountant` may work in accounting/billing flows only.
- Standard staff area access is:
  - `/admin`: `Admin`, `Developer`
  - `/builder`: `Admin`, `Developer`, `Builder`
  - `/editor`: `Admin`, `Developer`, `Author`, `Publisher`
  - `/accounting`: `Admin`, `Developer`, `Accountant`

### `phis.user_site_role_claims`

- `site_id SMALLINT NOT NULL`
- `user_id INT NOT NULL`
- `provider_id TEXT NOT NULL`
- `role_flags INT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (site_id, user_id, provider_id)`
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`

Contract:
- `@phis/server/core` stores the effective assigned Core role matrix.
- Every enabled compatible Add-on owns an independent provider-local role bit space.
- Persisted Add-on claims survive provider disablement but are omitted from effective runtime claims
  until the provider is available again.
- Assigned bits must be a subset of the active provider role catalog.
- Zero assignments are represented by deleting the provider row.
- Role claims are written only through the authorized Core role-assignment service.
- The target v1 schema does not keep `base_role_flags` or `custom_role_flags` as parallel effective
  authorization columns.

### `phis.site_auth_config`

- `site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE`
- `config_version SMALLINT NOT NULL DEFAULT 1`
- `config JSONB NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- One row is the only Site-level Auth configuration source of truth.
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

### `phis.user_auth_factors` and Auth transactions

- `id UUID PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `factor_type SMALLINT NOT NULL`
- `factor_key BYTEA NULL`
- `factor_data JSONB NOT NULL DEFAULT '{}'::jsonb`
- encrypted-secret fields, label, confirmation/use/consumption timestamps
- `FOREIGN KEY (user_id, site_id) REFERENCES phis.user_site_memberships(user_id, site_id) ON DELETE CASCADE`

Factor types are closed and numeric:

- `1 = passkey`
- `2 = TOTP`
- `3 = recovery code`

- `factor_key` is raw binary WebAuthn credential-id material for passkeys and the raw hash for recovery
  codes; it is not a UUID or a repeated textual method label.
- Passkeys store only public WebAuthn credential material and RP/origin scope; private keys remain on the
  authenticator.
- TOTP seeds are encrypted, recovery codes are hashed, and successful enrollment requires a confirmed
  challenge.
- Authentication transactions and challenges are opaque, expiring, and one-use. They bind the trusted
  Site, provider installation or method, user/workflow when known, CSRF/OAuth correlation data, and safe
  relative return destination.

### `phis.user_sessions`

- `id UUID PRIMARY KEY`
- `user_id INT NOT NULL`
- `site_id SMALLINT NOT NULL`
- `session_secret_hash CHAR(64) NOT NULL`
- `authenticated_at TIMESTAMPTZ NOT NULL`
- `assurance_level SMALLINT NOT NULL`
- `auth_method_keys JSONB NOT NULL`
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
- Provider access tokens are not session fields. Tokens retained for provider API access belong to a
  separate encrypted integration/Add-on store.

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
- `submit_handler_key VARCHAR(128) NOT NULL`
- `confirm_handler_key VARCHAR(128) NULL`
- `default_config JSONB NOT NULL DEFAULT '{}'::jsonb`
- `variant VARCHAR(64) NULL`
- `config JSONB NOT NULL DEFAULT '{}'::jsonb`

Contract:
- `form_id` is the complete lowercase namespaced identity `<npm-package>/forms/<form-key>`.
- `owner_module_id` records the Runtime Module that owns the preset or Site override lifecycle; it is
  metadata and never forms a second identity with `form_id`. Its package namespace must match the
  package namespace in `form_id`; SQL checks reject mismatches and malformed namespaced ids.
- `status = 0` is the reserved Working Draft state, `status = 1` is Published, and `status = 2` is an
  archived Published revision. Partial unique indexes reserve at most one Working Draft and one Published
  revision per Site and Form. v1 initially writes Published revisions only; adding persistent Draft APIs
  later requires no table change.
- `descriptor` is one atomic versioned document with `schemaVersion = 1`, `fields`, and `actions`.
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
- `asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT`; media delete code removes owned `type=asset` wrapper rows before deleting the asset
- `current_version_id INT NULL`
- `published_version_id INT NULL`
- `published_at TIMESTAMPTZ NULL`
- `expires_at TIMESTAMPTZ NULL`
- `sort_order INT NOT NULL DEFAULT 0`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, type, slug)`

Contract:
- `site_content*` remains the canonical redaction/publishing store for site-owned content.
- Content widgets should reference `site_content` by numeric `content_id` instead of embedding large copy payloads directly in widget config.
- `asset` is the content type for a reusable image/media wrapper and must point at `media_assets.id` through `site_content.asset_id`.
- `site_content(type=asset)` is created on demand when a widget binds to a media asset, not eagerly on media upload.
- `text` is the canonical content type for database-backed `simple-text` widget copy.
- A `simple-text` widget should normally persist its source text through `site_content(type=text)` so search and later publisher/editor flows can resolve that copy centrally.
- Rich text should use its own dedicated `site_content(type=html)` path instead of overloading `type=text`.
- The CMS POST path is the authoritative HTML trust boundary. For `contentBinding.storage=html`, the
  backend sanitizes the declared source field before persisting both the Widget config and the immutable
  `site_content(type=html)` version. Client-side authoring checks are advisory and cannot replace this
  write-time enforcement.
- `site_content(type=html)` and `site_content(type=markdown)` are the declared internal content channel
  from [REFERENCES.md](./REFERENCES.md). The write sanitizer accepts `phis:page/<reference>` and
  `phis:asset/<asset-id>` there, and `img` exists in that channel because an Asset reference is expressed
  as an image source. Every other sanitizer caller keeps the external-only scheme set.
- Only the canonical literal reference form survives. A value that reaches a `phi:` scheme through
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
- Shared preset trees are the explicit exception: they may still ship local `config.text` values without a backing `content_id`.
- If a widget-owned `site_content` row is deleted, its version and translation rows are removed through the existing cascade chain.
- If the same `content_id` is still referenced by another widget on the same site, only the widget row should be deleted.
- Structure and placement are modeled through CMS revision trees, not through separate relational layout/widget tables.

### `phis.site_area_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `area_id SMALLINT NOT NULL DEFAULT 1`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, area_id)`

Contract:
- One area scope exists per `site + area`.
- `area_id` is the internal numeric area identifier for the concrete area. It is not a visibility mask.
- The scope stores the current published revision pointer and the current working draft pointer.
- Published live reads resolve directly through `site_area_scopes.published_revision_id` into the area revision payload.
- No separate materialized live shell tables should sit between the published revision pointer and runtime rendering.

### `phis.site_page_scopes`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `area_id SMALLINT NOT NULL DEFAULT 1`
- `path VARCHAR(512) NULL`
- `owner_module_id VARCHAR(255) NULL`
- `preset_key VARCHAR(128) NULL`
- `published_revision_id INT NULL`
- `working_draft_revision_id INT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `CHECK ((path IS NOT NULL AND owner_module_id IS NULL AND preset_key IS NULL) OR (path IS NULL AND owner_module_id IS NOT NULL AND preset_key IS NOT NULL))`
- Partial unique index on `(site_id, area_id, path)` where `path IS NOT NULL`
- Partial unique index on `(site_id, area_id, owner_module_id, preset_key)` where `owner_module_id IS NOT NULL`

Contract:
- A Site-authored exact Page has one immutable Scope id, one mutable canonical `path`, and no
  module-preset identity. The unique `(site_id, area_id, path)` constraint protects route allocation but
  does not make the path the Page identity.
- A module route snapshot has one scope per `site + area + owner_module_id + preset_key`; its concrete request path is not part of the scope identity, including for dynamic `:id` routes.
- Exactly one address kind is populated. Path lookup is never used as a compatibility alias for a module-preset scope.
- `area_id` is the internal numeric area identifier for the concrete area. It is not a visibility mask.
- The scope stores the current published revision pointer and the current working draft pointer.
- Site Page path mutation follows [REFERENCES.md](./REFERENCES.md): it is an explicit Scope command,
  independent of revisions and Undo/Redo. Module Page paths remain descriptor-owned and immutable to the
  Site.
- Site Page deletion retains the Scope row and its canonical path. The deleted Page revision state is the
  logical tombstone; the path stays reserved by the existing unique key. Creating or restoring a Site
  Page at that path reactivates this Scope and reuses its immutable id rather than inserting another
  Scope. Runtime reference resolution remains id-based and never falls back to path matching.
- `tree_json.page.path` is not an independently writable source of truth. A read/render projection may
  carry the currently resolved path, but persistence resolves Site paths from the Scope column and Module
  paths from the active route descriptor.
- Published live reads resolve directly through `site_page_scopes.published_revision_id` into the page revision payload.
- No separate materialized live page tables should sit between the published revision pointer and runtime rendering.

### Internal Page and Asset references

Stable Page references and `phis:page/...` / `phis:asset/...` document references follow
[REFERENCES.md](./REFERENCES.md). Structured internal targets persist Page Scope or Module preset identity,
never a copied path. Asset targets reuse `media_assets.id` and remain Site/access constrained.

`phis.site_cms_references` is the maintained projection, updated transactionally by the same writes that
persist the referencing data. Broad revision-JSON scans are migration input and not the lookup path.

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
- `target_owner_module_id VARCHAR(255) NULL`
- `target_preset_key VARCHAR(255) NULL`
- `target_asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT`
- `fragment VARCHAR(512) NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, source_kind, source_scope_id, source_revision_id, source_location)`

Contract:
- `source_kind` is closed: `1 = page` (revision `tree_json`), `2 = navigation` (revision `tree_json`), `3 = content` (a trusted `site_content` HTML or Markdown body), `4 = area` (revision `tree_json`).
- `source_scope_id` is the owning Page Scope, Navigation Scope, Area Scope, or `site_content.id` for the matching source kind. Writers replace the complete reference set for one `(site_id, source_kind, source_scope_id)` in the same transaction that persists the source.
- `source_location` is a JSON-Pointer-style path into the source value, with `~0`/`~1` escaping and an appended `@<offset>` when several references are embedded in one string. Content sources use the persisted field name as the root, for example `/html@42`.
- `target_kind` is closed: `1 = Site Page Scope`, `2 = Module preset Page`, `3 = Asset`. A CHECK constraint enforces that exactly the matching target columns are set.
- Asset targets are validated against the Site Media Space on write; a reference to an Asset outside it aborts the transaction.
- `ON DELETE RESTRICT` on both target columns makes the index the enforcement point for Page and Asset deletion, not just a reporting aid.
- The projection is read for path-change affected-reference counts, Page and Asset deletion diagnostics, and delete guards. It never rewrites reference owners: a stable identity already resolves to the new path.
- Because a Widget body is persisted both in the revision `tree_json` and in its `site_content` row, one authored reference legitimately produces one Page-source row and one Content-source row. The per-source breakdown keeps that visible; the sum is a location count, not a distinct-authored-reference count.
- The Area source is the `tree_json` counterpart to the Page source, written by the Area draft save inside the same transaction. It exists because Area-owned trusted bodies reach the index through the Content source, but a reference sitting in Area widget or Region config carries no content binding and so had no index row at all. Area revisions persisted before the source existed stay unindexed until their next save; no backfill pass exists. See [TODOS.md](./TODOS.md).
- `source_revision_id` is what makes a row's own liveness readable. Page, Navigation, and Area sources index the revision that was just written, and discarding a Working Draft removes that revision without touching its rows. A row naming a revision the Scope points at from neither `published_revision_id` nor `working_draft_revision_id` is therefore dead by construction, and the readers that would act on it -- the Asset delete guard and the affected-reference count behind a path change -- disregard it over the same three Scope joins, instead of a sweep repairing it: the maintenance contract in [AGENTS.md](./AGENTS.md). Publishing promotes the draft revision rather than creating one, so a published reference keeps matching. Content sources are exempt: their revision is a content version, and the orphan collector already removes their rows when a discarded Draft leaves the content unreferenced.

### CMS node identity target contract

- Layout, Widget, Overlay, and resolved Navigation item instances use one canonical 96-bit `PhiCmsInstanceId`, serialized as exactly 16 Base64URL characters and stored exclusively in revision `tree_json`.
- Layout-parent and Page/Region root-Layout references use the target Layout `instanceId`. Signal receivers use `cms:<instanceId>` and `cms:<instanceId>:<subcontrolKey>`; Widget/Layout kind is registry metadata.
- Layout type keys are exactly `<plugin-key>/<layout-type>`. Padding, background, border, radius, shadow, and effect are normal Layout config; no presentation kind or type-key suffix is persisted.
- Region padding is stored flat as `padding`, `paddingTop`, `paddingRight`, `paddingBottom`, and `paddingLeft` inside the Region config in `tree_json`.
- Codec v1 uses one version/origin header byte and one explicit closed domain byte (`area`, `page`, or `navigation`). Draft-origin ids then use six bytes for a safe 48-bit owning Draft revision id and four bytes for the Draft-local sequence. The complete id is never represented as one JavaScript number, and the earlier pre-domain v1 byte layout is invalid.
- Every Area, Page, or Navigation Draft persists one monotonic `nextNodeSequence`. Deleted sequence values are never reused, and concurrent writes require Draft revision/version conflict detection.
- Preset ids use a versioned Preset header, the domain byte, and an 80-bit deterministic hash of `(contractVersion, domain, ownerModuleId, presetKey, nodeKey)`. Preset version, Site, concrete Area key, route, browser/storage path, and node type do not participate.
- Identity is independent of revision state and remains unchanged through Draft, review, preview, publish, reset, move, and config edits. Duplication or portable import creates a new target-owned Draft id; inserting into an in-memory fallback creates its Draft first.
- Publish validates encoding/active-context uniqueness and every structural/signal reference, then updates the selected revision and its scope pointer in one transaction without identity materialization.
- Exact backup/restore preserves ids, revisions, pointers, and DB sequences. Portable CMS import creates a target Draft and centrally remaps every internal reference; module-owned domain data participates only through declared module export/import hooks.
- The current `phis.site_cms_node_id_seq` and numeric publish materializer are transitional implementation only and must be removed by the 96-bit v1 migration. No numeric CMS node id, negative-id lifecycle, CMS-node `instanceKey`, UUID alias, or compatibility reader remains afterward.

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
- `tree_json` stores the concrete area as string field `area`.
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
- `tree_json` stores the concrete area as string field `area`.
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
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (content_id, version_no)`

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
- Area modules may declare canonical keys such as:
  - `public:header`
  - `public:sidebar`
  - `public:footer`
  - `app:header`
  - `app:sidebar`
  - `admin:sidebar`
  - `builder:sidebar`
- The scope stores the current published revision pointer and the current working draft pointer.
- Published live reads resolve directly through `site_nav_scopes.published_revision_id` into the navigation overlay payload.

### `phis.site_nav_revisions`

- `id SERIAL PRIMARY KEY`
- `nav_scope_id INT NOT NULL REFERENCES phis.site_nav_scopes(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
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
- `icon` overrides store a namespaced icon reference string that the frontend maps to its icon registry.
- The initial icon namespace contract is:
  - `antd:<icon-key>` for Ant Design icons resolved by the shared UI icon registry
  - `asset:<path>` for controlled static assets served from the site `public/` tree
- Additional namespaces such as `lucide:<icon-key>` require an explicit shared contract update before they are used.

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
- The published site runtime object remains the live rendering source for pages, shells, navigation, and brand builder preview consumers unless they explicitly request a draft.

### `phis.site_groups`

Defined in [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md), which owns the contract. Two columns there
are worth naming here because they are schema decisions rather than behaviour:

- `site_media_config.flags` is on its way out. Which Space kinds a Site has is declared by its active
  Modules and resolved as the union of those declarations, not stored as a switch; see
  [GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md), "Availability is separate from capacity". The
  column still exists and is still read until the declaration path is implemented.
- `retired_at TIMESTAMPTZ NULL` carries group retirement, which is what ends a group's service: the row
  and its key stay, and a retired group grants nothing. `updated_at` cannot answer "retired since when"
  -- every later edit overwrites it, which is why the state is its own column. See "Retiring a group".
- The composite foreign key from `media_spaces` deliberately does not cascade. No surface deletes a
  group, so this now guards against a stray statement rather than a supported operation: it fails
  instead of taking a Space and its contents along. See "Who administers a group".

### `phis.support_teams`

This is the current Support-domain membership implementation. Under the approved target in
[GROUPS_AND_STORAGE.md](./GROUPS_AND_STORAGE.md), generic membership moves to `site_groups` and
`site_group_members`; `support_teams` remains only as a Support routing/profile relation.

- `id SMALLSERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `key VARCHAR(64) NOT NULL`
- `name VARCHAR(128) NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `sort_order SMALLINT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, key)`

Contract:
- Support teams are site-scoped assignment queues such as `support_l1`, `dev`, or `billing`.
- Team identity belongs to `site_id + key`; no global team catalog is required.
- Deleting a site removes its support teams through cascade.
- The bootstrap default set is:
  - `support_l1`
  - `support_l2`
  - `dev`
  - `billing`
- New support tickets should default to `support_l1` when no explicit `team_id` is supplied.

### `phis.support_team_members`

- `team_id SMALLINT NOT NULL REFERENCES phis.support_teams(id) ON DELETE CASCADE`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `PRIMARY KEY (team_id, user_id)`

Contract:
- Team membership is the site-scoped mapping between support teams and user accounts.
- A user may belong to multiple teams within the same site.
- Membership rows are operational, not historical; deleting a team or user removes the membership row.
- Historical assignment auditing remains in `support_ticket_assignments`, so membership rows do not need `SET NULL` behavior.

### `phis.support_threads`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `ticket_id INT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `type SMALLINT NOT NULL`
- `status SMALLINT NOT NULL DEFAULT 0`
- `subject VARCHAR(255) NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Threads are the internal support messaging container.
- `ticket_id` is optional so a thread can be ticket-bound or stand alone as a team or direct conversation.
- `type` is the recipient model:
  - `0 = direct`
  - `1 = team`
  - `2 = mixed`
  - `3 = broadcast`
- `status` is the lifecycle:
  - `0 = open`
  - `1 = archived`
- Threads are internal-only and are not customer-facing communication records.

### `phis.support_thread_messages`

- `id SERIAL PRIMARY KEY`
- `thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE`
- `author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `body_text TEXT NOT NULL`
- `body_markdown TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Thread messages are the actual internal messages inside a support thread.
- User deletion must not delete historical messages; `author_user_id` falls back to `NULL`.
- `meta` is reserved for lightweight additions such as mentions, client hints, or later attachment metadata.

### `phis.support_thread_recipients`

- `id SERIAL PRIMARY KEY`
- `thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE`
- `recipient_type SMALLINT NOT NULL`
- `user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE CASCADE`
- `flags INT NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Recipients define who should receive a thread.
- `recipient_type`:
  - `0 = user`
  - `1 = team`
- Exactly one of `user_id` or `team_id` must be populated on each row.
- A thread may target direct users, whole teams, or both at once.
- Team recipients are not expanded into per-user rows; team resolution happens dynamically via `support_team_members`.
- Recommended uniqueness:
  - unique `(thread_id, user_id)` where `user_id IS NOT NULL`
  - unique `(thread_id, team_id)` where `team_id IS NOT NULL`

### `phis.support_thread_reads`

- `thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE`
- `user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE`
- `last_read_message_id INT NULL REFERENCES phis.support_thread_messages(id) ON DELETE SET NULL`
- `read_at TIMESTAMPTZ NULL`
- `PRIMARY KEY (thread_id, user_id)`

Contract:
- Read state is tracked per user and per thread.
- A user has access to a thread if they are a direct recipient or belong to a recipient team.
- Unread notification counts can be derived by comparing the latest thread message against `last_read_message_id`.
- This table is sufficient for dashboard message badges without adding a separate notification system in v1.

### `phis.support_tickets`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `type SMALLINT NOT NULL`
- `status SMALLINT NOT NULL DEFAULT 0`
- `channel SMALLINT NOT NULL`
- `priority SMALLINT NOT NULL DEFAULT 1`
- `severity SMALLINT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `requester_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `requester_email VARCHAR(320) NULL`
- `assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL`
- `subject VARCHAR(512) NOT NULL`
- `summary TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `first_response_due_at TIMESTAMPTZ NULL`
- `resolution_due_at TIMESTAMPTZ NULL`
- `last_public_message_at TIMESTAMPTZ NULL`
- `last_internal_message_at TIMESTAMPTZ NULL`
- `resolved_at TIMESTAMPTZ NULL`
- `closed_at TIMESTAMPTZ NULL`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Support tickets are Phi-owned workflow records and remain independent from GitHub issues or Medusa records.
- `requester_user_id` is optional so external email-only tickets can exist without a local account.
- `requester_email` may remain populated after `requester_user_id` becomes `NULL`; it is the only allowed lightweight requester fallback in the core ticket row.
- User deletion must not delete the ticket; all user references use `ON DELETE SET NULL`.
- Ticket-level `flags` are reserved for internal workflow/system bits, not for external-system ownership.
- Cross-system relationships such as GitHub issues, PRs, Medusa orders, or CMS references belong in `support_ticket_links`, not in dedicated columns on the ticket row.
- `meta` is the free-form extension field for lightweight origin or UI context such as locale, path, or browser hints.

### `phis.support_ticket_messages`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `channel SMALLINT NOT NULL`
- `visibility SMALLINT NOT NULL DEFAULT 0`
- `author_type SMALLINT NOT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `external_message_ref VARCHAR(256) NULL`
- `body_text TEXT NOT NULL`
- `body_markdown TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Messages are ticket-scoped conversation entries.
- `visibility` distinguishes customer-visible replies from internal-only notes.
- A message may originate from email, portal, API, GitHub, or internal authoring, but ticket ownership remains in Phi.
- User deletion must not delete the message; `author_user_id` resolves to `NULL`.
- No author-name or email snapshot columns are stored in message history.

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
- One ticket may carry multiple tasks, and resolving a GitHub issue does not by itself resolve the support ticket.
- Tasks may be assigned independently from the ticket assignee.
- User deletion must not delete the task; user references become `NULL`.

### `phis.support_ticket_links`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `system SMALLINT NOT NULL`
- `type SMALLINT NOT NULL`
- `state SMALLINT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `external_id VARCHAR(256) NOT NULL`
- `external_key VARCHAR(256) NULL`
- `external_url TEXT NULL`
- `meta JSONB NOT NULL DEFAULT '{}'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Links are the generic cross-system attachment model for support tickets.
- A ticket may have multiple links across multiple systems at the same time.
- `system` identifies the external source family such as `phi`, `medusa`, or `github`.
- `type` identifies the concrete linked object such as `cms_page`, `medusa_order`, `github_issue`, or `github_pr`.
- The core ticket row must not be overloaded with one-off foreign keys for external systems while this link table exists.

### `phis.support_ticket_assignments`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `from_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `to_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `from_team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL`
- `to_team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL`
- `reason TEXT NULL`
- `flags INT NOT NULL DEFAULT 0`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Contract:
- Assignment rows are the audit trail for handoffs between users or teams.
- The current assignee lives on `support_tickets`; assignment rows preserve the history of changes.
- Team or user deletion must not delete assignment history; nullable references fall back to `NULL`.

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

### `phis.support_github_integrations`

- `id SERIAL PRIMARY KEY`
- `site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE`
- `owner VARCHAR(128) NOT NULL`
- `repo VARCHAR(128) NOT NULL`
- `installation_id BIGINT NOT NULL`
- `sync_mode SMALLINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `label_filter JSONB NOT NULL DEFAULT '[]'::jsonb`
- `created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (site_id, owner, repo)`

Contract:
- GitHub integrations are site-scoped repository mappings for support workflows.
- `installation_id` refers to the GitHub App installation used for issue creation and webhook correlation.
- `sync_mode` defines whether the repo is used only for manual linking, outbound issue creation, or later bidirectional synchronization.
- Deleting a site removes its GitHub integration rows through cascade.

### `phis.support_github_mappings`

- `id SERIAL PRIMARY KEY`
- `ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE`
- `integration_id INT NOT NULL REFERENCES phis.support_github_integrations(id) ON DELETE CASCADE`
- `github_issue_number INT NOT NULL`
- `github_issue_node_id VARCHAR(128) NULL`
- `direction SMALLINT NOT NULL`
- `sync_state SMALLINT NOT NULL DEFAULT 0`
- `flags INT NOT NULL DEFAULT 0`
- `last_synced_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE (ticket_id, integration_id, github_issue_number)`

Contract:
- GitHub mappings track synchronized issue relationships separately from the generic link table.
- The generic link row remains the cross-system reference visible to the support domain; the mapping row stores GitHub-sync-specific state.
- A ticket may map to multiple GitHub issues within the same or different repositories.

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

## Content and Translation Model

- The global `tr_*` tables remain reserved for `phi-core` text and global label sets that are not tied to any site.
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
- its `title`, `summary`, and `body` live as separate rows in `site_content_version_text`
- each of those rows points to one `tr_site_msg` row containing the canonical Site-source text
- translated output is resolved through `tr_site_lang`
- an `asset` entry lives in `site_content`
- its `asset_id` points to `media_assets`
- its `title`, `alt`, and `caption` live as separate rows in `site_content_version_text`

Design decision:

- keep `tr_site_msg` small and focused on source text plus translation identity
- keep business fields such as `type`, `slug`, publish state, and ordering in dedicated content tables
- use `ctx` consistently per entity field
- for content entities, stable structural keys are acceptable, for example `news:42:title`, `news:42:summary`, `blog:17:body`
- for human-facing translated copy that benefits from better translation context, prefer short natural-language context phrases over machine-style keys
- examples for email/template translation context:
  - `registration verification email subject`
  - `registration verification email body`
  - `registration welcome email subject`
  - `registration welcome email body`
- prefer natural-language context phrases when DeepL translation quality is the priority; use machine-like keys only where storage/disambiguation is the main concern
- global canonical source remains English; each Site has one immutable configured source locale
