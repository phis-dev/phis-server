CREATE SCHEMA IF NOT EXISTS phis;

-- Substring search for Add-on tables. An Add-on declares a text index and Core builds a trigram one
-- from it, which is what turns `contains` from a table scan into a lookup: measured on 200,000 rows,
-- 72 ms without and 0.5 ms with. The extension is database-wide rather than per schema, so it belongs
-- here rather than beside the index that needs it. An installation whose provider forbids it still
-- runs -- the index is what is missing, not the search, and `phis addon check` says which Add-ons pay
-- for that.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS phis.sites (
  id SMALLSERIAL PRIMARY KEY,
  key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  hostname VARCHAR(255) NOT NULL UNIQUE,
  default_locale VARCHAR(8) NOT NULL DEFAULT 'en',
  available_locales VARCHAR(8)[] NOT NULL DEFAULT ARRAY['en']::VARCHAR(8)[],
  flags INT NOT NULL DEFAULT 0,
  theme JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_base_url VARCHAR(512) NOT NULL,
  mail_from VARCHAR(320) NOT NULL,
  mail_from_name VARCHAR(160) NOT NULL,
  support_email VARCHAR(320) NOT NULL,
  contact_recipient VARCHAR(320) NOT NULL,
  medusa_base_url VARCHAR(512) NULL,
  medusa_publishable_key VARCHAR(320) NULL,
  customer_number_prefix VARCHAR(32) NULL,
  form_guard_secret CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phis.user_accounts (
  id SERIAL PRIMARY KEY,
  preferred_locale VARCHAR(8) NULL,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phis.user_emails (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  email_normalized VARCHAR(320) NOT NULL UNIQUE,
  verified_at TIMESTAMPTZ NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  source SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_emails_source_check CHECK (source IN (1, 2, 3, 4, 5, 9, 20, 21, 22, 23))
);

-- One primary address per account, and the mark is bit 0 of `flags` (PhiUserEmailFlag.Primary).
-- The index is what enforces the rule rather than merely finding the row, so the bit position it names
-- is fixed for good: moved, the constraint would go on guarding something else without saying so.
CREATE UNIQUE INDEX IF NOT EXISTS user_emails_primary_user_idx
  ON phis.user_emails (user_id)
  WHERE (flags & 1) <> 0;

CREATE INDEX IF NOT EXISTS user_emails_user_id_idx
  ON phis.user_emails (user_id);

CREATE OR REPLACE VIEW phis.user_account_directory AS
SELECT
  account.id,
  email.email_normalized
FROM phis.user_accounts AS account
LEFT JOIN LATERAL (
  SELECT candidate.email_normalized
  FROM phis.user_emails AS candidate
  WHERE candidate.user_id = account.id
  ORDER BY (candidate.flags & 1) DESC, candidate.verified_at DESC, candidate.id ASC
  LIMIT 1
) AS email ON TRUE;

CREATE TABLE IF NOT EXISTS phis.user_password_credentials (
  user_id INT PRIMARY KEY REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phis.user_auth_identities (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  issuer VARCHAR(512) NOT NULL,
  subject VARCHAR(512) NOT NULL,
  provider_key VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  CONSTRAINT user_auth_identities_issuer_subject_unique UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS user_auth_identities_user_id_idx
  ON phis.user_auth_identities (user_id);

CREATE TABLE IF NOT EXISTS phis.user_profiles (
  user_id INT PRIMARY KEY REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  first_name VARCHAR(128) NOT NULL,
  last_name VARCHAR(128) NOT NULL,
  company_name VARCHAR(256) NULL,
  phone VARCHAR(64) NULL,
  mobile VARCHAR(64) NULL,
  fax VARCHAR(64) NULL,
  address_1 VARCHAR(255) NULL,
  address_2 VARCHAR(255) NULL,
  postal_code VARCHAR(32) NULL,
  city VARCHAR(128) NULL,
  province VARCHAR(128) NULL,
  country_code CHAR(2) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phis.user_site_memberships (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  user_site_flags INT NOT NULL DEFAULT 0,
  authorization_revision INT NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_site_memberships_user_site_unique UNIQUE (user_id, site_id),
  CONSTRAINT user_site_memberships_authorization_revision_check
    CHECK (authorization_revision >= 0)
);

CREATE INDEX IF NOT EXISTS user_site_memberships_site_id_idx
  ON phis.user_site_memberships (site_id);

CREATE TABLE IF NOT EXISTS phis.user_site_role_claims (
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  role_flags INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, site_id, provider_id),
  CONSTRAINT user_site_role_claims_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT user_site_role_claims_provider_id_check
    CHECK (provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  CONSTRAINT user_site_role_claims_role_flags_check CHECK (role_flags > 0)
);

CREATE INDEX IF NOT EXISTS user_site_role_claims_site_id_idx
  ON phis.user_site_role_claims (site_id);

CREATE TABLE IF NOT EXISTS phis.site_groups (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL,
  key VARCHAR(160) NOT NULL,
  name VARCHAR(255) NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  -- Retirement, which replaces deleting a group: the row and its key stay, and a retired group grants
  -- nothing. `updated_at` cannot answer "since when", as every later edit overwrites it.
  -- See GROUPS_AND_STORAGE.md, "Retiring a group".
  retired_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_groups_provider_id_check
    CHECK (provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  CONSTRAINT site_groups_key_check CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  CONSTRAINT site_groups_site_provider_key_unique UNIQUE (site_id, provider_id, key),
  CONSTRAINT site_groups_id_site_unique UNIQUE (id, site_id)
);

CREATE INDEX IF NOT EXISTS site_groups_site_name_idx
  ON phis.site_groups (site_id, LOWER(name), id);

CREATE TABLE IF NOT EXISTS phis.site_group_members (
  group_id INT NOT NULL,
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  source_provider_id VARCHAR(255) NOT NULL,
  source_connection_key VARCHAR(160) NOT NULL DEFAULT 'local',
  source_binding_or_assertion_key VARCHAR(512) NOT NULL,
  membership_flags SMALLINT NOT NULL,
  valid_until TIMESTAMPTZ NULL,
  provider_revision VARCHAR(255) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    group_id,
    user_id,
    source_provider_id,
    source_connection_key,
    source_binding_or_assertion_key
  ),
  CONSTRAINT site_group_members_group_site_fk
    FOREIGN KEY (group_id, site_id)
    REFERENCES phis.site_groups (id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT site_group_members_user_site_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT site_group_members_source_provider_id_check
    CHECK (source_provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  -- The four cumulative levels: Member 1, Author 3, Editor 7, Manager 15. Each bit requires every bit
  -- below it, so a level that skips a rung cannot be stored at all.
  CONSTRAINT site_group_members_flags_check
    CHECK (membership_flags > 0 AND membership_flags <= 15 AND
      (membership_flags & 8 = 0 OR membership_flags & 7 = 7) AND
      (membership_flags & 4 = 0 OR membership_flags & 3 = 3) AND
      (membership_flags & 2 = 0 OR membership_flags & 1 = 1))
);

CREATE INDEX IF NOT EXISTS site_group_members_site_user_idx
  ON phis.site_group_members (site_id, user_id, group_id);

CREATE INDEX IF NOT EXISTS site_group_members_effective_idx
  ON phis.site_group_members (site_id, group_id, user_id, valid_until);

CREATE TABLE IF NOT EXISTS phis.directory_connections (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL,
  connection_key VARCHAR(160) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_reference VARCHAR(512) NULL,
  state SMALLINT NOT NULL DEFAULT 1,
  max_staleness_seconds INT NOT NULL DEFAULT 86400,
  provider_revision VARCHAR(255) NULL,
  cursor JSONB NULL,
  last_completed_at TIMESTAMPTZ NULL,
  last_error_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT directory_connections_provider_id_check
    CHECK (provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  CONSTRAINT directory_connections_config_check CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT directory_connections_site_provider_key_unique
    UNIQUE (site_id, provider_id, connection_key)
);

CREATE TABLE IF NOT EXISTS phis.directory_user_bindings (
  site_id SMALLINT NOT NULL,
  user_id INT NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  connection_key VARCHAR(160) NOT NULL,
  external_subject VARCHAR(512) NOT NULL,
  status SMALLINT NOT NULL DEFAULT 1,
  provider_revision VARCHAR(255) NULL,
  last_observed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, provider_id, connection_key, external_subject),
  CONSTRAINT directory_user_bindings_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT directory_user_bindings_connection_fk
    FOREIGN KEY (site_id, provider_id, connection_key)
    REFERENCES phis.directory_connections (site_id, provider_id, connection_key)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phis.directory_group_bindings (
  site_id SMALLINT NOT NULL,
  group_id INT NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  connection_key VARCHAR(160) NOT NULL,
  external_subject VARCHAR(512) NOT NULL,
  status SMALLINT NOT NULL DEFAULT 1,
  provider_revision VARCHAR(255) NULL,
  last_observed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, provider_id, connection_key, external_subject),
  CONSTRAINT directory_group_bindings_group_fk
    FOREIGN KEY (group_id, site_id)
    REFERENCES phis.site_groups (id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT directory_group_bindings_connection_fk
    FOREIGN KEY (site_id, provider_id, connection_key)
    REFERENCES phis.directory_connections (site_id, provider_id, connection_key)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phis.media_storage_profiles (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  key VARCHAR(160) NOT NULL,
  provider_id VARCHAR(255) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_reference VARCHAR(512) NULL,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_storage_profiles_provider_id_check
    CHECK (provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  CONSTRAINT media_storage_profiles_config_check CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT media_storage_profiles_site_key_unique UNIQUE (site_id, key),
  CONSTRAINT media_storage_profiles_id_site_unique UNIQUE (id, site_id)
);

-- What this endpoint turned out to be able to do, established by `phis storage probe` rather than
-- declared by an operator. One adapter serves AWS, MinIO and Garage alike, and they do not agree on
-- everything -- so this is an observation with a date on it, not configuration, and it lives beside
-- `config` rather than inside it.
-- The digest this Profile records, chosen once from what the probe found the endpoint verifies.
-- Settled per Profile rather than per upload because duplicate detection compares digests, and two
-- objects are only comparable under the same algorithm: an adapter picking freshly on every plan would
-- split one Space's objects into cohorts that can never be told to be the same, and silently.
ALTER TABLE phis.media_storage_profiles
  ADD COLUMN IF NOT EXISTS probe JSONB NULL,
  ADD COLUMN IF NOT EXISTS probed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS checksum_algorithm VARCHAR(16) NULL;

CREATE TABLE IF NOT EXISTS phis.site_media_config (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  default_user_quota_bytes BIGINT NULL,
  default_group_quota_bytes BIGINT NULL,
  -- The ceiling a Space-level override may not exceed; NULL is no ceiling. Capacity delegated without
  -- one is not delegated capacity: an actor who can raise their own allowance has no allowance.
  max_user_quota_bytes BIGINT NULL,
  max_group_quota_bytes BIGINT NULL,
  -- The fourth kind, on the same two rails as the others. An Add-on's files live in a Space of their
  -- own precisely so that the Space's quota IS the Add-on's quota, which only works if that Space
  -- inherits a Site default like every other delegated Space rather than being born unlimited.
  default_addon_quota_bytes BIGINT NULL,
  max_addon_quota_bytes BIGINT NULL,
  flags INT NOT NULL DEFAULT 0,
  max_object_bytes BIGINT NOT NULL DEFAULT 26214400,
  -- What a delegated Space accepts, derived from the active Modules on publish and never written by an
  -- administrator, exactly as `flags` is. Only a Module knows what its Space is for. The Site Space has
  -- no column here on purpose: its authority is PHI_ACCESS_SITE_MEDIA, a role rather than a list, and
  -- what a Site publishes includes binaries offered for download.
  user_space_content_kinds VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[],
  group_space_content_kinds VARCHAR(32)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(32)[],
  allowed_storage_profile_ids INT[] NOT NULL DEFAULT ARRAY[]::INT[],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_media_config_quota_check CHECK (
    (default_user_quota_bytes IS NULL OR default_user_quota_bytes >= 0) AND
    (default_group_quota_bytes IS NULL OR default_group_quota_bytes >= 0) AND
    (max_user_quota_bytes IS NULL OR max_user_quota_bytes >= 0) AND
    (max_group_quota_bytes IS NULL OR max_group_quota_bytes >= 0) AND
    (default_addon_quota_bytes IS NULL OR default_addon_quota_bytes >= 0) AND
    (max_addon_quota_bytes IS NULL OR max_addon_quota_bytes >= 0) AND
    max_object_bytes > 0
  )
);

CREATE TABLE IF NOT EXISTS phis.media_spaces (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  kind SMALLINT NOT NULL,
  user_id INT NULL,
  group_id INT NULL,
  -- The fourth kind's owner. An Add-on's files live in a Space of their own so that the Space's quota
  -- IS the Add-on's quota: one account over one set of bytes, rather than two that drift apart.
  addon_id VARCHAR(255) NULL,
  default_storage_profile_id INT NOT NULL,
  quota_bytes BIGINT NULL,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  reserved_bytes BIGINT NOT NULL DEFAULT 0,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_spaces_storage_profile_fk
    FOREIGN KEY (default_storage_profile_id, site_id)
    REFERENCES phis.media_storage_profiles (id, site_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT media_spaces_user_site_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  -- Deliberately NOT cascading: deleting a group would otherwise take its Space, folders and every
  -- Asset in it with no warning. What to do with the contents -- move, delete, keep -- is a decision
  -- for a person. Deferred rather than `RESTRICT` so a whole-Site delete still succeeds: the check runs
  -- at COMMIT, by which time every referrer is gone, while a lone group with content still fails.
  -- `NO ACTION` alone is not enough -- it is checked at the end of the sub-statement that deletes the
  -- referenced rows, so a cascade reaching the parent before its sibling branch still raises.
  CONSTRAINT media_spaces_group_site_fk
    FOREIGN KEY (group_id, site_id)
    REFERENCES phis.site_groups (id, site_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT media_spaces_owner_check CHECK (
    (kind = 1 AND user_id IS NULL AND group_id IS NULL AND addon_id IS NULL) OR
    (kind = 2 AND user_id IS NOT NULL AND group_id IS NULL AND addon_id IS NULL) OR
    (kind = 3 AND user_id IS NULL AND group_id IS NOT NULL AND addon_id IS NULL) OR
    (kind = 4 AND user_id IS NULL AND group_id IS NULL AND addon_id IS NOT NULL)
  ),
  CONSTRAINT media_spaces_quota_check CHECK (
    (quota_bytes IS NULL OR quota_bytes >= 0) AND used_bytes >= 0 AND reserved_bytes >= 0
  ),
  CONSTRAINT media_spaces_id_site_unique UNIQUE (id, site_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS media_spaces_site_unique_idx
  ON phis.media_spaces (site_id) WHERE kind = 1;
CREATE UNIQUE INDEX IF NOT EXISTS media_spaces_user_unique_idx
  ON phis.media_spaces (site_id, user_id) WHERE kind = 2;
CREATE UNIQUE INDEX IF NOT EXISTS media_spaces_group_unique_idx
  ON phis.media_spaces (site_id, group_id) WHERE kind = 3;

-- One Space per Add-on per Site, which is what makes "the Space's quota" and "the Add-on's quota" the
-- same sentence.
CREATE UNIQUE INDEX IF NOT EXISTS media_spaces_addon_unique_idx
  ON phis.media_spaces (site_id, addon_id) WHERE kind = 4;

CREATE TABLE IF NOT EXISTS phis.media_folders (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  space_id INT NOT NULL,
  parent_id INT NULL REFERENCES phis.media_folders(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_folders_space_site_fk
    FOREIGN KEY (space_id, site_id)
    REFERENCES phis.media_spaces (id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT media_folders_id_space_unique UNIQUE (id, space_id)
);

CREATE INDEX IF NOT EXISTS media_folders_space_parent_idx
  ON phis.media_folders (space_id, parent_id, sort_order, id);
CREATE UNIQUE INDEX IF NOT EXISTS media_folders_space_parent_name_unique_idx
  ON phis.media_folders (space_id, COALESCE(parent_id, 0), LOWER(name));

CREATE TABLE IF NOT EXISTS phis.media_assets (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  space_id INT NOT NULL,
  folder_id INT NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  -- Authority, and deliberately not the same column as `created_by_user_id`, which is history. An Asset
  -- handed over stays attributable to whoever brought it in while the person who may now delete it is
  -- someone else -- a receipt uploaded against an invoice must not remain the uploader's to remove.
  -- Both start equal and are free to diverge from the first handover onwards.
  owner_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  storage_profile_id INT NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  variant_version SMALLINT NULL,
  bytes BIGINT NULL,
  /*
   * The digest, and what produced it.
   *
   * Two columns rather than one named for an algorithm, because what lands here is not always the one
   * the name promises: an `ETag` is whatever the Provider chose to put in it, and Providers disagree --
   * MD5 for one, a digest of part digests for the same Provider above the single-request limit. A value
   * whose algorithm is unstated is a number the reader has to guess the meaning of, and guessing wrong
   * is how an MD5 gets compared against a SHA-256.
   */
  checksum_algorithm VARCHAR(16) NULL,
  checksum_value VARCHAR(128) NULL,
  CONSTRAINT media_assets_checksum_check CHECK (
    (checksum_algorithm IS NULL) = (checksum_value IS NULL)
  ),
  width SMALLINT NULL,
  height SMALLINT NULL,
  blur_data_url TEXT NULL,
  meta JSONB NULL,
  title VARCHAR(255) NULL,
  alt_text VARCHAR(255) NULL,
  lifecycle_status SMALLINT NOT NULL DEFAULT 1,
  delivery_policy SMALLINT NOT NULL DEFAULT 1,
  delivery_revision INT NOT NULL DEFAULT 1,
  presentation_flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_assets_space_site_fk
    FOREIGN KEY (space_id, site_id)
    REFERENCES phis.media_spaces (id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT media_assets_folder_space_fk
    FOREIGN KEY (folder_id, space_id)
    REFERENCES phis.media_folders (id, space_id)
    ON DELETE SET NULL (folder_id),
  CONSTRAINT media_assets_storage_profile_site_fk
    FOREIGN KEY (storage_profile_id, site_id)
    REFERENCES phis.media_storage_profiles (id, site_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT media_assets_lifecycle_check CHECK (lifecycle_status IN (1, 2, 3, 4, 5)),
  CONSTRAINT media_assets_delivery_check CHECK (delivery_policy IN (1, 2, 3, 4, 5)),
  CONSTRAINT media_assets_delivery_revision_check CHECK (delivery_revision > 0),
  CONSTRAINT media_assets_id_site_unique UNIQUE (id, site_id),
  CONSTRAINT media_assets_storage_key_unique UNIQUE (storage_profile_id, storage_key)
);

CREATE INDEX IF NOT EXISTS media_assets_space_folder_created_idx
  ON phis.media_assets (space_id, folder_id, created_at DESC, id DESC);
/*
 * What duplicate detection compares, and the algorithms it is willing to believe.
 *
 * Restricted to the digests strong enough to answer "is this the same file". CRC is linear and MD5
 * collisions are a download, so either would let someone who may already write to a Space stop one
 * particular file from entering it -- a refused upload rather than a substituted one, but free to
 * avoid. Objects carrying a weaker digest are still fully verified; they are simply not compared.
 *
 * The algorithm is part of the key because two digests are only comparable under the same one. Without
 * it a Space whose Storage Profile changed would hold two sets of numbers answering different
 * questions, and the index would silently stop finding anything.
 */
CREATE INDEX IF NOT EXISTS media_assets_space_checksum_idx
  ON phis.media_assets (space_id, checksum_algorithm, checksum_value)
  WHERE checksum_value IS NOT NULL AND checksum_algorithm IN ('sha256', 'sha512');
-- "what is mine in this Space", which is the question an Author's listing asks.
CREATE INDEX IF NOT EXISTS media_assets_space_owner_idx
  ON phis.media_assets (space_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.media_upload_sessions (
  token VARCHAR(128) PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  actor_user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  space_id INT NOT NULL,
  folder_id INT NULL,
  storage_profile_id INT NOT NULL,
  status SMALLINT NOT NULL,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  /*
   * The digest, and what produced it.
   *
   * Two columns rather than one named for an algorithm, because what lands here is not always the one
   * the name promises: an `ETag` is whatever the Provider chose to put in it, and Providers disagree --
   * MD5 for one, a digest of part digests for the same Provider above the single-request limit. A value
   * whose algorithm is unstated is a number the reader has to guess the meaning of, and guessing wrong
   * is how an MD5 gets compared against a SHA-256.
   */
  checksum_algorithm VARCHAR(16) NULL,
  checksum_value VARCHAR(128) NULL,
  CONSTRAINT media_upload_sessions_checksum_check CHECK (
    (checksum_algorithm IS NULL) = (checksum_value IS NULL)
  ),
  meta JSONB NULL,
  presentation_flags INT NOT NULL DEFAULT 0,
  upload_plan_kind SMALLINT NOT NULL DEFAULT 1,
  /*
   * What this upload becomes once the bytes are there.
   *
   * One lifecycle, several endings. Core reserves, receives, measures and hashes without knowing who
   * asked; `purpose` is read at the last step to decide what row the finished object turns into -- a
   * Media Asset, or an Asset on an Add-on's row. A closed vocabulary and not a free label, so the
   * ending is a decision somebody made rather than a string that happened to be there.
   */
  purpose SMALLINT NOT NULL DEFAULT 1,
  /** What that ending needs to know. For an Add-on: which Add-on, which table, which row, which slot. */
  purpose_ref JSONB NULL,
  staging_storage_key VARCHAR(512) NOT NULL,
  final_storage_key VARCHAR(512) NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ NULL,
  finalized_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT media_upload_sessions_space_site_fk
    FOREIGN KEY (space_id, site_id)
    REFERENCES phis.media_spaces (id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT media_upload_sessions_folder_space_fk
    FOREIGN KEY (folder_id, space_id)
    REFERENCES phis.media_folders (id, space_id)
    ON DELETE SET NULL (folder_id),
  CONSTRAINT media_upload_sessions_profile_site_fk
    FOREIGN KEY (storage_profile_id, site_id)
    REFERENCES phis.media_storage_profiles (id, site_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT media_upload_sessions_size_check CHECK (size_bytes > 0),
  CONSTRAINT media_upload_sessions_plan_kind_check CHECK (upload_plan_kind IN (1, 2)),
  CONSTRAINT media_upload_sessions_purpose_check CHECK (
    (purpose = 1 AND purpose_ref IS NULL) OR (purpose = 2 AND purpose_ref IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS media_upload_sessions_space_status_idx
  ON phis.media_upload_sessions (space_id, status, expires_at);
CREATE INDEX IF NOT EXISTS media_upload_sessions_actor_idx
  ON phis.media_upload_sessions (site_id, actor_user_id, created_at DESC);


CREATE TABLE IF NOT EXISTS phis.image_asset_variants (
  asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE CASCADE,
  variant_key SMALLINT NOT NULL,
  storage_profile_id INT NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  bytes BIGINT NULL,
  /*
   * The digest, and what produced it.
   *
   * Two columns rather than one named for an algorithm, because what lands here is not always the one
   * the name promises: an `ETag` is whatever the Provider chose to put in it, and Providers disagree --
   * MD5 for one, a digest of part digests for the same Provider above the single-request limit. A value
   * whose algorithm is unstated is a number the reader has to guess the meaning of, and guessing wrong
   * is how an MD5 gets compared against a SHA-256.
   */
  checksum_algorithm VARCHAR(16) NULL,
  checksum_value VARCHAR(128) NULL,
  CONSTRAINT image_asset_variants_checksum_check CHECK (
    (checksum_algorithm IS NULL) = (checksum_value IS NULL)
  ),
  width SMALLINT NOT NULL,
  height SMALLINT NOT NULL,
  blur_data_url TEXT NULL,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset_id, variant_key),
  CONSTRAINT image_asset_variants_storage_profile_id_fkey
    FOREIGN KEY (storage_profile_id)
    REFERENCES phis.media_storage_profiles (id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT image_asset_variants_storage_unique UNIQUE (storage_profile_id, storage_key)
);

-- The Asset a person shows as themselves on one Site.
--
-- Its own table rather than a column on `user_site_memberships`: an avatar is Site-scoped because the
-- Asset lives in that Site's User Space, and both halves of that are enforced structurally here -- the
-- membership pair and the Asset pair each carry their Site. A column on the membership row could not
-- express the second without widening a table every authorization read touches.
--
-- Deleting the picture removes the binding rather than blocking the delete: an avatar is a personal
-- setting, not a published reference, so `site_cms_references` and its RESTRICT do not apply.
CREATE TABLE IF NOT EXISTS phis.user_site_avatars (
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  asset_id INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, site_id),
  CONSTRAINT user_site_avatars_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT user_site_avatars_asset_site_fk
    FOREIGN KEY (asset_id, site_id)
    REFERENCES phis.media_assets (id, site_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_site_avatars_asset_idx
  ON phis.user_site_avatars (asset_id);

CREATE TABLE IF NOT EXISTS phis.site_auth_config (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  config_version SMALLINT NOT NULL DEFAULT 1,
  policy_revision INT NOT NULL DEFAULT 1,
  config JSONB NOT NULL DEFAULT '{
    "policy": {
      "registrationMode": "automatic",
      "existingAccountLinking": "verified-email-confirm",
      "allowPrivilegedAutoLink": false,
      "passwordPolicy": {},
      "passkeyPolicy": {},
      "factorPolicy": {
        "requiredMethod": null,
        "enforcement": "next-login",
        "graceUntil": null,
        "roleFlags": 0
      },
      "recoveryPolicy": {"recoveryCodes": true},
      "sessionPolicy": {},
      "allowedCallbackOrigins": []
    },
    "methods": [{
      "methodKey": "password",
      "stage": "primary",
      "installationKey": null,
      "enabled": true,
      "sortOrder": 10,
      "presentation": {"label": "Email and password"}
    }],
    "providers": []
  }'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_auth_config_version_check CHECK (config_version = 1),
  CONSTRAINT site_auth_config_policy_revision_check CHECK (policy_revision > 0),
  CONSTRAINT site_auth_config_json_check CHECK (jsonb_typeof(config) = 'object')
);

CREATE TABLE IF NOT EXISTS phis.user_site_external_accounts (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  provider_key VARCHAR(64) NOT NULL,
  external_account_id VARCHAR(512) NOT NULL,
  customer_number VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_site_external_accounts_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT user_site_external_accounts_external_unique
    UNIQUE (site_id, provider_key, external_account_id),
  CONSTRAINT user_site_external_accounts_user_provider_unique
    UNIQUE (user_id, site_id, provider_key)
);

CREATE TABLE IF NOT EXISTS phis.user_auth_factors (
  id UUID PRIMARY KEY,
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  factor_type SMALLINT NOT NULL,
  factor_key BYTEA NULL,
  factor_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext TEXT NULL,
  secret_iv CHAR(24) NULL,
  secret_auth_tag CHAR(32) NULL,
  label VARCHAR(128) NULL,
  confirmed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  consumed_at TIMESTAMPTZ NULL,
  CONSTRAINT user_auth_factors_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT user_auth_factors_type_check
    CHECK (factor_type IN (1, 2, 3)),
  CONSTRAINT user_auth_factors_data_check CHECK (jsonb_typeof(factor_data) = 'object'),
  CONSTRAINT user_auth_factors_secret_check CHECK (
    (factor_type = 2
      AND secret_ciphertext IS NOT NULL
      AND secret_iv IS NOT NULL
      AND secret_auth_tag IS NOT NULL
      AND factor_key IS NULL
      AND consumed_at IS NULL)
    OR
    (factor_type IN (1, 3)
      AND factor_key IS NOT NULL
      AND secret_ciphertext IS NULL
      AND secret_iv IS NULL
      AND secret_auth_tag IS NULL)
  ),
  CONSTRAINT user_auth_factors_user_site_type_key_unique
    UNIQUE (user_id, site_id, factor_type, factor_key)
);

CREATE INDEX IF NOT EXISTS user_auth_factors_user_site_type_idx
  ON phis.user_auth_factors (user_id, site_id, factor_type);

CREATE UNIQUE INDEX IF NOT EXISTS user_auth_factors_passkey_key_unique_idx
  ON phis.user_auth_factors (factor_key)
  WHERE factor_type = 1;

CREATE TABLE IF NOT EXISTS phis.auth_transactions (
  id UUID PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  provider_installation_key VARCHAR(64) NULL,
  user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  method_key VARCHAR(64) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  state_hash CHAR(64) NOT NULL UNIQUE,
  nonce_hash CHAR(64) NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv CHAR(24) NOT NULL,
  payload_auth_tag CHAR(32) NOT NULL,
  next_path VARCHAR(1024) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_transactions_stage_check
    CHECK (stage IN ('primary', 'second-factor', 'step-up', 'recovery'))
);

CREATE INDEX IF NOT EXISTS auth_transactions_expires_at_idx
  ON phis.auth_transactions (expires_at);

CREATE TABLE IF NOT EXISTS phis.user_sessions (
  id UUID PRIMARY KEY,
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  session_secret_hash CHAR(64) NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assurance_level SMALLINT NOT NULL DEFAULT 1,
  auth_state SMALLINT NOT NULL DEFAULT 3,
  auth_policy_revision INT NOT NULL DEFAULT 1,
  auth_method_keys VARCHAR(64)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(64)[],
  next_path VARCHAR(1024) NOT NULL DEFAULT '/',
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ NULL,
  ip_address INET NULL,
  user_agent VARCHAR(512) NULL,
  CONSTRAINT user_sessions_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE,
  CONSTRAINT user_sessions_assurance_level_check CHECK (assurance_level >= 0),
  CONSTRAINT user_sessions_auth_state_check CHECK (auth_state IN (1, 2, 3)),
  CONSTRAINT user_sessions_auth_policy_revision_check CHECK (auth_policy_revision > 0)
);

CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
  ON phis.user_sessions (user_id);

CREATE INDEX IF NOT EXISTS user_sessions_site_id_idx
  ON phis.user_sessions (site_id);

CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
  ON phis.user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS phis.user_password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_password_reset_tokens_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_password_reset_tokens_user_id_idx
  ON phis.user_password_reset_tokens (user_id, site_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS user_password_reset_tokens_site_id_idx
  ON phis.user_password_reset_tokens (site_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS phis.registration_intents (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  email VARCHAR(320) NULL,
  first_name VARCHAR(128) NULL,
  last_name VARCHAR(128) NULL,
  company_name VARCHAR(256) NULL,
  password_ciphertext TEXT NULL,
  password_iv CHAR(24) NULL,
  password_auth_tag CHAR(32) NULL,
  locale VARCHAR(8) NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL DEFAULT 0,
  verification_token_hash CHAR(64) NOT NULL,
  verification_token_expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NULL,
  consumed_at TIMESTAMPTZ NULL,
  meta JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS registration_intents_verification_token_hash_unique
  ON phis.registration_intents (verification_token_hash);

CREATE INDEX IF NOT EXISTS registration_intents_site_email_status_idx
  ON phis.registration_intents (site_id, email, status, created_at DESC);

CREATE INDEX IF NOT EXISTS registration_intents_status_expires_idx
  ON phis.registration_intents (status, verification_token_expires_at);

CREATE INDEX IF NOT EXISTS registration_intents_site_name_parts_idx
  ON phis.registration_intents (site_id, first_name, last_name, created_at DESC);

CREATE TABLE IF NOT EXISTS phis.form_definitions (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  owner_module_id VARCHAR(160) NOT NULL,
  form_id VARCHAR(255) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  status SMALLINT NOT NULL DEFAULT 1,
  flags INT NOT NULL DEFAULT 0,
  title VARCHAR(128) NOT NULL,
  description TEXT NULL,
  category VARCHAR(64) NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  descriptor JSONB NOT NULL,
  submit_handler_key VARCHAR(128) NULL,
  confirm_handler_key VARCHAR(128) NULL,
  preview_handler_key VARCHAR(128) NULL,
  default_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  variant VARCHAR(64) NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT form_definitions_descriptor_v1_check CHECK (
    jsonb_typeof(descriptor) = 'object'
    AND descriptor ->> 'schemaVersion' = '1'
    AND jsonb_typeof(descriptor -> 'fields') = 'array'
    AND jsonb_typeof(descriptor -> 'actions') = 'array'
  ),
  CONSTRAINT form_definitions_owner_module_id_check CHECK (
    owner_module_id ~ '^@[^/]+/[^/]+/.+$'
  ),
  CONSTRAINT form_definitions_form_id_check CHECK (
    form_id ~ '^@[^/]+/[^/]+/forms/[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$'
    AND split_part(owner_module_id, '/', 1) = split_part(form_id, '/', 1)
    AND split_part(owner_module_id, '/', 2) = split_part(form_id, '/', 2)
  ),
  CONSTRAINT form_definitions_status_check CHECK (status IN (0, 1, 2)),
  CONSTRAINT form_definitions_site_form_version_unique UNIQUE (site_id, form_id, version)
);

-- v1 has no migration chain. Reapplying the canonical schema must bring an
-- existing development database to the current ABI without recreating it.
ALTER TABLE phis.form_definitions
  ALTER COLUMN submit_handler_key DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS preview_handler_key VARCHAR(128) NULL;

CREATE INDEX IF NOT EXISTS form_definitions_site_id_form_id_idx
  ON phis.form_definitions (site_id, form_id, version DESC, id DESC);

CREATE INDEX IF NOT EXISTS form_definitions_site_id_owner_module_idx
  ON phis.form_definitions (site_id, owner_module_id, version DESC, id DESC);

CREATE INDEX IF NOT EXISTS form_definitions_site_id_status_idx
  ON phis.form_definitions (site_id, status, form_id, version DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS form_definitions_one_working_draft_idx
  ON phis.form_definitions (site_id, form_id)
  WHERE status = 0;

CREATE UNIQUE INDEX IF NOT EXISTS form_definitions_one_published_idx
  ON phis.form_definitions (site_id, form_id)
  WHERE status = 1;

CREATE TABLE IF NOT EXISTS phis.support_teams (
  id SMALLSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_teams_site_key_unique UNIQUE (site_id, key)
);

CREATE INDEX IF NOT EXISTS support_teams_site_id_idx
  ON phis.support_teams (site_id);

CREATE TABLE IF NOT EXISTS phis.support_team_members (
  team_id SMALLINT NOT NULL REFERENCES phis.support_teams(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS support_team_members_user_id_idx
  ON phis.support_team_members (user_id);

CREATE TABLE IF NOT EXISTS phis.support_tickets (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  type SMALLINT NOT NULL,
  status SMALLINT NOT NULL DEFAULT 0,
  channel SMALLINT NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 1,
  severity SMALLINT NULL,
  flags INT NOT NULL DEFAULT 0,
  requester_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  requester_email VARCHAR(320) NULL,
  assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL,
  subject VARCHAR(512) NOT NULL,
  summary TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_response_due_at TIMESTAMPTZ NULL,
  resolution_due_at TIMESTAMPTZ NULL,
  last_public_message_at TIMESTAMPTZ NULL,
  last_internal_message_at TIMESTAMPTZ NULL,
  resolved_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_tickets_site_status_updated_idx
  ON phis.support_tickets (site_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_assignee_status_updated_idx
  ON phis.support_tickets (site_id, assignee_user_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_team_status_updated_idx
  ON phis.support_tickets (site_id, team_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_requester_email_idx
  ON phis.support_tickets (site_id, requester_email);

CREATE INDEX IF NOT EXISTS support_tickets_site_created_at_idx
  ON phis.support_tickets (site_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.support_ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  channel SMALLINT NOT NULL,
  visibility SMALLINT NOT NULL DEFAULT 0,
  author_type SMALLINT NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  external_message_ref VARCHAR(256) NULL,
  body_text TEXT NOT NULL,
  body_markdown TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_created_idx
  ON phis.support_ticket_messages (ticket_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS phis.support_ticket_tasks (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  type SMALLINT NOT NULL DEFAULT 0,
  status SMALLINT NOT NULL DEFAULT 0,
  flags INT NOT NULL DEFAULT 0,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_tasks_ticket_sort_idx
  ON phis.support_ticket_tasks (ticket_id, sort_order, id);

CREATE INDEX IF NOT EXISTS support_ticket_tasks_ticket_status_idx
  ON phis.support_ticket_tasks (ticket_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.support_ticket_links (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  system SMALLINT NOT NULL,
  type SMALLINT NOT NULL,
  state SMALLINT NULL,
  flags INT NOT NULL DEFAULT 0,
  external_id VARCHAR(256) NOT NULL,
  external_key VARCHAR(256) NULL,
  external_url TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_links_ticket_id_idx
  ON phis.support_ticket_links (ticket_id);

CREATE INDEX IF NOT EXISTS support_ticket_links_external_lookup_idx
  ON phis.support_ticket_links (system, external_id);

CREATE TABLE IF NOT EXISTS phis.support_ticket_assignments (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  from_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  to_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  from_team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL,
  to_team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE SET NULL,
  reason TEXT NULL,
  flags INT NOT NULL DEFAULT 0,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_assignments_ticket_created_idx
  ON phis.support_ticket_assignments (ticket_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.support_ticket_events (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  event_type SMALLINT NOT NULL,
  flags INT NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_ticket_events_ticket_created_idx
  ON phis.support_ticket_events (ticket_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.support_threads (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  ticket_id INT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  type SMALLINT NOT NULL,
  status SMALLINT NOT NULL DEFAULT 0,
  subject VARCHAR(255) NULL,
  flags INT NOT NULL DEFAULT 0,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_threads_site_updated_idx
  ON phis.support_threads (site_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_threads_ticket_updated_idx
  ON phis.support_threads (ticket_id, updated_at DESC, id DESC)
  WHERE ticket_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.support_thread_messages (
  id SERIAL PRIMARY KEY,
  thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE,
  author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  body_text TEXT NOT NULL,
  body_markdown TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_thread_messages_thread_created_idx
  ON phis.support_thread_messages (thread_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS phis.support_thread_recipients (
  id SERIAL PRIMARY KEY,
  thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE,
  recipient_type SMALLINT NOT NULL,
  user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  team_id SMALLINT NULL REFERENCES phis.support_teams(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_thread_recipients_thread_type_idx
  ON phis.support_thread_recipients (thread_id, recipient_type);

CREATE INDEX IF NOT EXISTS support_thread_recipients_user_id_idx
  ON phis.support_thread_recipients (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_thread_recipients_team_id_idx
  ON phis.support_thread_recipients (team_id)
  WHERE team_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS support_thread_recipients_thread_user_unique_idx
  ON phis.support_thread_recipients (thread_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS support_thread_recipients_thread_team_unique_idx
  ON phis.support_thread_recipients (thread_id, team_id)
  WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.support_thread_reads (
  thread_id INT NOT NULL REFERENCES phis.support_threads(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  last_read_message_id INT NULL REFERENCES phis.support_thread_messages(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS support_thread_reads_user_read_idx
  ON phis.support_thread_reads (user_id, read_at DESC);

CREATE TABLE IF NOT EXISTS phis.support_github_integrations (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  owner VARCHAR(128) NOT NULL,
  repo VARCHAR(128) NOT NULL,
  installation_id BIGINT NOT NULL,
  sync_mode SMALLINT NOT NULL DEFAULT 0,
  flags INT NOT NULL DEFAULT 0,
  label_filter JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  updated_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_github_integrations_site_repo_unique UNIQUE (site_id, owner, repo)
);

CREATE INDEX IF NOT EXISTS support_github_integrations_site_id_idx
  ON phis.support_github_integrations (site_id);

CREATE TABLE IF NOT EXISTS phis.support_github_mappings (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  integration_id INT NOT NULL REFERENCES phis.support_github_integrations(id) ON DELETE CASCADE,
  github_issue_number INT NOT NULL,
  github_issue_node_id VARCHAR(128) NULL,
  direction SMALLINT NOT NULL,
  sync_state SMALLINT NOT NULL DEFAULT 0,
  flags INT NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_github_mappings_ticket_issue_unique UNIQUE (ticket_id, integration_id, github_issue_number)
);

CREATE INDEX IF NOT EXISTS support_github_mappings_integration_issue_idx
  ON phis.support_github_mappings (integration_id, github_issue_number);

CREATE INDEX IF NOT EXISTS support_github_mappings_ticket_id_idx
  ON phis.support_github_mappings (ticket_id);

CREATE TABLE IF NOT EXISTS phis.tr_msg (
  id SERIAL PRIMARY KEY,
  msg TEXT NOT NULL,
  msg_hash BYTEA NOT NULL,
  ctx VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tr_msg_hash_ctx_unique UNIQUE (msg_hash, ctx)
);

CREATE TABLE IF NOT EXISTS phis.tr_lang (
  id SERIAL PRIMARY KEY,
  msg_id INT NOT NULL REFERENCES phis.tr_msg(id) ON DELETE CASCADE,
  locale VARCHAR(8) NOT NULL,
  translation TEXT NOT NULL,
  source_hash BYTEA NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tr_lang_msg_locale_unique UNIQUE (msg_id, locale)
);

ALTER TABLE phis.tr_lang
  ADD COLUMN IF NOT EXISTS source_hash BYTEA NULL;

CREATE INDEX IF NOT EXISTS tr_lang_external_source_idx
  ON phis.tr_lang (locale, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.tr_site_msg (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  msg TEXT NOT NULL,
  msg_hash BYTEA NOT NULL,
  ctx VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tr_site_msg_site_hash_ctx_unique UNIQUE (site_id, msg_hash, ctx)
);

CREATE TABLE IF NOT EXISTS phis.tr_site_lang (
  id SERIAL PRIMARY KEY,
  msg_id INT NOT NULL REFERENCES phis.tr_site_msg(id) ON DELETE CASCADE,
  locale VARCHAR(8) NOT NULL,
  translation TEXT NOT NULL,
  source_hash BYTEA NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tr_site_lang_msg_locale_unique UNIQUE (msg_id, locale)
);

ALTER TABLE phis.tr_site_lang
  ADD COLUMN IF NOT EXISTS source_hash BYTEA NULL;

CREATE INDEX IF NOT EXISTS tr_site_lang_external_source_idx
  ON phis.tr_site_lang (locale, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.site_content (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  type SMALLINT NOT NULL,
  slug VARCHAR(255) NOT NULL,
  asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT,
  status SMALLINT NOT NULL DEFAULT 0,
  current_version_id INT NULL,
  published_version_id INT NULL,
  published_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NULL,
  sort_order INT NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_content_site_type_slug_unique UNIQUE (site_id, type, slug)
);

CREATE INDEX IF NOT EXISTS site_content_site_type_status_idx
  ON phis.site_content (site_id, type, status);

CREATE INDEX IF NOT EXISTS site_content_site_asset_idx
  ON phis.site_content (site_id, asset_id)
  WHERE asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS site_content_published_at_idx
  ON phis.site_content (published_at);

CREATE TABLE IF NOT EXISTS phis.site_area_scopes (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- The Area's visibility mask, not a running number: public 1, app 2, admin 8, editor 16,
  -- accounting 64, builder 256. Bits 2, 5 and 7 are unassigned, and those holes are what makes the
  -- column misread at a glance -- 8 looks like the fourth Area and is the third. One value both names
  -- the Area and says what a row is visible in, which is why the mask is stored rather than an
  -- ordinal. PhiCmsVisibilityContext in @phis/contracts/cms decides the numbers -- one file both
  -- phi-server and the site UI read them from -- and nothing may write them out a second time.
  area_id SMALLINT NOT NULL DEFAULT 1,
  published_revision_id INT NULL,
  working_draft_revision_id INT NULL,
  -- The Area's structure and its Module selection are edited apart and published apart, so each keeps
  -- its own Working Draft. Both drafts are ordinary rows in site_area_revisions and both carry a whole
  -- Area: a publish writes only the fields its draft owns into the published revision, and reads the
  -- rest from there. That is what lets two open drafts pass each other without one undoing the other.
  -- There is one published pointer, because a published Area is one state and not two.
  working_module_draft_revision_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_area_scopes_site_area_unique UNIQUE (site_id, area_id)
);

CREATE INDEX IF NOT EXISTS site_area_scopes_site_area_idx
  ON phis.site_area_scopes (site_id, area_id);

CREATE TABLE IF NOT EXISTS phis.site_page_scopes (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- The Area's visibility mask, as in site_area_scopes above.
  area_id SMALLINT NOT NULL DEFAULT 1,
  path VARCHAR(512) NULL,
  owner_module_id VARCHAR(255) NULL,
  preset_key VARCHAR(255) NULL,
  tombstoned_at TIMESTAMPTZ NULL,
  published_revision_id INT NULL,
  working_draft_revision_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_page_scopes_identity_check CHECK (
    (path IS NOT NULL AND owner_module_id IS NULL AND preset_key IS NULL) OR
    (path IS NULL AND owner_module_id IS NOT NULL AND preset_key IS NOT NULL)
  ),
  CONSTRAINT site_page_scopes_module_id_check CHECK (
    owner_module_id IS NULL OR owner_module_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS site_page_scopes_site_area_path_unique_idx
  ON phis.site_page_scopes (site_id, area_id, path)
  WHERE path IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS site_page_scopes_site_area_preset_unique_idx
  ON phis.site_page_scopes (site_id, area_id, owner_module_id, preset_key)
  WHERE owner_module_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS site_page_scopes_site_area_catalog_idx
  ON phis.site_page_scopes (site_id, area_id, tombstoned_at, id);

CREATE SEQUENCE IF NOT EXISTS phis.site_cms_node_id_seq AS INTEGER;

CREATE TABLE IF NOT EXISTS phis.site_area_revisions (
  id SERIAL PRIMARY KEY,
  area_scope_id INT NOT NULL REFERENCES phis.site_area_scopes(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  tree_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  message VARCHAR(256) NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_revision_id INT NULL REFERENCES phis.site_area_revisions(id) ON DELETE SET NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS site_area_revisions_scope_idx
  ON phis.site_area_revisions (area_scope_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.site_page_revisions (
  id SERIAL PRIMARY KEY,
  page_scope_id INT NOT NULL REFERENCES phis.site_page_scopes(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  tree_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  message VARCHAR(256) NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_revision_id INT NULL REFERENCES phis.site_page_revisions(id) ON DELETE SET NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS site_page_revisions_scope_idx
  ON phis.site_page_revisions (page_scope_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.site_content_versions (
  id SERIAL PRIMARY KEY,
  content_id INT NOT NULL REFERENCES phis.site_content(id) ON DELETE CASCADE,
  version_no INT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_content_versions_content_version_unique UNIQUE (content_id, version_no)
);

CREATE TABLE IF NOT EXISTS phis.site_content_version_text (
  id SERIAL PRIMARY KEY,
  version_id INT NOT NULL REFERENCES phis.site_content_versions(id) ON DELETE CASCADE,
  field_name VARCHAR(64) NOT NULL,
  msg_id INT NOT NULL REFERENCES phis.tr_site_msg(id) ON DELETE CASCADE,
  CONSTRAINT site_content_version_text_version_field_unique UNIQUE (version_id, field_name)
);

CREATE TABLE IF NOT EXISTS phis.site_nav_scopes (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  label VARCHAR(128) NULL,
  flags INT NOT NULL DEFAULT 0,
  published_revision_id INT NULL,
  working_draft_revision_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_nav_scopes_site_key_unique UNIQUE (site_id, key)
);

CREATE INDEX IF NOT EXISTS site_nav_scopes_site_id_idx
  ON phis.site_nav_scopes (site_id);

CREATE TABLE IF NOT EXISTS phis.site_nav_revisions (
  id SERIAL PRIMARY KEY,
  nav_scope_id INT NOT NULL REFERENCES phis.site_nav_scopes(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  next_node_sequence BIGINT NOT NULL DEFAULT 1,
  tree_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  message VARCHAR(256) NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_revision_id INT NULL REFERENCES phis.site_nav_revisions(id) ON DELETE SET NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_nav_revisions_next_node_sequence_check
    CHECK (next_node_sequence >= 1 AND next_node_sequence <= 4294967296)
);

CREATE INDEX IF NOT EXISTS site_nav_revisions_scope_idx
  ON phis.site_nav_revisions (nav_scope_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS phis.site_cms_references (
  id BIGSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  source_kind SMALLINT NOT NULL,
  source_scope_id INT NOT NULL,
  source_revision_id INT NULL,
  source_location VARCHAR(1024) NOT NULL,
  target_kind SMALLINT NOT NULL,
  -- The Area's visibility mask, as in site_area_scopes.
  target_area_id SMALLINT NULL,
  target_page_scope_id INT NULL REFERENCES phis.site_page_scopes(id) ON DELETE RESTRICT,
  target_owner_module_id VARCHAR(255) NULL,
  target_preset_key VARCHAR(255) NULL,
  target_asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT,
  fragment VARCHAR(512) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_cms_references_source_kind_check CHECK (source_kind IN (1, 2, 3, 4)),
  CONSTRAINT site_cms_references_target_check CHECK (
    (target_kind = 1 AND target_page_scope_id IS NOT NULL AND target_area_id IS NOT NULL
      AND target_owner_module_id IS NULL AND target_preset_key IS NULL AND target_asset_id IS NULL) OR
    (target_kind = 2 AND target_page_scope_id IS NULL AND target_area_id IS NOT NULL
      AND target_owner_module_id IS NOT NULL AND target_preset_key IS NOT NULL AND target_asset_id IS NULL) OR
    (target_kind = 3 AND target_page_scope_id IS NULL AND target_area_id IS NULL
      AND target_owner_module_id IS NULL AND target_preset_key IS NULL AND target_asset_id IS NOT NULL)
  ),
  CONSTRAINT site_cms_references_source_unique
    UNIQUE (site_id, source_kind, source_scope_id, source_revision_id, source_location)
);

CREATE INDEX IF NOT EXISTS site_cms_references_page_target_idx
  ON phis.site_cms_references (site_id, target_page_scope_id)
  WHERE target_page_scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_cms_references_module_target_idx
  ON phis.site_cms_references (site_id, target_owner_module_id, target_preset_key)
  WHERE target_owner_module_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_cms_references_asset_target_idx
  ON phis.site_cms_references (site_id, target_asset_id)
  WHERE target_asset_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.site_theme_scopes (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL DEFAULT 'default',
  label VARCHAR(128) NULL,
  flags INT NOT NULL DEFAULT 0,
  published_revision_id INT NULL,
  working_draft_revision_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_theme_scopes_site_key_unique UNIQUE (site_id, key)
);

CREATE INDEX IF NOT EXISTS site_theme_scopes_site_id_idx
  ON phis.site_theme_scopes (site_id);

CREATE TABLE IF NOT EXISTS phis.site_theme_revisions (
  id SERIAL PRIMARY KEY,
  theme_scope_id INT NOT NULL REFERENCES phis.site_theme_scopes(id) ON DELETE CASCADE,
  flags INT NOT NULL DEFAULT 0,
  tree_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  message VARCHAR(256) NULL,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_revision_id INT NULL REFERENCES phis.site_theme_revisions(id) ON DELETE SET NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS site_theme_revisions_scope_idx
  ON phis.site_theme_revisions (theme_scope_id, created_at DESC, id DESC);

ALTER TABLE phis.site_area_revisions
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE phis.site_area_scopes
  ADD COLUMN IF NOT EXISTS working_module_draft_revision_id INT NULL;

ALTER TABLE phis.site_page_revisions
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE phis.site_nav_revisions
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE phis.site_nav_revisions
  ADD COLUMN IF NOT EXISTS next_node_sequence BIGINT NOT NULL DEFAULT 1;

ALTER TABLE phis.site_nav_revisions
  DROP CONSTRAINT IF EXISTS site_nav_revisions_next_node_sequence_check;

ALTER TABLE phis.site_nav_revisions
  ADD CONSTRAINT site_nav_revisions_next_node_sequence_check
  CHECK (next_node_sequence >= 1 AND next_node_sequence <= 4294967296);

ALTER TABLE phis.site_theme_revisions
  ADD COLUMN IF NOT EXISTS meta_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS phis.server_addons (
  addon_id VARCHAR(255) PRIMARY KEY,
  package_name VARCHAR(255) NOT NULL,
  package_version VARCHAR(64) NOT NULL,
  server_abi VARCHAR(64) NOT NULL,
  migration_version SMALLINT NOT NULL DEFAULT 0,
  manifest_digest CHAR(64) NOT NULL,
  release_build_id VARCHAR(255) NOT NULL,
  schema_name VARCHAR(63) NULL,
  flags INT NOT NULL DEFAULT 0,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  upgraded_at TIMESTAMPTZ NULL,
  activated_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_addons_migration_version_check CHECK (migration_version >= 0),
  CONSTRAINT server_addons_schema_name_check CHECK (
    schema_name IS NULL OR schema_name ~ '^phis_addon_[a-z0-9_]+$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS server_addons_package_name_unique_idx
  ON phis.server_addons (package_name);

-- Where an Add-on's tables live, derived from its logical id and written down once.
--
-- The derivation is lossy: `@acme-a/b` and `@acme/a-b` compute to the same name. Recording it under a
-- unique index makes the database, not the CLI, the thing that refuses the second one -- and leaves an
-- installed Add-on on the name it already has if the derivation ever changes. NULL means the Add-on
-- owns no tables, which is the common case.
CREATE UNIQUE INDEX IF NOT EXISTS server_addons_schema_name_unique_idx
  ON phis.server_addons (schema_name)
  WHERE schema_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS server_addons_release_build_id_idx
  ON phis.server_addons (release_build_id);

CREATE TABLE IF NOT EXISTS phis.server_capabilities (
  provider_id VARCHAR(255) NOT NULL,
  capability_id VARCHAR(255) NOT NULL,
  interface_digest CHAR(64) NOT NULL,
  release_build_id VARCHAR(255) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_capabilities_provider_capability_unique
    PRIMARY KEY (provider_id, capability_id),
  CONSTRAINT server_capabilities_capability_id_unique UNIQUE (capability_id)
);

CREATE INDEX IF NOT EXISTS server_capabilities_provider_id_idx
  ON phis.server_capabilities (provider_id);

CREATE TABLE IF NOT EXISTS phis.site_server_addons (
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT,
  flags INT NOT NULL DEFAULT 0,
  configuration_status VARCHAR(32) NOT NULL DEFAULT 'missing',
  configuration_version SMALLINT NOT NULL DEFAULT 0,
  provider_account_reference VARCHAR(512) NULL,
  effective_status VARCHAR(32) NOT NULL DEFAULT 'disabled',
  diagnostic_code VARCHAR(128) NULL,
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled_at TIMESTAMPTZ NULL,
  disabled_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_server_addons_site_addon_unique PRIMARY KEY (site_id, addon_id),
  CONSTRAINT site_server_addons_configuration_version_check CHECK (configuration_version >= 0),
  CONSTRAINT site_server_addons_configuration_status_check CHECK (
    configuration_status IN ('missing', 'ready', 'invalid')
  ),
  CONSTRAINT site_server_addons_effective_status_check CHECK (
    effective_status IN (
      'available',
      'missing',
      'disabled',
      'incompatible',
      'misconfigured',
      'unavailable'
    )
  )
);

CREATE INDEX IF NOT EXISTS site_server_addons_addon_id_idx
  ON phis.site_server_addons (addon_id);

-- Added here rather than with the table: `media_spaces` is created long before `server_addons` exists.
--
-- Cascading, unlike the group Space above. There the contents are a person's and what happens to them
-- is a person's decision; here removing the Add-on is already the deliberate, destructive act, and a
-- Space belonging to a package that is gone belongs to nobody.
ALTER TABLE phis.media_spaces
  DROP CONSTRAINT IF EXISTS media_spaces_addon_fk;
ALTER TABLE phis.media_spaces
  ADD CONSTRAINT media_spaces_addon_fk
    FOREIGN KEY (addon_id) REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE;

-- What an Add-on's own object store holds on this Site, and what it is allowed to hold.
--
-- The ceiling is Core's and not the Add-on's, for the reason a ceiling always is: a package that could
-- check its own limit could also not check it, so the number that decides lives where the Add-on cannot
-- reach it. What an Add-on may do with the figure is read it, so it can tell somebody why a write was
-- refused instead of failing them silently.
--
-- Both counts, not just bytes. Two hundred thousand small objects cost a listing, a backup and a
-- provider bill even when the bytes are unremarkable, and no byte limit expresses that.
--
-- NULL is "no ceiling", the same reading as `media_spaces.quota_bytes`, and the used columns are a
-- running total rather than something counted on demand: counting means listing the store, which is the
-- unbounded operation the ceiling exists to prevent.
ALTER TABLE phis.site_server_addons
  ADD COLUMN IF NOT EXISTS storage_quota_bytes BIGINT NULL,
  ADD COLUMN IF NOT EXISTS storage_quota_objects INT NULL,
  ADD COLUMN IF NOT EXISTS storage_used_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_used_objects INT NOT NULL DEFAULT 0;

ALTER TABLE phis.site_server_addons
  DROP CONSTRAINT IF EXISTS site_server_addons_storage_used_check;
ALTER TABLE phis.site_server_addons
  ADD CONSTRAINT site_server_addons_storage_used_check
    CHECK (storage_used_bytes >= 0 AND storage_used_objects >= 0);

-- What roles of an Add-on one user holds on one Site.
--
-- The vocabulary belongs to the Add-on and is declared in its manifest; the assignments belong here, in
-- one Core table rather than one per Add-on. That is what makes "what does this person hold on this
-- Site" answerable across every installed Add-on at once -- with a private table per package, offboarding
-- would mean visiting each of them.
--
-- `role` is text and not a foreign key on purpose. Which roles exist is stated by the manifest, and that
-- is the only truth; a table of roles beside it would be a second one, drifting at the next update. The
-- price is that an assignment can outlive the role it names, which Core reports rather than deletes: a
-- silent removal during an upgrade is lost access nobody asked for.
CREATE TABLE IF NOT EXISTS phis.site_addon_user_roles (
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  role VARCHAR(120) NOT NULL,
  granted_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_addon_user_roles_pkey PRIMARY KEY (site_id, addon_id, user_id, role),
  CONSTRAINT site_addon_user_roles_role_check CHECK (role <> '')
);

-- "What does this person hold here", across Add-ons. The primary key already serves the runtime read.
CREATE INDEX IF NOT EXISTS site_addon_user_roles_site_user_idx
  ON phis.site_addon_user_roles (site_id, user_id);

CREATE TABLE IF NOT EXISTS phis.server_addon_migrations (
  addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE RESTRICT,
  migration_version SMALLINT NOT NULL,
  migration_id VARCHAR(255) NOT NULL,
  checksum CHAR(64) NOT NULL,
  release_build_id VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_addon_migrations_addon_version_unique
    PRIMARY KEY (addon_id, migration_version),
  CONSTRAINT server_addon_migrations_version_check CHECK (migration_version > 0)
);

-- Every secret the server holds, encrypted, so more than one instance can read them.
--
-- A file-backed store needs every secret on every host and needs them again on every rotation; a row
-- is written once and read by all of them. The key that decrypts these rows is deliberately not here:
-- it lives in each instance's runtime configuration and is the only material a new host needs.
--
-- `key_version` is worth nothing until the first rotation and cannot be added after it, because by
-- then there is ciphertext whose key is no longer known.
CREATE TABLE IF NOT EXISTS phis.server_secrets (
  reference VARCHAR(512) PRIMARY KEY,
  site_id SMALLINT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id VARCHAR(255) NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE,
  key_version SMALLINT NOT NULL DEFAULT 1,
  ciphertext TEXT NOT NULL,
  iv CHAR(24) NOT NULL,
  auth_tag CHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT server_secrets_key_version_check CHECK (key_version > 0),
  CONSTRAINT server_secrets_addon_id_check CHECK (
    addon_id IS NULL OR addon_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'
  ),
  CONSTRAINT server_secrets_iv_check CHECK (iv ~ '^[0-9a-f]{24}$'),
  CONSTRAINT server_secrets_auth_tag_check CHECK (auth_tag ~ '^[0-9a-f]{32}$'),
  CONSTRAINT server_secrets_ciphertext_check CHECK (ciphertext ~ '^[0-9a-f]+$')
);

CREATE INDEX IF NOT EXISTS server_secrets_site_idx
  ON phis.server_secrets (site_id)
  WHERE site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS server_secrets_addon_idx
  ON phis.server_secrets (addon_id)
  WHERE addon_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS phis.server_instances (
  instance_id VARCHAR(255) PRIMARY KEY,
  release_build_id VARCHAR(255) NOT NULL,
  addon_manifest_digest CHAR(64) NOT NULL,
  addon_packages_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_digests_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  flags INT NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS server_instances_release_ready_idx
  ON phis.server_instances (release_build_id, ((flags & 1) <> 0), last_seen_at DESC);

/*
 * Objects whose rows are already gone, and the only thing that still knows they exist.
 *
 * A store cannot take part in a transaction. However the rows are ordered, removing the object is the
 * last step and the first that can fail on its own -- and once the Asset row is gone, the storage key
 * is gone with it, so nothing can name the object again. The key is therefore written down inside the
 * transaction that removes the row, and the removal that follows clears the note.
 *
 * What stays here is a retry list, and it is short by construction: a row appears only when a store
 * refused or a process died between the commit and the call. Finding them is a bounded read, which is
 * the whole reason for the table -- the alternative is asking the store what it holds that nobody
 * claims, and that answer costs the whole Space every time it is asked.
 */
CREATE TABLE IF NOT EXISTS phis.media_discarded_objects (
  id BIGSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  storage_profile_id INT NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  discarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The same object discarded twice is the retry, not a second file.
  CONSTRAINT media_discarded_objects_key_unique UNIQUE (storage_profile_id, storage_key)
);

CREATE INDEX IF NOT EXISTS media_discarded_objects_site_idx
  ON phis.media_discarded_objects (site_id, discarded_at, id);
