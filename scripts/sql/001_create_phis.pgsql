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
  module_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_site_memberships_user_site_unique UNIQUE (user_id, site_id),
  CONSTRAINT user_site_memberships_authorization_revision_check
    CHECK (authorization_revision >= 0),
  CONSTRAINT user_site_memberships_module_state_check
    CHECK (jsonb_typeof(module_state) = 'object')
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
  probe JSONB NULL,
  probed_at TIMESTAMPTZ NULL,
  checksum_algorithm VARCHAR(24) NULL,
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
  -- 128 MiB. Large enough for what a conversation carries -- a log, a recording of a fault, an
  -- archive of both -- and two orders of magnitude under what either delivery path can carry.
  max_object_bytes BIGINT NOT NULL DEFAULT 134217728,
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
  checksum_algorithm VARCHAR(24) NULL,
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
 *
 * `sha256-composite` belongs here for the same reason the other two do. It is SHA256 over the part
 * digests of a body divided by a fixed rule, which a browser can produce for a file too large to hash
 * whole -- Web Crypto has no incremental digest. Its value carries the division, so two of them are
 * comparable exactly when they describe the same division, and the algorithm list has to name it or the
 * query that reads these digests would run without an index on the very objects that are largest.
 */
CREATE INDEX IF NOT EXISTS media_assets_space_checksum_idx
  ON phis.media_assets (space_id, checksum_algorithm, checksum_value)
  WHERE checksum_value IS NOT NULL
    AND checksum_algorithm IN ('sha256', 'sha512', 'sha256-composite');
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
  checksum_algorithm VARCHAR(24) NULL,
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
  /*
   * The Provider's own handle on a body it is assembling from parts.
   *
   * Kept because the one thing a Client cannot be asked to do is report an upload it has stopped
   * existing to report. An abandoned multipart upload is billed until it is aborted and does not appear
   * in a listing, so whoever cleans up has to be able to name it without the browser that started it.
   */
  provider_upload_id VARCHAR(512) NULL,
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
  CONSTRAINT media_upload_sessions_plan_kind_check CHECK (upload_plan_kind IN (1, 2, 3)),
  CONSTRAINT media_upload_sessions_provider_upload_id_check
    CHECK ((upload_plan_kind = 3) = (provider_upload_id IS NOT NULL)),
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
  checksum_algorithm VARCHAR(24) NULL,
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

