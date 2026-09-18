import type { Pool, PoolClient } from "pg";

import { getPool } from "@/lib/db";

/**
 * Integration fixtures for the tests that only PostgreSQL can decide -- referential actions, row
 * locking, and transactional rollback. They run against the development database rather than a
 * database of their own, because a second schema is one more thing that drifts.
 *
 * Two rules keep that safe. The harness never creates, drops, or migrates the schema: it verifies what
 * it needs and refuses to run otherwise, so `001_create_phis.pgsql` stays an operator action. And every
 * fixture hangs off one Site whose key carries the `pgtest-` prefix, so the blast radius is one row and
 * its cascade.
 */
export const PHI_TEST_SITE_KEY_PREFIX = "pgtest-";

const REQUIRED_TABLES = [
  "sites",
  "site_page_scopes",
  "site_read_marker",
  "site_cms_references",
  "media_assets",
  "media_spaces",
  "media_storage_profiles",
  "media_discarded_objects",
] as const;

/** Referential actions these tests assert on. Named so a drifted database says which one is missing. */
const REQUIRED_CONSTRAINTS = [
  ["site_cms_references", "site_cms_references_target_page_scope_id_fkey"],
  ["site_cms_references", "site_cms_references_target_asset_id_fkey"],
  ["site_page_scopes", "site_page_scopes_identity_check"],
  ["media_assets", "media_assets_storage_profile_site_fk"],
  ["image_asset_variants", "image_asset_variants_storage_profile_id_fkey"],
] as const;

let verified = false;

function readEnabled() {
  return process.env.PHIS_PG_TEST === "1";
}

export async function requirePhiTestDatabase(): Promise<Pool> {
  if (!readEnabled()) {
    throw new Error(
      "Refusing to touch a database: set PHIS_PG_TEST=1 (npm run test:pg) to run the integration tests.",
    );
  }
  const pool = getPool();
  if (verified) {
    return pool;
  }

  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'phis'`,
  );
  const present = new Set(tables.map((row) => row.table_name));
  const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
  if (missingTables.length > 0) {
    throw new Error(
      `The phis schema is missing ${missingTables.join(", ")}. Load scripts/sql/001_create_phis.pgsql ` +
      "into the development database yourself -- the harness never creates or migrates a schema.",
    );
  }

  const { rows: constraints } = await pool.query<{ table_name: string; conname: string }>(
    `SELECT t.relname AS table_name, c.conname
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'phis'`,
  );
  const constraintKeys = new Set(constraints.map((row) => `${row.table_name}.${row.conname}`));
  const missingConstraints = REQUIRED_CONSTRAINTS
    .map(([table, name]) => `${table}.${name}`)
    .filter((key) => !constraintKeys.has(key));
  if (missingConstraints.length > 0) {
    throw new Error(
      `The phis schema is behind scripts/sql/001_create_phis.pgsql: ${missingConstraints.join(", ")} ` +
      "is missing. Bring the development database up to date yourself.",
    );
  }

  verified = true;
  return pool;
}

export type PhiTestSite = {
  id: number;
  key: string;
  storageProfileId: number;
  siteSpaceId: number;
};

let sequence = 0;

/**
 * One Site plus the Storage Profile and Site Space every Media fixture needs. Created with real
 * commits, because the transaction behavior under test is the point: wrapping the suite in one
 * rolled-back transaction would make the code's own COMMIT settle the wrapper instead.
 */
export async function createPhiTestSite(label: string): Promise<PhiTestSite> {
  const pool = await requirePhiTestDatabase();
  sequence += 1;
  const key = `${PHI_TEST_SITE_KEY_PREFIX}${label}-${process.pid}-${sequence}`;

  const { rows: siteRows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.sites (
       key, name, hostname, public_base_url, mail_from, mail_from_name,
       support_email, contact_recipient, form_guard_secret
     ) VALUES ($1, $1, $2, $3, $4, $1, $4, $4, repeat('0', 64))
     RETURNING id`,
    [key, `${key}.invalid`, `https://${key}.invalid`, `${key}@example.invalid`],
  );
  const id = siteRows[0]!.id;

  const { rows: profileRows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id)
     VALUES ($1, 'pgtest-local', '@phis/server/storage-local')
     RETURNING id`,
    [id],
  );
  const storageProfileId = profileRows[0]!.id;

  const { rows: spaceRows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.media_spaces (site_id, kind, default_storage_profile_id)
     VALUES ($1, 1, $2)
     RETURNING id`,
    [id, storageProfileId],
  );

  return { id, key, storageProfileId, siteSpaceId: spaceRows[0]!.id };
}