-- A typeface cut along one unicode range, produced on first request from the original the way an image
-- rendition is.
--
-- A table of its own rather than rows in `image_asset_variants`: that table's width and height are
-- NOT NULL for a reason `next/image` depends on, and its `variant_key` is a closed vocabulary where 0 is
-- a thumbnail -- sharing it would make a number mean one thing or another by a column of a different
-- table. `subset_key` follows `PhiFontSubsetKey` in `@phis/contracts/media`; `subset_version` is the
-- rule a cut was made under, and a cut made under an older one is made again rather than served.
CREATE TABLE IF NOT EXISTS phis.font_asset_subsets (
  asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE CASCADE,
  subset_key SMALLINT NOT NULL,
  subset_version SMALLINT NOT NULL,
  storage_profile_id INT NOT NULL,
  storage_key VARCHAR(512) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  bytes BIGINT NULL,
  checksum_algorithm VARCHAR(24) NULL,
  checksum_value VARCHAR(128) NULL,
  CONSTRAINT font_asset_subsets_checksum_check CHECK (
    (checksum_algorithm IS NULL) = (checksum_value IS NULL)
  ),
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset_id, subset_key),
  CONSTRAINT font_asset_subsets_storage_profile_id_fkey
    FOREIGN KEY (storage_profile_id)
    REFERENCES phis.media_storage_profiles (id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT font_asset_subsets_storage_unique UNIQUE (storage_profile_id, storage_key)
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
  -- `0` is "evaluated under nothing": a Core role change sets it, so the next read reevaluates the
  -- session whatever revision the Site policy is at.
  CONSTRAINT user_sessions_auth_policy_revision_check CHECK (auth_policy_revision >= 0)
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

-- What kinds of work a Site's Support handles, and what each kind implies. It was a fixed list
-- compiled into the server, which settled for every Site what kinds exist and left no way to say that
-- one kind is handled in the open and another is not.
CREATE TABLE IF NOT EXISTS phis.support_ticket_types (
  id SMALLSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  key VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  -- 1 = external (the conversation is mirrored to a linked system), 2 = code change,
  -- 4 = offered to requesters.
  flags INT NOT NULL DEFAULT 0,
  -- 0 = a Supporter confirms, 1 = the merge is acceptance.
  close_policy SMALLINT NOT NULL DEFAULT 0,
  -- How long a resolved ticket of this type waits for its requester. NULL falls back to the Site's.
  requester_window_days SMALLINT NULL,
  -- How many of this type one person may open for themselves per period. NULL is no limit, which is
  -- what a type has until a Site says otherwise: a limit is a restriction, and one that arrived by
  -- default would refuse people on a Site that never asked for it.
  requester_allowance SMALLINT NULL,
  -- 0 = none, 1 = calendar month, 2 = calendar year. A calendar period and not a rolling window of
  -- days, unlike `requester_window_days` above: that one measures a single ticket's silence and starts
  -- when the ticket does, where this is a budget somebody has to be able to name the start of.
  requester_allowance_period SMALLINT NOT NULL DEFAULT 0,
  -- Retirement, which replaces deleting a type, as `site_groups` does it: the row and its key stay,
  -- a retired type is offered to nobody, and the tickets already opened with it keep naming it.
  retired_at TIMESTAMPTZ NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_ticket_types_site_key_unique UNIQUE (site_id, key),
  CONSTRAINT support_ticket_types_id_site_unique UNIQUE (id, site_id),
  CONSTRAINT support_ticket_types_window_check
    CHECK (requester_window_days IS NULL OR requester_window_days >= 0),
  -- Waiting for a merge presumes there is one: a type without the code-change flag has nothing to wait
  -- for, and its tickets are closed by a person.
  CONSTRAINT support_ticket_types_close_policy_check
    CHECK (close_policy = 0 OR (flags & 2) = 2),
  -- The two halves of the allowance are one statement and cannot be half-written. A count without a
  -- period does not say five of what, and a period without a count limits nothing while looking as
  -- though it does -- which is the version somebody would discover by being let through.
  --
  -- Written as an equality of two IS NULL tests rather than as the two cases OR'd together, because the
  -- obvious spelling does not hold. `requester_allowance >= 0` is NULL when the column is, `false OR
  -- NULL` is NULL, and a CHECK that evaluates to NULL passes. The half-written pair this exists to
  -- refuse is exactly the one that would have been let through.
  CONSTRAINT support_ticket_types_allowance_check
    CHECK (
      requester_allowance_period IN (0, 1, 2)
      AND (requester_allowance IS NULL) = (requester_allowance_period = 0)
      AND (requester_allowance IS NULL OR requester_allowance >= 0)
    )
);

-- Where Support work is routed. Membership is not here: a queue names one Site group, which is who its
-- people are, and what is left is the routing that is not a membership property.
CREATE TABLE IF NOT EXISTS phis.support_queues (
  id SMALLSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  group_id INT NOT NULL,
  key VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  -- 1 = the entry queue, where work with no queue named arrives.
  flags INT NOT NULL DEFAULT 0,
  -- Retirement, which replaces deleting a queue, as `site_groups` does it: the row and its key stay,
  -- nothing routes to a retired queue, and the tickets standing in it are still in it.
  retired_at TIMESTAMPTZ NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_queues_site_key_unique UNIQUE (site_id, key),
  CONSTRAINT support_queues_id_site_unique UNIQUE (id, site_id),
  -- Deliberately without a cascade, as `media_spaces` is: no surface deletes a group, so this fails
  -- against a stray statement instead of taking a Site's Support routing with it.
  CONSTRAINT support_queues_group_site_fk
    FOREIGN KEY (group_id, site_id)
    REFERENCES phis.site_groups (id, site_id)
);

CREATE INDEX IF NOT EXISTS support_queues_group_id_idx
  ON phis.support_queues (group_id);

-- Requests handed to one person on top of the periodic allowance their ticket type gives everybody.
--
-- A stock and not a raised limit, and the difference is what the table is for. The limit on the type
-- renews and is lost at each boundary; this is bought or granted, does not renew, and survives the
-- boundary until it is spent or expires. A ticket spends the periodic allowance first and reaches this
-- only when that is empty, so somebody who was handed ten does not find them eaten in a month the free
-- ones would have covered.
--
-- Who writes it is by design not Support. Whether a customer paid for more is knowledge that lives in
-- whatever sold it to them, which is another Add-on; Support states the arithmetic and hands over
-- `support:v1`'s `grant`. See design/SUPPORT.md section 5.
CREATE TABLE IF NOT EXISTS phis.support_allowance_grants (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- Always a type, never "any type". The allowance it adds to is the type's, so a grant that named none
  -- would be a number with nothing to add it to -- and the question of which types it counted against
  -- would be asked for the first time by whoever was refused.
  type_id SMALLINT NOT NULL,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  -- The Add-on that handed it over, in the `@scope/name` form every provider id takes.
  provider_id VARCHAR(128) NOT NULL,
  -- The granter's own name for the occasion: an order number, a contract line. Unique per provider,
  -- which is what makes granting idempotent -- a payment provider retries its webhook, and a shop with
  -- no reference to give would hand over the ten twice and never notice.
  reference VARCHAR(190) NOT NULL,
  amount SMALLINT NOT NULL,
  -- Spent, counted here rather than derived from the tickets: a ticket may be deleted, and a stock that
  -- refilled itself when one was would be a way to get more by throwing work away.
  consumed SMALLINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NULL,
  -- A refund, a chargeback, a contract that ended. The unspent remainder stops counting; the tickets
  -- already opened against it stand, because a payment reversed later does not un-have a conversation.
  revoked_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_allowance_grants_provider_id_check
    CHECK (provider_id ~ '^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$'),
  CONSTRAINT support_allowance_grants_reference_unique
    UNIQUE (site_id, provider_id, reference),
  CONSTRAINT support_allowance_grants_amount_check
    CHECK (amount > 0 AND consumed >= 0 AND consumed <= amount),
  CONSTRAINT support_allowance_grants_type_site_fk
    FOREIGN KEY (type_id, site_id)
    REFERENCES phis.support_ticket_types (id, site_id)
);

-- What the consumption pass reads: this person's live stock of this type, oldest expiry first.
CREATE INDEX IF NOT EXISTS support_allowance_grants_user_type_idx
  ON phis.support_allowance_grants (site_id, user_id, type_id, expires_at NULLS LAST, id)
  WHERE revoked_at IS NULL;

-- Threads are conversations between people on one Site: two colleagues, a group, two groups, or a
-- requester and a Support queue. They were Support's own until the cases outside it arrived, which is
-- why nothing here carries the `support_` prefix any more and why membership is `site_groups` rather
-- than a second group system. See design/THREADS.md.
CREATE TABLE IF NOT EXISTS phis.threads (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- 0 = direct, 1 = group, 2 = cross-group, 3 = support. Fixed when the thread is opened: it says which
  -- conversation this is, and a Site offers each one only while a Module declares it.
  kind SMALLINT NOT NULL,
  -- 0 = open, 1 = archived. One row carries it, so archiving closes the thread for everyone in it
  -- rather than hiding it from one reader.
  status SMALLINT NOT NULL DEFAULT 0,
  -- The name of the whole chain: the row in an inbox, the heading over the messages, what a
  -- notification is called. Nullable for the integration path alone -- a mail can arrive with an empty
  -- Subject header and is still a conversation, and losing the message to protect a heading would be the
  -- wrong trade. A person opening one is asked for it and the Site route refuses without it, so NULL in
  -- practice means an integration had none.
  subject VARCHAR(255) NULL,
  flags INT NOT NULL DEFAULT 0,
  -- The Add-on that opened this thread with no actor behind it, and may therefore reach it again
  -- without one. NULL is Core's own, which is every thread a person opened.
  owner_provider_id VARCHAR(255) NULL,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  -- The newest message, kept here so an inbox orders and previews without a lateral join per row. The
  -- constraint is added after `thread_messages` exists, because the two reference each other.
  last_message_id INT NULL,
  -- The newest message that is not `Internal`: what a reader who is not Staff orders, previews and
  -- counts unread by, so a note written past a customer does not show them a thread as changed.
  last_public_message_id INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT threads_owner_provider_id_check
    CHECK (owner_provider_id IS NULL OR owner_provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  -- What a ticket's composite foreign key points at, so a ticket and its thread cannot end up on
  -- different Sites.
  CONSTRAINT threads_id_site_unique UNIQUE (id, site_id)
);

CREATE INDEX IF NOT EXISTS threads_site_updated_idx
  ON phis.threads (site_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS threads_site_kind_updated_idx
  ON phis.threads (site_id, kind, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS threads_owner_provider_idx
  ON phis.threads (owner_provider_id, site_id)
  WHERE owner_provider_id IS NOT NULL;

-- Who is in a thread. A group participates as a group: its members are resolved when the thread is
-- read, so somebody who joins afterwards is in the conversation and somebody who leaves is not.
-- Expanding a group into people here would freeze a membership that keeps moving.
CREATE TABLE IF NOT EXISTS phis.thread_participants (
  id SERIAL PRIMARY KEY,
  thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE,
  -- 0 = user, 1 = group.
  participant_kind SMALLINT NOT NULL,
  user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  group_id INT NULL REFERENCES phis.site_groups(id) ON DELETE CASCADE,
  -- 1 = requester, 2 = external consent, 4 = left, 8 = muted.
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT thread_participants_kind_check CHECK (
    (participant_kind = 0 AND user_id IS NOT NULL AND group_id IS NULL)
    OR (participant_kind = 1 AND group_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS thread_participants_thread_kind_idx
  ON phis.thread_participants (thread_id, participant_kind);

CREATE INDEX IF NOT EXISTS thread_participants_user_id_idx
  ON phis.thread_participants (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS thread_participants_group_id_idx
  ON phis.thread_participants (group_id)
  WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS thread_participants_thread_user_unique_idx
  ON phis.thread_participants (thread_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS thread_participants_thread_group_unique_idx
  ON phis.thread_participants (thread_id, group_id)
  WHERE group_id IS NOT NULL;

-- A thread is about at most one person. Internal messages are written past the requester, so a second
-- one would make "hidden from them" a question with two answers.
CREATE UNIQUE INDEX IF NOT EXISTS thread_participants_one_requester_idx
  ON phis.thread_participants (thread_id)
  WHERE (flags & 1) = 1;

CREATE TABLE IF NOT EXISTS phis.thread_messages (
  id SERIAL PRIMARY KEY,
  thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE,
  -- 0 = user, 1 = integration, 2 = system. An integration is not dressed up as a person: it names the
  -- provider relaying it and carries the outside author in `meta`.
  author_kind SMALLINT NOT NULL,
  -- Deleting a user must not delete what they wrote, so this becomes NULL while the kind stays `user`.
  author_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  author_provider_id VARCHAR(255) NULL,
  body_text TEXT NOT NULL,
  body_markdown TEXT NULL,
  -- The language the body is written in. Nobody is asked for it: no person gets a language picker and no
  -- Site route accepts one, because a translator determines the source language itself. Two things write
  -- it. An integration declares it through the threads capability, from something it has -- a mail header,
  -- the locale of a form's page. And a translation of a message that declared none stores what the
  -- provider recognised, because that arrives free with a translation somebody paid for and dropping it
  -- would leave the column empty for everything a person ever wrote. The second carries flag 32,
  -- LangDetected, and never overwrites the first: a declaration is not a guess, and a guess about five
  -- characters is a coin toss that a router must be able to recognise as one.
  -- NULL is never to be read as the Site's default. It names a locale from the platform capability
  -- table, not a translation provider's list: a provider is swapped and a language leaves its list,
  -- while the message stays written in what it was written in. Its case is filtering and routing, which
  -- reading cannot do -- nothing that comes into being while somebody reads fits a WHERE clause.
  source_lang VARCHAR(8) NULL,
  -- 1 = internal, 2 = confidential, 4 = edited, 8 = redacted, 16 = imported, 32 = lang_detected.
  -- `internal` is who may read it; `confidential` is where it may go, which is nowhere outside Core;
  -- `lang_detected` says source_lang was recognised by a translator rather than declared by a deliverer.
  flags INT NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT thread_messages_author_check CHECK (
    (author_kind = 0 AND author_provider_id IS NULL)
    OR (author_kind = 1 AND author_provider_id IS NOT NULL AND author_user_id IS NULL)
    OR (author_kind = 2 AND author_provider_id IS NULL AND author_user_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS thread_messages_thread_created_idx
  ON phis.thread_messages (thread_id, created_at ASC, id ASC);

-- Added here rather than with the table: `threads.last_message_id` points at a row in
-- `thread_messages`, which points back at `threads`, and one of the two directions has to be declared
-- after both tables exist.
--
-- Dropped and re-added rather than added once, because that is a constraint's `IF NOT EXISTS`: the
-- script has to be runnable against a database that already has it. Columns do not need this -- they
-- belong in their `CREATE TABLE` and a development database that predates one is altered by hand
-- ([DB.md](../../DB.md)).
ALTER TABLE phis.threads
  DROP CONSTRAINT IF EXISTS threads_last_message_id_fkey;

ALTER TABLE phis.threads
  ADD CONSTRAINT threads_last_message_id_fkey
  FOREIGN KEY (last_message_id) REFERENCES phis.thread_messages(id) ON DELETE SET NULL;

ALTER TABLE phis.threads
  DROP CONSTRAINT IF EXISTS threads_last_public_message_id_fkey;

ALTER TABLE phis.threads
  ADD CONSTRAINT threads_last_public_message_id_fkey
  FOREIGN KEY (last_public_message_id) REFERENCES phis.thread_messages(id) ON DELETE SET NULL;

-- What an integration calls a message it relayed, so the same delivery arriving twice writes one
-- message. The Site is part of the key because one repository may be linked from two Sites, and the
-- external id would otherwise collide between them.
CREATE TABLE IF NOT EXISTS phis.thread_message_refs (
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL,
  external_id VARCHAR(256) NOT NULL,
  message_id INT NOT NULL REFERENCES phis.thread_messages(id) ON DELETE CASCADE,
  -- 1 = imported, 2 = exported. What came from outside is never sent back out, which is what stops a
  -- mirror from echoing.
  flags INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (site_id, provider_id, external_id)
);

CREATE INDEX IF NOT EXISTS thread_message_refs_message_id_idx
  ON phis.thread_message_refs (message_id);

-- What a message carries besides its text. See design/THREADS.md section 5.
--
-- The audience is the message's, never the Asset's Space: an attachment is readable by whoever may read
-- the message it hangs on, and that is the whole rule. Custody says who pays for the bytes and who
-- administers them, which for one conversation would give four different answers depending on who
-- happened to attach the file -- and none of them expresses that an `Internal` note is invisible to the
-- customer reading the thread around it.
CREATE TABLE IF NOT EXISTS phis.thread_message_assets (
  message_id INT NOT NULL REFERENCES phis.thread_messages(id) ON DELETE CASCADE,
  -- Deliberately refusing, against the message's CASCADE. A message that goes takes its links with it,
  -- because a link to nothing records nothing; an Asset something still hangs on does not go at all.
  -- That is what stops a submitter pulling the evidence out from under a ticket: the file stays theirs,
  -- on their quota, but their delete is refused while a message points at it.
  --
  -- `NO ACTION` deferred rather than `RESTRICT`, which is the same refusal at a different moment and is
  -- the only one available: RESTRICT is checked the instant the row goes and cannot be deferred. It has
  -- to be, because deleting a Site reaches this table twice -- down the message's cascade and down the
  -- Asset's -- in no fixed order. Checked at commit, the message side has already taken the link away,
  -- so the Site goes; a single Asset a message still names fails the same check, and does not.
  asset_id INT NOT NULL REFERENCES phis.media_assets(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  flags INT NOT NULL DEFAULT 0,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, asset_id)
);

-- Asked from the Asset's side by the delete path, which has to say "still attached" rather than let a
-- constraint violation surface as one.
CREATE INDEX IF NOT EXISTS thread_message_assets_asset_id_idx
  ON phis.thread_message_assets (asset_id);

CREATE TABLE IF NOT EXISTS phis.thread_reads (
  thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES phis.user_accounts(id) ON DELETE CASCADE,
  last_read_message_id INT NULL REFERENCES phis.thread_messages(id) ON DELETE SET NULL,
  read_at TIMESTAMPTZ NULL,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS thread_reads_user_read_idx
  ON phis.thread_reads (user_id, read_at DESC);

-- Which kinds of thread this Site offers. Materialized from what its active Modules declare, the way
-- declared Media Space kinds are: a Site gains a kind by running a Module that needs it, and a kind
-- that stops being declared hides its threads without deleting anything.
CREATE TABLE IF NOT EXISTS phis.site_thread_config (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- 1 = direct, 2 = group, 4 = cross-group, 8 = support.
  flags INT NOT NULL DEFAULT 0,
  -- How long a resolved ticket waits for its requester, in days. 0 means it waits for a Supporter.
  requester_window_days SMALLINT NOT NULL DEFAULT 14,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_thread_config_window_check CHECK (requester_window_days >= 0)
);

CREATE TABLE IF NOT EXISTS phis.support_tickets (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- The Site's own type, which says whether this conversation may leave the Site and what ends it.
  type_id SMALLINT NOT NULL,
  status SMALLINT NOT NULL DEFAULT 0,
  channel SMALLINT NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 1,
  severity SMALLINT NULL,
  flags INT NOT NULL DEFAULT 0,
  requester_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  requester_email VARCHAR(320) NULL,
  assignee_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL,
  -- Which granted stock this ticket came out of, or NULL where it came out of the periodic allowance.
  -- Not a flag: the id is what lets whoever sold the stock say which requests their customer spent it
  -- on, and "was this a paid one" is answered by the same column for free.
  allowance_grant_id INT NULL REFERENCES phis.support_allowance_grants(id) ON DELETE SET NULL,
  -- The ticket's conversation. A ticket is the workflow record -- status, priority, assignment, tasks --
  -- and everything anybody says about it is the thread, which is the same thread model every other
  -- conversation on the Site uses.
  thread_id INT NOT NULL,
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_tickets_thread_unique UNIQUE (thread_id),
  CONSTRAINT support_tickets_thread_site_fk
    FOREIGN KEY (thread_id, site_id)
    REFERENCES phis.threads (id, site_id),
  CONSTRAINT support_tickets_type_site_fk
    FOREIGN KEY (type_id, site_id)
    REFERENCES phis.support_ticket_types (id, site_id)
);

CREATE INDEX IF NOT EXISTS support_tickets_site_status_updated_idx
  ON phis.support_tickets (site_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_assignee_status_updated_idx
  ON phis.support_tickets (site_id, assignee_user_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_queue_status_updated_idx
  ON phis.support_tickets (site_id, queue_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS support_tickets_site_requester_email_idx
  ON phis.support_tickets (site_id, requester_email);

CREATE INDEX IF NOT EXISTS support_tickets_site_created_at_idx
  ON phis.support_tickets (site_id, created_at DESC, id DESC);

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

CREATE TABLE IF NOT EXISTS phis.support_ticket_assignments (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  from_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  to_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  from_queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL,
  to_queue_id SMALLINT NULL REFERENCES phis.support_queues(id) ON DELETE SET NULL,
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

-- References from a Phi record into another system. The provider is the Add-on that wrote the link and
-- the whole of the ownership rule; a link carrying `synced` is also what lets that Add-on reach the
-- record's thread with no actor, which is why unlinking ends that reach.
CREATE TABLE IF NOT EXISTS phis.resource_links (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- Exactly one subject, as a real reference rather than a kind and a bare integer: a polymorphic id
  -- has no foreign key, and a link whose subject is gone is a row nothing cleans up.
  thread_id INT NULL REFERENCES phis.threads(id) ON DELETE CASCADE,
  ticket_id INT NULL REFERENCES phis.support_tickets(id) ON DELETE CASCADE,
  ticket_task_id INT NULL REFERENCES phis.support_ticket_tasks(id) ON DELETE CASCADE,
  provider_id VARCHAR(255) NOT NULL,
  -- The provider's own vocabulary. Core stores and indexes both and interprets neither.
  type SMALLINT NOT NULL,
  external_id VARCHAR(256) NOT NULL,
  url TEXT NULL,
  state SMALLINT NULL,
  -- 1 = synced.
  flags INT NOT NULL DEFAULT 0,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resource_links_provider_id_check
    CHECK (provider_id ~ '^@[^/]+/[^/]+(?:/[^/]+)*$'),
  CONSTRAINT resource_links_one_subject_check CHECK (
    (thread_id IS NOT NULL)::int
    + (ticket_id IS NOT NULL)::int
    + (ticket_task_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT resource_links_site_provider_external_unique
    UNIQUE (site_id, provider_id, type, external_id)
);

CREATE INDEX IF NOT EXISTS resource_links_thread_idx
  ON phis.resource_links (thread_id, provider_id)
  WHERE thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS resource_links_ticket_idx
  ON phis.resource_links (ticket_id, provider_id)
  WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS resource_links_ticket_task_idx
  ON phis.resource_links (ticket_task_id, provider_id)
  WHERE ticket_task_id IS NOT NULL;

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

CREATE INDEX IF NOT EXISTS tr_site_lang_external_source_idx
  ON phis.tr_site_lang (locale, source_hash)
  WHERE source_hash IS NOT NULL;

-- Change markers for the translation stores. A Site keeps translations without expiry and compares these
-- on every Site config read; a different value empties that scope. Only equality means anything: the
-- value is a fresh number per change, not a count, so a reset costs one refill and nothing else.
CREATE SEQUENCE IF NOT EXISTS phis.tr_marker_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS phis.tr_marker (
  scope VARCHAR(16) PRIMARY KEY CHECK (scope = 'global'),
  marker BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS phis.tr_site_marker (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  marker BIGINT NOT NULL
);

-- The request path that fills a missing translation sets `phis.translation_fill` for its transaction and
-- is skipped: it adds what no Site holds yet, and taking the marker row lock there would serialize every
-- concurrent fill of a Site. Every other write moves the marker, whichever path it comes from.
CREATE OR REPLACE FUNCTION phis.tr_touch_global_marker() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('phis.translation_fill', true) = 'on' THEN
    RETURN NULL;
  END IF;
  INSERT INTO phis.tr_marker (scope, marker)
  VALUES ('global', nextval('phis.tr_marker_seq'))
  ON CONFLICT (scope) DO UPDATE SET marker = EXCLUDED.marker;
  RETURN NULL;
END;
$$;

-- `changed_rows` is the statement's transition table; a TRUNCATE has none and moves every Site. Rows whose
-- message or Site is already gone in the same statement (a cascade) drop out of the join: the delete on
-- `tr_site_msg` moves the marker for them, and a deleted Site has nothing left to mark.
CREATE OR REPLACE FUNCTION phis.tr_touch_site_markers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('phis.translation_fill', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO phis.tr_site_marker (site_id, marker)
    SELECT sites.id, nextval('phis.tr_marker_seq') FROM phis.sites AS sites
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSIF TG_TABLE_NAME = 'tr_site_msg' THEN
    INSERT INTO phis.tr_site_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.tr_marker_seq')
    FROM (
      SELECT DISTINCT changed.site_id
      FROM changed_rows AS changed
      JOIN phis.sites AS sites ON sites.id = changed.site_id
    ) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSE
    INSERT INTO phis.tr_site_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.tr_marker_seq')
    FROM (
      SELECT DISTINCT msg.site_id
      FROM changed_rows AS changed
      JOIN phis.tr_site_msg AS msg ON msg.id = changed.msg_id
    ) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tr_lang_touch_marker ON phis.tr_lang;
CREATE TRIGGER tr_lang_touch_marker
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON phis.tr_lang
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_global_marker();

-- A trigger with a transition table serves one event, hence one per event.
DROP TRIGGER IF EXISTS tr_site_lang_touch_marker_insert ON phis.tr_site_lang;
CREATE TRIGGER tr_site_lang_touch_marker_insert
  AFTER INSERT ON phis.tr_site_lang REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_lang_touch_marker_update ON phis.tr_site_lang;
CREATE TRIGGER tr_site_lang_touch_marker_update
  AFTER UPDATE ON phis.tr_site_lang REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_lang_touch_marker_delete ON phis.tr_site_lang;
CREATE TRIGGER tr_site_lang_touch_marker_delete
  AFTER DELETE ON phis.tr_site_lang REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_lang_touch_marker_truncate ON phis.tr_site_lang;
CREATE TRIGGER tr_site_lang_touch_marker_truncate
  AFTER TRUNCATE ON phis.tr_site_lang
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_msg_touch_marker_update ON phis.tr_site_msg;
CREATE TRIGGER tr_site_msg_touch_marker_update
  AFTER UPDATE ON phis.tr_site_msg REFERENCING NEW TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_msg_touch_marker_delete ON phis.tr_site_msg;
CREATE TRIGGER tr_site_msg_touch_marker_delete
  AFTER DELETE ON phis.tr_site_msg REFERENCING OLD TABLE AS changed_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

DROP TRIGGER IF EXISTS tr_site_msg_touch_marker_truncate ON phis.tr_site_msg;
CREATE TRIGGER tr_site_msg_touch_marker_truncate
  AFTER TRUNCATE ON phis.tr_site_msg
  FOR EACH STATEMENT EXECUTE FUNCTION phis.tr_touch_site_markers();

CREATE TABLE IF NOT EXISTS phis.site_content (
  id SERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  type SMALLINT NOT NULL,
  slug VARCHAR(255) NOT NULL,
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
  -- The path this Page will answer on once its pending change is published. NULL when none stands.
  draft_path VARCHAR(512) NULL,
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
  ),
  -- Only a Site-owned Page has a path of its own, so only a Site-owned Page can have a pending one.
  CONSTRAINT site_page_scopes_draft_path_check CHECK (
    draft_path IS NULL OR path IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS site_page_scopes_site_area_path_unique_idx
  ON phis.site_page_scopes (site_id, area_id, path)
  WHERE path IS NOT NULL;

-- The pending paths contend with each other exactly as the live ones do, and for the same reason: two
-- Pages must not arrive at one address, and a query that checks for it lets a second writer through.
CREATE UNIQUE INDEX IF NOT EXISTS site_page_scopes_site_area_draft_path_unique_idx
  ON phis.site_page_scopes (site_id, area_id, draft_path)
  WHERE draft_path IS NOT NULL;

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
  -- On the version, not the content row: a revision pins the version it shows, and an image swapped
  -- in a draft would otherwise be live the moment the draft is saved.
  asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id INT NULL REFERENCES phis.user_accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_content_versions_content_version_unique UNIQUE (content_id, version_no)
);

CREATE INDEX IF NOT EXISTS site_content_versions_asset_idx
  ON phis.site_content_versions (asset_id)
  WHERE asset_id IS NOT NULL;

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
  target_asset_id INT NULL REFERENCES phis.media_assets(id) ON DELETE RESTRICT,
  fragment VARCHAR(512) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_cms_references_source_kind_check CHECK (source_kind IN (1, 2, 3, 4, 5)),
  -- Two kinds and a gap where a third was. A Module Page target is not indexed: the Site owns neither
  -- the Page nor its path, switching the Module off is reversible and gives the routes back, and there
  -- is no row for a foreign key to point at. The kinds keep their numbers so the two that remain mean
  -- what they always did.
  CONSTRAINT site_cms_references_target_check CHECK (
    (target_kind = 1 AND target_page_scope_id IS NOT NULL AND target_area_id IS NOT NULL
      AND target_asset_id IS NULL) OR
    (target_kind = 3 AND target_page_scope_id IS NULL AND target_area_id IS NULL
      AND target_asset_id IS NOT NULL)
  ),
  CONSTRAINT site_cms_references_source_unique
    UNIQUE (site_id, source_kind, source_scope_id, source_revision_id, source_location)
);

CREATE INDEX IF NOT EXISTS site_cms_references_page_target_idx
  ON phis.site_cms_references (site_id, target_page_scope_id)
  WHERE target_page_scope_id IS NOT NULL;
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

-- Change marker for what a Site keeps of its published data between reads: its config (the `sites` row,
-- theme record and locales included) and its Navigation, whose targets are published Pages, plus the
-- published Areas and Theme any cache of rendered pages rests on. `GET /api/v1/site` carries it; every
-- process of a Site refreshes its config at most every few seconds and empties its other read caches when
-- the marker moved, so a publish reaches all of them within that interval, not only the process the write
-- passed through. As with the translation markers, only equality means anything.
--
-- Drafts do not move it. The Builder saves drafts as an author works and a Site holds nothing of a draft,
-- so a marker that moved on them would only empty every Site process's cache for no change it could see.
CREATE SEQUENCE IF NOT EXISTS phis.site_read_marker_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS phis.site_read_marker (
  site_id SMALLINT PRIMARY KEY REFERENCES phis.sites(id) ON DELETE CASCADE,
  marker BIGINT NOT NULL
);

-- A statement trigger with transition tables, as for the translation markers. On the scope tables only a
-- published pointer that changed counts (and for Pages the address and tombstone, which publishing
-- writes); an inserted or deleted scope always counts. Rows whose Site is gone in the same statement drop
-- out of the join: a deleted Site has nothing left to mark.
CREATE OR REPLACE FUNCTION phis.site_read_touch_markers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT sites.id, nextval('phis.site_read_marker_seq') FROM phis.sites AS sites
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSIF TG_TABLE_NAME = 'sites' THEN
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT touched.id, nextval('phis.site_read_marker_seq')
    FROM (SELECT DISTINCT new_rows.id FROM new_rows JOIN phis.sites AS sites ON sites.id = new_rows.id) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.site_read_marker_seq')
    FROM (SELECT DISTINCT new_rows.site_id FROM new_rows JOIN phis.sites AS sites ON sites.id = new_rows.site_id) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.site_read_marker_seq')
    FROM (SELECT DISTINCT old_rows.site_id FROM old_rows JOIN phis.sites AS sites ON sites.id = old_rows.site_id) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSIF TG_TABLE_NAME = 'site_page_scopes' THEN
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.site_read_marker_seq')
    FROM (
      SELECT DISTINCT new_rows.site_id
      FROM new_rows
      JOIN old_rows ON old_rows.id = new_rows.id
      JOIN phis.sites AS sites ON sites.id = new_rows.site_id
      WHERE new_rows.published_revision_id IS DISTINCT FROM old_rows.published_revision_id
         OR new_rows.path IS DISTINCT FROM old_rows.path
         OR new_rows.tombstoned_at IS DISTINCT FROM old_rows.tombstoned_at
    ) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  ELSE
    INSERT INTO phis.site_read_marker (site_id, marker)
    SELECT touched.site_id, nextval('phis.site_read_marker_seq')
    FROM (
      SELECT DISTINCT new_rows.site_id
      FROM new_rows
      JOIN old_rows ON old_rows.id = new_rows.id
      JOIN phis.sites AS sites ON sites.id = new_rows.site_id
      WHERE new_rows.published_revision_id IS DISTINCT FROM old_rows.published_revision_id
    ) AS touched
    ON CONFLICT (site_id) DO UPDATE SET marker = EXCLUDED.marker;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sites_touch_read_marker_update ON phis.sites;
CREATE TRIGGER sites_touch_read_marker_update
  AFTER UPDATE ON phis.sites REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION phis.site_read_touch_markers();

DO $$
DECLARE
  scope_table TEXT;
BEGIN
  -- One trigger per event and table: a trigger with transition tables serves one event.
  FOREACH scope_table IN ARRAY ARRAY['site_page_scopes', 'site_area_scopes', 'site_nav_scopes', 'site_theme_scopes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_touch_read_marker_insert ON phis.%1$s', scope_table);
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch_read_marker_insert AFTER INSERT ON phis.%1$s '
      'REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION phis.site_read_touch_markers()',
      scope_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_touch_read_marker_update ON phis.%1$s', scope_table);
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch_read_marker_update AFTER UPDATE ON phis.%1$s '
      'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION phis.site_read_touch_markers()',
      scope_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_touch_read_marker_delete ON phis.%1$s', scope_table);
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch_read_marker_delete AFTER DELETE ON phis.%1$s '
      'REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION phis.site_read_touch_markers()',
      scope_table);
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_touch_read_marker_truncate ON phis.%1$s', scope_table);
    EXECUTE format(
      'CREATE TRIGGER %1$s_touch_read_marker_truncate AFTER TRUNCATE ON phis.%1$s '
      'FOR EACH STATEMENT EXECUTE FUNCTION phis.site_read_touch_markers()',
      scope_table);
  END LOOP;
END;
$$;

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
  storage_quota_bytes BIGINT NULL,
  storage_quota_objects INT NULL,
  storage_used_bytes BIGINT NOT NULL DEFAULT 0,
  storage_used_objects INT NOT NULL DEFAULT 0,
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
  ),
  CONSTRAINT site_server_addons_storage_used_check
    CHECK (storage_used_bytes >= 0 AND storage_used_objects >= 0)
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

-- Which signed deliveries this server has already accepted.
--
-- A webhook is retried whenever the sender is unsure it arrived, and a retry carries the delivery id of
-- the first attempt. Without this table the second copy would be a second message in somebody's thread,
-- and an integration would have to make every handler idempotent by itself -- which is exactly the work
-- Core can do once, at the door, for every Add-on.
--
-- The row is written before the handler runs, not after. A delivery that was accepted and then failed
-- halfway is not one to replay blindly: the sender's retry would repeat whatever the first attempt
-- already did. What a handler needs to survive is stated in its own tables, where it can be seen.
--
-- No Site column. A delivery id is the sender's, unique in their system and not per Site, and a hook
-- that is not Site-scoped has no Site to record anyway.
CREATE TABLE IF NOT EXISTS phis.addon_hook_deliveries (
  addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE,
  delivery_id VARCHAR(255) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT addon_hook_deliveries_pkey PRIMARY KEY (addon_id, delivery_id),
  CONSTRAINT addon_hook_deliveries_delivery_id_check CHECK (delivery_id <> '')
);

-- What `phis maintain` prunes by. The table grows by one row per delivery and is worth nothing after
-- the sender has stopped retrying.
CREATE INDEX IF NOT EXISTS addon_hook_deliveries_received_at_idx
  ON phis.addon_hook_deliveries (received_at);

-- What Core owes an Add-on, written in the transaction that caused it.
--
-- Telling an integration in the request that produced the change would tie a person's reply to a third
-- party's availability, and a delivery attempted before the commit would announce something that may
-- still roll back. The row is written with the change and dispatched after it; what fails waits for the
-- next `phis addon job run`, which is the same reasoning that keeps Core without a scheduler.
--
-- `thread_id` is not payload. It is what bounds the delivery: a row exists only for an Add-on holding a
-- synced link to that thread, so the outbox cannot become a Site-wide feed of every conversation
-- arriving by push instead of by pull.
CREATE TABLE IF NOT EXISTS phis.addon_event_outbox (
  id BIGSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  addon_id VARCHAR(255) NOT NULL REFERENCES phis.server_addons(addon_id) ON DELETE CASCADE,
  event VARCHAR(120) NOT NULL,
  thread_id INT NOT NULL REFERENCES phis.threads(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts SMALLINT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ NULL,
  CONSTRAINT addon_event_outbox_event_check CHECK (event <> '')
);

-- The dispatcher's read: what is still owed, oldest first, for one Add-on on one Site. Ordering by the
-- key rather than by `created_at` is deliberate -- two events in the same transaction share a timestamp,
-- and an integration replaying them out of order would apply the older state last.
CREATE INDEX IF NOT EXISTS addon_event_outbox_pending_idx
  ON phis.addon_event_outbox (addon_id, site_id, id)
  WHERE delivered_at IS NULL;

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

/*
 * Every message Core owes a person, written down before anything is sent.
 *
 * Sending inside the request that decided to send is what this replaces. That works for one confirmation
 * and for nothing else: a refused SMTP target is a message lost without a trace while the person was
 * told it was on its way, five hundred recipients in one publish request is a timeout, and the process
 * is shared by every Site on the instance. The row is the record, the request that wrote it tries once
 * itself, and `phis maintain` picks up whatever that attempt did not finish -- the same division
 * `addon_event_outbox` already makes, for the same reason.
 *
 * There is one path and not two. A transactional message goes through here exactly as a circular does,
 * which is what finally gives a password reset the retry it never had.
 *
 * The recipient is an id wherever one exists, and the address is resolved when the row is drained: a
 * person who corrected theirs in between is written to correctly, and a membership that is gone is not
 * written to at all. `recipient_address` is for the messages that precede an account -- an unconfirmed
 * registration has no membership to point at -- and those carry `locale` with them for the same reason,
 * because there is no profile yet to ask.
 *
 * `dedupe_key` is what lets a run be repeated. A circular enumerates its recipients and stops; started
 * again, the keys it would write are already here and the insert is refused one row at a time, rather
 * than by a count somebody has to keep.
 */
CREATE TABLE IF NOT EXISTS phis.notification_outbox (
  id BIGSERIAL PRIMARY KEY,
  site_id SMALLINT NOT NULL REFERENCES phis.sites(id) ON DELETE CASCADE,
  -- Who declared the occasion, and therefore whose words render it: `@phis/server/core` or an Add-on id,
  -- the convention `server_capabilities.provider_id` already uses.
  provider_id VARCHAR(255) NOT NULL DEFAULT '@phis/server/core',
  occasion VARCHAR(120) NOT NULL,
  -- Bit 0: sent rather than asked for, so consent decided it and the footer owes an unsubscribe link.
  -- A flag rather than a boolean column, because the next distinction of this kind has the same shape.
  flags SMALLINT NOT NULL DEFAULT 0,
  recipient_user_id INT NULL,
  recipient_address VARCHAR(320) NULL,
  -- Only where there is no membership; otherwise the profile answers and this would be a second truth.
  locale VARCHAR(35) NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key VARCHAR(200) NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ NULL,
  -- What the transport called it, so a complaint about one mail can be traced back to this row.
  message_id VARCHAR(255) NULL,
  CONSTRAINT notification_outbox_occasion_check CHECK (occasion <> ''),
  -- Exactly one recipient form. Both at once would let the resolved address disagree with the stored one.
  CONSTRAINT notification_outbox_recipient_check CHECK (
    (recipient_user_id IS NOT NULL AND recipient_address IS NULL)
    OR (recipient_user_id IS NULL AND recipient_address IS NOT NULL)
  ),
  CONSTRAINT notification_outbox_locale_check CHECK (recipient_user_id IS NULL OR locale IS NULL),
  CONSTRAINT notification_outbox_membership_fk
    FOREIGN KEY (recipient_user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE
);

-- The drain's read: what is still owed on one Site, due first, and oldest first among equally due rows.
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON phis.notification_outbox (site_id, next_attempt_at, id)
  WHERE sent_at IS NULL;

-- What makes a repeated run write nothing the first one already wrote.
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_dedupe_idx
  ON phis.notification_outbox (site_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

/*
 * The public half of every unsubscribe link, one row per membership.
 *
 * The link has to keep working for as long as the mail carrying it exists -- it sits in somebody's
 * archive, and a dead link there is a dead link against an obligation (Art. 21 GDPR, § 7 UWG). That rules
 * out the shape the other tokens in this schema have: a stored hash cannot be read back, so a durable
 * link could never be rendered a second time. Instead the link carries a signature over the recipient and
 * this salt, and the key that signs it is installation-wide and stays out of the database
 * (`notifications.linkSecret`).
 *
 * Nothing secret is therefore here. The salt alone proves nothing, and one row per membership rather than
 * one per message is the difference between a table that grows with the audience and one that grows with
 * every send. Rotating one person's links replaces their salt; rotating everybody's rotates the key, and
 * invalidates every link still sitting in a mailbox.
 *
 * Acting on such a link clears the newsletter flag and does nothing else -- no session, no other Site, no
 * profile -- which is what makes a link that never expires the safe answer rather than the lazy one.
 */
CREATE TABLE IF NOT EXISTS phis.notification_link_salts (
  user_id INT NOT NULL,
  site_id SMALLINT NOT NULL,
  link_salt CHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  CONSTRAINT notification_link_salts_pkey PRIMARY KEY (user_id, site_id),
  CONSTRAINT notification_link_salts_membership_fk
    FOREIGN KEY (user_id, site_id)
    REFERENCES phis.user_site_memberships (user_id, site_id)
    ON DELETE CASCADE
);