export async function createPhiTestPageScope(
  site: PhiTestSite,
  path: string,
  areaMask = 1,
): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.site_page_scopes (site_id, area_id, path) VALUES ($1, $2, $3) RETURNING id`,
    [site.id, areaMask, path],
  );
  return rows[0]!.id;
}

/** The Site's own Theme Scope. Site wide by construction: one per Site, keyed without an Area. */
export async function createPhiTestThemeScope(site: PhiTestSite, key = "pgtest"): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.site_theme_scopes (site_id, key) VALUES ($1, $2) RETURNING id`,
    [site.id, key],
  );
  return rows[0]!.id;
}

export async function createPhiTestAsset(site: PhiTestSite, storageKey: string): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.media_assets (
       site_id, space_id, storage_profile_id, storage_key, original_name, content_type
     ) VALUES ($1, $2, $3, $4, $5, 'image/png')
     RETURNING id`,
    [site.id, site.siteSpaceId, site.storageProfileId, storageKey, `${storageKey}.png`],
  );
  return rows[0]!.id;
}

export async function createPhiTestPageReference(
  site: PhiTestSite,
  sourceScopeId: number,
  targetPageScopeId: number,
  areaMask = 1,
): Promise<void> {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_cms_references (
       site_id, source_kind, source_scope_id, source_location,
       target_kind, target_area_id, target_page_scope_id
     ) VALUES ($1, 1, $2, 'pgtest', 1, $3, $4)`,
    [site.id, sourceScopeId, areaMask, targetPageScopeId],
  );
}

export async function createPhiTestAssetReference(
  site: PhiTestSite,
  sourceScopeId: number,
  targetAssetId: number,
  /** The source this reference sits in; the Theme is `5` and is Site wide, so it carries no Area. */
  sourceKind = 1,
): Promise<void> {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_cms_references (
       site_id, source_kind, source_scope_id, source_location, target_kind, target_asset_id
     ) VALUES ($1, $4, $2, 'pgtest', 3, $3)`,
    [site.id, sourceScopeId, targetAssetId, sourceKind],
  );
}

/**
 * Removes every `pgtest-` Site, then every `pgtest-` user account.
 *
 * The Site delete relies on the cascade graph being closed, which `sites-cascade.pg.test.ts` pins --
 * if that test fails, this stops cleaning up and says so loudly. User accounts need the second pass
 * because they are global rather than Site-scoped, which is why the fixture gives every test user a
 * recognizable primary email instead of tracking ids in memory: a crashed run is still cleaned up by
 * the next one.
 */
export async function dropPhiTestSites(): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rowCount } = await pool.query(
    `DELETE FROM phis.sites WHERE key LIKE $1`,
    [`${PHI_TEST_SITE_KEY_PREFIX}%`],
  );
  await pool.query(
    `DELETE FROM phis.user_accounts a
     WHERE EXISTS (
       SELECT 1 FROM phis.user_emails e WHERE e.user_id = a.id AND e.email_normalized LIKE $1
     )`,
    [`${PHI_TEST_SITE_KEY_PREFIX}%`],
  );
  return rowCount ?? 0;
}

/** A user account with a Site membership, which a User Space and every upload session require. */
export async function createPhiTestUser(site: PhiTestSite): Promise<number> {
  const pool = await requirePhiTestDatabase();
  sequence += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.user_accounts DEFAULT VALUES RETURNING id`,
  );
  const userId = rows[0]!.id;
  await pool.query(
    `INSERT INTO phis.user_emails (user_id, email_normalized, verified_at, flags, source)
     VALUES ($1, $2, NOW(), 1, 1)`,
    [userId, `${PHI_TEST_SITE_KEY_PREFIX}${process.pid}-${sequence}@example.invalid`],
  );
  await pool.query(
    `INSERT INTO phis.user_site_memberships (user_id, site_id) VALUES ($1, $2)`,
    [userId, site.id],
  );
  return userId;
}

/** Core-provided so the claim projection, which filters on provider availability, actually sees it. */
export async function createPhiTestGroup(site: PhiTestSite, key: string): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.site_groups (site_id, provider_id, key, name)
     VALUES ($1, '@phis/server/core', $2, $2)
     RETURNING id`,
    [site.id, key],
  );
  return rows[0]!.id;
}

export async function addPhiTestGroupMember(input: {
  site: PhiTestSite;
  groupId: number;
  userId: number;
  membershipFlags?: number;
  validUntilSeconds?: number | null;
}): Promise<void> {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_group_members (
       group_id, user_id, site_id, source_provider_id, source_binding_or_assertion_key,
       membership_flags, valid_until
     ) VALUES ($1, $2, $3, '@phis/server/core', 'pgtest', $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + make_interval(secs => $5::int) END)`,
    [input.groupId, input.userId, input.site.id, input.membershipFlags ?? 1, input.validUntilSeconds ?? null],
  );
}

/**
 * A Space with delegated capacity. `quotaBytes` writes the Space-level override; leave it undefined to
 * exercise inheritance from `site_media_config`.
 *
 * Each call mints its own group or user, because a Space is unique per owner: reusing one owner would
 * make the second Space in a suite collide rather than test anything.
 */
export async function createPhiTestGroupSpace(
  site: PhiTestSite,
  quotaBytes?: number | null,
): Promise<number> {
  sequence += 1;
  const groupId = await createPhiTestGroup(site, `pgtest-space-${process.pid}-${sequence}`);
  return insertPhiTestSpace(site, 3, null, groupId, quotaBytes ?? null);
}

/** A Space for a group that already exists, so a membership can be granted in it. */
export async function createPhiTestSpaceForGroup(
  site: PhiTestSite,
  groupId: number,
  quotaBytes?: number | null,
): Promise<number> {
  return insertPhiTestSpace(site, 3, null, groupId, quotaBytes ?? null);
}

export async function createPhiTestUserSpace(
  site: PhiTestSite,
  quotaBytes?: number | null,
): Promise<number> {
  const userId = await createPhiTestUser(site);
  return insertPhiTestSpace(site, 2, userId, null, quotaBytes ?? null);
}

async function insertPhiTestSpace(
  site: PhiTestSite,
  kind: 2 | 3,
  userId: number | null,
  groupId: number | null,
  quotaBytes: number | null,
): Promise<number> {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.media_spaces (site_id, kind, user_id, group_id, default_storage_profile_id, quota_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [site.id, kind, userId, groupId, site.storageProfileId, quotaBytes],
  );
  return rows[0]!.id;
}

export async function setPhiTestMediaConfig(
  site: PhiTestSite,
  input: {
    defaultUserQuotaBytes?: number | null;
    defaultGroupQuotaBytes?: number | null;
    maxObjectBytes?: number;
    /* Derived from the Modules in production; written directly here so a fixture need not publish. */
    userSpaceContentKinds?: readonly string[];
    groupSpaceContentKinds?: readonly string[];
  },
): Promise<void> {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.site_media_config (
       site_id, default_user_quota_bytes, default_group_quota_bytes, max_object_bytes,
       user_space_content_kinds, group_space_content_kinds
     ) VALUES ($1, $2, $3, COALESCE($4, 134217728),
       COALESCE($5::varchar(32)[], ARRAY[]::varchar(32)[]),
       COALESCE($6::varchar(32)[], ARRAY[]::varchar(32)[]))
     ON CONFLICT (site_id) DO UPDATE
     SET default_user_quota_bytes = EXCLUDED.default_user_quota_bytes,
         default_group_quota_bytes = EXCLUDED.default_group_quota_bytes,
         max_object_bytes = EXCLUDED.max_object_bytes,
         user_space_content_kinds = EXCLUDED.user_space_content_kinds,
         group_space_content_kinds = EXCLUDED.group_space_content_kinds`,
    [
      site.id,
      input.defaultUserQuotaBytes ?? null,
      input.defaultGroupQuotaBytes ?? null,
      input.maxObjectBytes ?? null,
      input.userSpaceContentKinds ? [...input.userSpaceContentKinds] : null,
      input.groupSpaceContentKinds ? [...input.groupSpaceContentKinds] : null,
    ],
  );
}

/**
 * An upload session holding a reservation. `expiresInSeconds` may be negative to stage a session the
 * maintenance path is meant to collect.
 */
export async function createPhiTestUploadSession(input: {
  site: PhiTestSite;
  spaceId: number;
  actorUserId: number;
  sizeBytes: number;
  expiresInSeconds: number;
}): Promise<string> {
  const pool = await requirePhiTestDatabase();
  sequence += 1;
  const token = `${PHI_TEST_SITE_KEY_PREFIX}token-${process.pid}-${sequence}`;
  await pool.query(
    `INSERT INTO phis.media_upload_sessions (
       token, site_id, actor_user_id, space_id, storage_profile_id, status,
       filename, content_type, size_bytes, kind, staging_storage_key, expires_at
     ) VALUES ($1, $2, $3, $4, $5, 1, 'pgtest.png', 'image/png', $6, 'image', $7,
               NOW() + make_interval(secs => $8))`,
    [
      token, input.site.id, input.actorUserId, input.spaceId, input.site.storageProfileId,
      input.sizeBytes, `pgtest/staging/${token}`, input.expiresInSeconds,
    ],
  );
  return token;
}

export async function readPhiTestSpaceBytes(spaceId: number) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ used_bytes: string; reserved_bytes: string }>(
    `SELECT used_bytes, reserved_bytes FROM phis.media_spaces WHERE id = $1`,
    [spaceId],
  );
  const row = rows[0];
  return row ? { used: Number(row.used_bytes), reserved: Number(row.reserved_bytes) } : null;
}

/** Runs `body` on its own client so a test can hold a lock while another connection contends for it. */
export async function withPhiTestClient<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await requirePhiTestDatabase();
  const client = await pool.connect();
  try {
    return await body(client);
  } finally {
    client.release();
  }
}

export async function closePhiTestPool(): Promise<void> {
  await getPool().end();
}

/**
 * Puts one Add-on's activation row in place for a Site.
 *
 * Settings live on that row, so a test that configures an Add-on needs it to exist -- exactly as an
 * operator does, which is why the CLI refuses to configure an Add-on that was never enabled here.
 */
export async function activatePhiTestAddonForSite(
  site: PhiTestSite,
  addonId: string,
): Promise<void> {
  const pool = await requirePhiTestDatabase();
  await pool.query(
    `INSERT INTO phis.server_addons (
       addon_id, package_name, package_version, server_abi, manifest_digest,
       migration_version, release_build_id, flags
     ) VALUES ($1, $2, '0.0.0', '^1', 'pgtest', 0, 'pgtest', 0)
     ON CONFLICT (addon_id) DO NOTHING`,
    [addonId, addonId],
  );
  await pool.query(
    `INSERT INTO phis.site_server_addons (site_id, addon_id)
     VALUES ($1, $2)
     ON CONFLICT (site_id, addon_id) DO NOTHING`,
    [site.id, addonId],
  );
}
