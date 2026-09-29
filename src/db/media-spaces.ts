import "server-only";

import type { PoolClient } from "pg";

import { getPhisConfigSync } from "@/lib/config";
import { PhiSiteMediaFlags, resolvePhiMediaKindFromContentType } from "@/lib/constants/media";
import { PhiGroupMembershipFlags } from "@/lib/constants/site-groups";
import { getSiteGroupById, readEffectiveGroupMembershipFlags } from "@/db/site-groups";
import type { RequestedMediaSpace } from "@/lib/guards/site-media-api";
import { getPool, withTransaction } from "@/lib/db";
import type { PhisMediaStorageProbe } from "@phis/contracts/addon";
import {
  PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID,
  type PhisMediaStorageProviderId,
} from "@/lib/media-storage";

type MediaSpaceDbQueryable = Pick<PoolClient, "query">;

/**
 * Who a Space belongs to.
 *
 * `Addon` is the fourth and is not browsable: an Add-on's release artifacts have no business sitting
 * between somebody's photographs. It exists so that the Space's quota **is** the Add-on's quota --
 * one account over one set of bytes, rather than two that drift apart.
 */
/**
 * How this server stores the kind of a Space.
 *
 * The numbers are the stored contract and never change. They are deliberately not in
 * `@phis/contracts`: a Site never sees them, it is handed the wire name instead.
 */
export const PhisMediaSpaceKind = { Site: 1, User: 2, Group: 3, Addon: 4 } as const;

export type PhisMediaSpaceKindValue = (typeof PhisMediaSpaceKind)[keyof typeof PhisMediaSpaceKind];

const MEDIA_SPACE_KIND_VALUES = new Set<number>(Object.values(PhisMediaSpaceKind));
// Both numbers reach the site UI in an Asset payload, so they are the contract's and not this file's.
export { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@phis/contracts/media";

export type MediaStorageProfileRecord = {
  id: number;
  siteId: number;
  key: string;
  providerId: PhisMediaStorageProviderId;
  config: Record<string, unknown>;
  secretReference: string | null;
  flags: number;
};

export type MediaSpaceRecord = {
  id: number;
  siteId: number;
  kind: PhisMediaSpaceKindValue;
  userId: number | null;
  groupId: number | null;
  defaultStorageProfileId: number;
  quotaBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
  flags: number;
};

function asNumber(value: number | string | null) {
  return value == null ? null : typeof value === "number" ? value : Number.parseInt(value, 10);
}

function mapProfile(row: {
  id: number; site_id: number; key: string; provider_id: string; config: Record<string, unknown>;
  secret_reference: string | null; flags: number;
}): MediaStorageProfileRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    providerId: row.provider_id as PhisMediaStorageProviderId,
    config: row.config ?? {},
    secretReference: row.secret_reference,
    flags: row.flags,
  };
}

type SpaceRow = {
  id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
  default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
  reserved_bytes: number | string; flags: number;
};

/**
 * A stored kind this release does not know is a data fault, not a Space to guess at.
 *
 * Quota ceiling, delivery policy and the wire name all branch on it, and the previous reader mapped an
 * unknown value to "site" -- which is how an Add-on Space reached the administration surface calling
 * itself a Site Space. There is no CHECK constraint behind the column, so this is where it is caught.
 */
function requireSpaceKind(value: number): PhisMediaSpaceKindValue {
  if (!MEDIA_SPACE_KIND_VALUES.has(value)) {
    throw new Error(`Unknown media space kind: ${value}`);
  }
  return value as PhisMediaSpaceKindValue;
}

function mapSpace(row: SpaceRow): MediaSpaceRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    kind: requireSpaceKind(row.kind),
    userId: row.user_id,
    groupId: row.group_id,
    defaultStorageProfileId: row.default_storage_profile_id,
    quotaBytes: asNumber(row.quota_bytes),
    usedBytes: asNumber(row.used_bytes) ?? 0,
    reservedBytes: asNumber(row.reserved_bytes) ?? 0,
    flags: row.flags,
  };
}

/**
 * Materializes the Local Storage Profile and seeds its provider configuration once.
 *
 * A Provider's configuration belongs to its Profile, not to a global switch. The operator's
 * installation values seed the row the first time it is created, and an existing row whose config is
 * still empty is backfilled once so an installation that predates this keeps resolving the same
 * directory. Afterwards the row is authoritative and configuration is never consulted again.
 */
async function ensureLocalStorageProfileWithDb(db: MediaSpaceDbQueryable, siteId: number) {
  const media = getPhisConfigSync().media ?? {};
  const seed: Record<string, unknown> = {};
  if (media.storageKeyPrefix?.trim()) seed.storageKeyPrefix = media.storageKeyPrefix.trim();
  if (media.local?.rootDir?.trim()) seed.rootDir = media.local.rootDir.trim();

  const { rows } = await db.query<{
    id: number; site_id: number; key: string; provider_id: string; config: Record<string, unknown>;
    secret_reference: string | null; flags: number;
  }>(
    `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, config)
     VALUES ($1, 'local', $2, $3::jsonb)
     ON CONFLICT (site_id, key) DO UPDATE
       SET config = CASE
             WHEN phis.media_storage_profiles.config = '{}'::jsonb THEN EXCLUDED.config
             ELSE phis.media_storage_profiles.config
           END,
           updated_at = NOW()
     RETURNING id, site_id, key, provider_id, config, secret_reference, flags`,
    [siteId, PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID, JSON.stringify(seed)],
  );
  return mapProfile(rows[0]!);
}

/**
 * Reserved bytes as a reader must understand them.
 *
 * `media_spaces.reserved_bytes` is a counter, and an upload session that expired without anyone
 * touching it again leaves its share standing in that counter until the next reservation against the
 * same Space releases it. A read therefore discounts what is already dead instead of repairing it --
 * the maintenance contract in `AGENTS.md` gives the repair to the writer and the truth to the reader,
 * over the same predicate, so what is reported free is what the next request will actually grant.
 */
function liveReservedBytes(alias: string) {
  const space = alias ? `${alias}.` : "";
  return `GREATEST(0, ${space}reserved_bytes - COALESCE((
              SELECT SUM(u.size_bytes)
              FROM phis.media_upload_sessions u
              WHERE u.space_id = ${space}id AND u.expires_at < NOW()
            ), 0))`;
}

export async function ensureSiteMediaSpace(siteId: number) {
  // Fast path: the Site Space and its profile exist after the very first request, so the ordinary
  // read must not pay an upsert. The write path below only runs on a miss or while the profile's
  // config is still unseeded.
  const existing = await getPool().query<{
    space_id: number; space_site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; space_flags: number;
    profile_id: number; profile_site_id: number; key: string; provider_id: string;
    config: Record<string, unknown>; secret_reference: string | null; profile_flags: number;
  }>(
    `SELECT s.id AS space_id, s.site_id AS space_site_id, s.kind, s.user_id, s.group_id,
            s.default_storage_profile_id, s.quota_bytes, s.used_bytes,
            ${liveReservedBytes("s")} AS reserved_bytes,
            s.flags AS space_flags,
            p.id AS profile_id, p.site_id AS profile_site_id, p.key, p.provider_id,
            p.config, p.secret_reference, p.flags AS profile_flags
     FROM phis.media_spaces s
     JOIN phis.media_storage_profiles p ON p.id = s.default_storage_profile_id AND p.site_id = s.site_id
     WHERE s.site_id = $1 AND s.kind = $2`,
    [siteId, PhisMediaSpaceKind.Site],
  );
  const hit = existing.rows[0];
  if (hit && hit.config && Object.keys(hit.config).length > 0) {
    return {
      space: mapSpace({
        id: hit.space_id, site_id: hit.space_site_id, kind: hit.kind, user_id: hit.user_id,
        group_id: hit.group_id, default_storage_profile_id: hit.default_storage_profile_id,
        quota_bytes: hit.quota_bytes, used_bytes: hit.used_bytes, reserved_bytes: hit.reserved_bytes,
        flags: hit.space_flags,
      }),
      profile: mapProfile({
        id: hit.profile_id, site_id: hit.profile_site_id, key: hit.key, provider_id: hit.provider_id,
        config: hit.config, secret_reference: hit.secret_reference, flags: hit.profile_flags,
      }),
    };
  }

  return withTransaction(async (client) => {
    const profile = await ensureLocalStorageProfileWithDb(client, siteId);
    const { rows } = await client.query<{
      id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
      default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
      reserved_bytes: number | string; flags: number;
    }>(
      `INSERT INTO phis.media_spaces (site_id, kind, default_storage_profile_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (site_id) WHERE kind = 1
       DO UPDATE SET updated_at = NOW()
       RETURNING id, site_id, kind, user_id, group_id, default_storage_profile_id,
                 quota_bytes, used_bytes, reserved_bytes, flags`,
      [siteId, PhisMediaSpaceKind.Site, profile.id],
    );
    return { space: mapSpace(rows[0]!), profile };
  });
}

/**
 * The Space one Add-on's files live in on one Site, made on first use.
 *
 * Made rather than required, for the reason the Site Space is: the first upload should not fail because
 * nobody ran a command. The Storage Profile is the Site's own default, so an operator who moved a Site
 * to S3 moved its Add-ons with it and did not have to be asked twice.
 *
 * It is not browsable. What a person uploads, browses and references belongs in a Media Space with its
 * folders and delivery policies; this holds what a package keeps -- a release artifact, a generated
 * preview -- and shows up in neither listing.
 */
export async function ensureAddonMediaSpace(siteId: number, addonId: string) {
  const existing = await getPool().query<SpaceRow>(
    `SELECT s.id, s.site_id, s.kind, s.user_id, s.group_id, s.default_storage_profile_id,
            s.quota_bytes, s.used_bytes, ${liveReservedBytes("s")} AS reserved_bytes, s.flags
       FROM phis.media_spaces s
      WHERE s.site_id = $1 AND s.kind = $2 AND s.addon_id = $3`,
    [siteId, PhisMediaSpaceKind.Addon, addonId],
  );
  if (existing.rows[0]) {
    return mapSpace(existing.rows[0]);
  }

  // The Site Space is ensured first because it is what creates the Site's default Storage Profile.
  const { profile } = await ensureSiteMediaSpace(siteId);
  const { rows } = await getPool().query<SpaceRow>(
    `INSERT INTO phis.media_spaces (site_id, kind, addon_id, default_storage_profile_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, addon_id) WHERE kind = 4
     DO UPDATE SET updated_at = NOW()
     RETURNING id, site_id, kind, user_id, group_id, default_storage_profile_id,
               quota_bytes, used_bytes, reserved_bytes, flags`,
    [siteId, PhisMediaSpaceKind.Addon, addonId, profile.id],
  );
  return mapSpace(rows[0]!);
}

/**
 * Every Add-on Space on a Site, with the Add-on each one belongs to.
 *
 * These Spaces are not browsable and have no owner who could administer them, so nothing else surfaces
 * them: an administrator asked to size one would have no way to learn it exists or which Add-on it is.
 * Reported rather than made browsable, because what is in them is the Add-on's business and what they
 * cost is the Site's.
 */
export async function listAddonMediaSpaces(siteId: number) {
  const { rows } = await getPool().query<SpaceRow & { addon_id: string }>(
    `SELECT s.id, s.site_id, s.kind, s.user_id, s.group_id, s.default_storage_profile_id,
            s.quota_bytes, s.used_bytes, ${liveReservedBytes("s")} AS reserved_bytes, s.flags,
            s.addon_id
       FROM phis.media_spaces s
      WHERE s.site_id = $1 AND s.kind = $2
      ORDER BY s.addon_id`,
    [siteId, PhisMediaSpaceKind.Addon],
  );
  return rows.map((row) => ({ addonId: row.addon_id, space: mapSpace(row) }));
}

/**
 * What was recorded about this endpoint, and whether anything was.
 *
 * The two are separate answers. A Profile that answered "no" and a Profile nobody ever asked both read
 * as no capability, and only one of them is worth asking again -- which is what `probedAt` is for.
 */
export async function readMediaStorageProfileProbe(siteId: number, profileId: number) {
  const { rows } = await getPool().query<{
    probe: PhisMediaStorageProbe | null; probed_at: Date | null; checksum_algorithm: string | null;
  }>(
    `SELECT probe, probed_at, checksum_algorithm FROM phis.media_storage_profiles
      WHERE site_id = $1 AND id = $2`,
    [siteId, profileId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    probe: row.probe,
    probedAt: row.probed_at ? row.probed_at.toISOString() : null,
    checksumAlgorithm: row.checksum_algorithm,
  };
}

/**
 * Records what an endpoint was found to do, replacing whatever stood there.
 *
 * Always a replacement and never a merge: a probe describes one endpoint under one configuration, so
 * keeping any part of an older answer after the configuration moved would report a capability that was
 * measured somewhere else.
 */
export async function writeMediaStorageProfileProbe(
  siteId: number,
  profileId: number,
  probe: PhisMediaStorageProbe,
  checksumAlgorithm: string | null,
) {
  const result = await getPool().query(
    `UPDATE phis.media_storage_profiles
        SET probe = $3::jsonb, probed_at = NOW(), checksum_algorithm = $4, updated_at = NOW()
      WHERE site_id = $1 AND id = $2`,
    [siteId, profileId, JSON.stringify(probe), checksumAlgorithm],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getMediaStorageProfile(siteId: number, profileId: number) {
  const { rows } = await getPool().query<{
    id: number; site_id: number; key: string; provider_id: string; config: Record<string, unknown>;
    secret_reference: string | null; flags: number;
  }>(
    `SELECT id, site_id, key, provider_id, config, secret_reference, flags
     FROM phis.media_storage_profiles WHERE site_id = $1 AND id = $2`,
    [siteId, profileId],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function listAuthorizedMediaSpaces(input: {
  siteId: number;
  userId: number;
  includeSiteSpace: boolean;
}) {
  const { rows } = await getPool().query<{
    id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; flags: number;
  }>(
    `SELECT DISTINCT s.id, s.site_id, s.kind, s.user_id, s.group_id, s.default_storage_profile_id,
            s.quota_bytes, s.used_bytes, ${liveReservedBytes("s")} AS reserved_bytes, s.flags
     FROM phis.media_spaces s
     LEFT JOIN phis.site_groups g ON g.id = s.group_id AND g.site_id = s.site_id
     LEFT JOIN phis.site_group_members gm
       ON s.kind = 3 AND gm.group_id = s.group_id AND gm.site_id = s.site_id AND gm.user_id = $2
       AND (gm.valid_until IS NULL OR gm.valid_until > NOW())
       -- A retired group disappears from Space selection. The Space itself is not retired with it: it
       -- stays where it is and comes back when the group does.
       AND g.retired_at IS NULL
     WHERE s.site_id = $1 AND (
       ($3 AND s.kind = 1) OR (s.kind = 2 AND s.user_id = $2) OR (s.kind = 3 AND gm.user_id IS NOT NULL)
     ) ORDER BY s.kind, s.id`,
    [input.siteId, input.userId, input.includeSiteSpace],
  );
  return rows.map(mapSpace);
}

export async function getMediaSpaceById(siteId: number, spaceId: number) {
  const { rows } = await getPool().query<{
    id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; flags: number;
  }>(
    `SELECT id, site_id, kind, user_id, group_id, default_storage_profile_id,
            quota_bytes, used_bytes, ${liveReservedBytes("")} AS reserved_bytes, flags
     FROM phis.media_spaces WHERE site_id = $1 AND id = $2`,
    [siteId, spaceId],
  );
  return rows[0] ? mapSpace(rows[0]) : null;
}

export async function isEffectiveMediaGroupMember(siteId: number, groupId: number, userId: number) {
  const { rows } = await getPool().query<{ member: boolean }>(
    `SELECT TRUE AS member FROM phis.site_group_members m
     JOIN phis.site_groups g ON g.id = m.group_id AND g.site_id = m.site_id
     WHERE m.site_id = $1 AND m.group_id = $2 AND m.user_id = $3 AND g.retired_at IS NULL
       AND (m.valid_until IS NULL OR m.valid_until > NOW()) LIMIT 1`,
    [siteId, groupId, userId],
  );
  return rows[0]?.member === true;
}

/**
 * Reserves capacity against the *effective* quota.
 *
 * The effective limit is resolved inside the statement rather than by the caller, so inheritance stays
 * live and the check stays atomic: a Space with a `NULL` override reads the current Site default for
 * its kind, an explicit `0` can never satisfy the comparison, and a resolved `NULL` means no limit.
 *
 * The comparison discounts dead reservations exactly as a reader does, so the capacity a Client was
 * shown is the capacity it gets. The counter itself is still raised by the raw amount: releasing those
 * bytes is the business of the statement that also removes their rows, and doing it here would free
 * them twice. An expired session cannot finalize, so nothing discounted here can ever be committed.
 */
export async function reserveMediaSpaceQuota(input: { spaceId: number; bytes: number }) {
  const { rows } = await getPool().query<{ id: number }>(
    `WITH effective AS (
       SELECT s.id,
              COALESCE(
                s.quota_bytes,
                CASE s.kind
                  WHEN ${PhisMediaSpaceKind.User} THEN c.default_user_quota_bytes
                  WHEN ${PhisMediaSpaceKind.Group} THEN c.default_group_quota_bytes
                  WHEN ${PhisMediaSpaceKind.Addon} THEN c.default_addon_quota_bytes
                END
              ) AS quota
       FROM phis.media_spaces s
       LEFT JOIN phis.site_media_config c ON c.site_id = s.site_id
       WHERE s.id = $1
     )
     UPDATE phis.media_spaces s
     SET reserved_bytes = s.reserved_bytes + $2, updated_at = NOW()
     FROM effective e
     WHERE s.id = e.id AND $2 > 0
       AND (e.quota IS NULL OR s.used_bytes + ${liveReservedBytes("s")} + $2 <= e.quota)
     RETURNING s.id`,
    [input.spaceId, input.bytes],
  );
  return Boolean(rows[0]);
}

/**
 * A reservation becoming usage, in the transaction that creates the row it paid for.
 *
 * The two counters move in one statement because they are one fact: the bytes stop being promised at
 * the moment they start being held. It takes the connection rather than the pool for the same reason --
 * the Asset row, the link and the finished upload session are written beside it, and a commit that
 * landed while any of those failed would leave a Space charged for a file nobody can reach.
 *
 * `false` means the reservation was not there to commit, which the caller has to treat as a refusal
 * rather than a retry: something else already released or committed it.
 */
export async function commitMediaSpaceReservationWithDb(
  db: MediaSpaceDbQueryable,
  input: { spaceId: number; bytes: number },
) {
  const { rows } = await db.query<{ id: number }>(
    `UPDATE phis.media_spaces
        SET reserved_bytes = GREATEST(0, reserved_bytes - $2),
            used_bytes = used_bytes + $2, updated_at = NOW()
      WHERE id = $1 RETURNING id`,
    [input.spaceId, input.bytes],
  );
  return Boolean(rows[0]);
}

export async function releaseMediaSpaceReservation(input: { spaceId: number; bytes: number }) {
  await getPool().query(
    `UPDATE phis.media_spaces SET reserved_bytes = GREATEST(0, reserved_bytes - $2), updated_at = NOW()
     WHERE id = $1`,
    [input.spaceId, input.bytes],
  );
}

export type SiteMediaConfigRecord = {
  siteId: number;
  flags: number;
  defaultUserQuotaBytes: number | null;
  defaultGroupQuotaBytes: number | null;
  /** The ceiling a Space-level override may not exceed; `null` is no ceiling. */
  maxUserQuotaBytes: number | null;
  maxGroupQuotaBytes: number | null;
  defaultAddonQuotaBytes: number | null;
  maxAddonQuotaBytes: number | null;
  maxObjectBytes: number;
  /**
   * What each delegated Space accepts, derived from the active Modules rather than administered.
   *
   * Empty means the Space accepts nothing, which is the safe reading of a Module that asked for a Space
   * without saying what for. The Site Space is absent on purpose: a role decides there, not a list.
   */
  userSpaceContentKinds: readonly string[];
  groupSpaceContentKinds: readonly string[];
};

function mapSiteMediaConfig(row: {
  site_id: number; flags: number; default_user_quota_bytes: number | string | null;
  default_group_quota_bytes: number | string | null; max_user_quota_bytes?: number | string | null;
  max_group_quota_bytes?: number | string | null; default_addon_quota_bytes?: number | string | null;
  max_addon_quota_bytes?: number | string | null; max_object_bytes: number | string;
  user_space_content_kinds?: readonly string[] | null;
  group_space_content_kinds?: readonly string[] | null;
}): SiteMediaConfigRecord {
  return {
    siteId: row.site_id,
    flags: row.flags,
    defaultUserQuotaBytes: asNumber(row.default_user_quota_bytes),
    defaultGroupQuotaBytes: asNumber(row.default_group_quota_bytes),
    maxUserQuotaBytes: asNumber(row.max_user_quota_bytes ?? null),
    maxGroupQuotaBytes: asNumber(row.max_group_quota_bytes ?? null),
    defaultAddonQuotaBytes: asNumber(row.default_addon_quota_bytes ?? null),
    maxAddonQuotaBytes: asNumber(row.max_addon_quota_bytes ?? null),
    maxObjectBytes: asNumber(row.max_object_bytes) ?? 0,
    userSpaceContentKinds: row.user_space_content_kinds ?? [],
    groupSpaceContentKinds: row.group_space_content_kinds ?? [],
  };
}

/**
 * The ceiling that applies to one Space kind. The Site Space has none: it is not delegated capacity.
 */
export function resolveMediaQuotaCeilingBytes(kind: number, config: SiteMediaConfigRecord) {
  if (kind === PhisMediaSpaceKind.User) return config.maxUserQuotaBytes;
  if (kind === PhisMediaSpaceKind.Group) return config.maxGroupQuotaBytes;
  if (kind === PhisMediaSpaceKind.Addon) return config.maxAddonQuotaBytes;
  return null;
}

const SITE_MEDIA_CONFIG_COLUMNS = `site_id, flags, default_user_quota_bytes, default_group_quota_bytes,
            max_user_quota_bytes, max_group_quota_bytes,
            default_addon_quota_bytes, max_addon_quota_bytes, max_object_bytes,
            user_space_content_kinds, group_space_content_kinds`;

type SiteMediaConfigRow = {
  site_id: number; flags: number; default_user_quota_bytes: number | string | null;
  default_group_quota_bytes: number | string | null; max_user_quota_bytes: number | string | null;
  max_group_quota_bytes: number | string | null; default_addon_quota_bytes: number | string | null;
  max_addon_quota_bytes: number | string | null; max_object_bytes: number | string;
  user_space_content_kinds: string[] | null;
  group_space_content_kinds: string[] | null;
};

function selectSiteMediaConfigWithDb(db: MediaSpaceDbQueryable, siteId: number) {
  return db.query<SiteMediaConfigRow>(
    `SELECT ${SITE_MEDIA_CONFIG_COLUMNS} FROM phis.site_media_config WHERE site_id = $1`,
    [siteId],
  );
}

/**
 * Seeds the row from the versioned installation defaults, once.
 *
 * Availability is deliberately absent: it is derived from what the Site's Modules declare, so the row
 * starts with no Space kind available and the first Area publish materializes the truth.
 */
function insertSiteMediaConfigWithDb(db: MediaSpaceDbQueryable, siteId: number) {
  const defaults = getPhisConfigSync().media?.defaults ?? {};
  return db.query(
    `INSERT INTO phis.site_media_config (site_id, flags, default_user_quota_bytes, default_group_quota_bytes)
     VALUES ($1, 0, $2, $3)
     ON CONFLICT (site_id) DO NOTHING`,
    [siteId, defaults.userQuotaBytes ?? null, defaults.groupQuotaBytes ?? null],
  );
}

/**
 * Materializes the Site's Media configuration row from the versioned installation defaults.
 *
 * The JSON layer is read exactly once, here. Afterwards the row is authoritative and no request-time
 * fallback to configuration exists, so raising an installation default never widens an existing Site.
 */
export async function ensureSiteMediaConfig(siteId: number): Promise<SiteMediaConfigRecord> {
  // Fast path: after the one-time materialization every request is a plain read.
  const existing = await selectSiteMediaConfigWithDb(getPool(), siteId);
  if (existing.rows[0]) return mapSiteMediaConfig(existing.rows[0]);

  await insertSiteMediaConfigWithDb(getPool(), siteId);
  const materialized = await selectSiteMediaConfigWithDb(getPool(), siteId);
  return mapSiteMediaConfig(materialized.rows[0]!);
}

export type DeclaredMediaSpaces = {
  flags: number;
  userSpaceContentKinds: string[];
  groupSpaceContentKinds: string[];
};

/**
 * The Spaces an Area preset declares a need for, and what each is declared to hold.
 *
 * Module metadata lives in the shared UI, so the control plane never derives this itself: the Builder
 * derives it from the Modules an Area activates and it travels with the Area preset. Anything the
 * payload does not name is simply not declared -- an unknown value is no declaration, not an error,
 * because a newer Module kind must not make an older control plane reject a publish. Content kinds are
 * passed through as the strings they arrive as, for the same reason: a kind this release has never
 * heard of belongs to a Module that knows what it means, and rejecting it here would make an older
 * control plane refuse a newer Module.
 */
export function readDeclaredMediaSpaces(value: unknown): DeclaredMediaSpaces {
  const empty: DeclaredMediaSpaces = { flags: 0, userSpaceContentKinds: [], groupSpaceContentKinds: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const declared = value as Record<string, unknown>;

  const readKinds = (spaceKind: string) => {
    const entry = declared[spaceKind];
    if (!entry || typeof entry !== "object") return null;
    const kinds = (entry as { kinds?: unknown }).kinds;
    if (!Array.isArray(kinds)) return [];
    return kinds.filter((kind): kind is string => typeof kind === "string" && kind.trim().length > 0);
  };

  const user = readKinds("user");
  const group = readKinds("group");
  return {
    flags:
      (user ? PhiSiteMediaFlags.UserSpacesEnabled : 0) |
      (group ? PhiSiteMediaFlags.GroupSpacesEnabled : 0),
    userSpaceContentKinds: user ?? [],
    groupSpaceContentKinds: group ?? [],
  };
}

/**
 * Recomputes which Space kinds the Site offers and writes the result to its Media configuration row.
 *
 * Availability is a capability, not a quota: it is the union of what the Modules of every *published*
 * Area declare. A draft therefore never widens a running Site, and deactivating the last Module that
 * declared a kind narrows it again on publish. Narrowing hides Spaces rather than deleting anything --
 * the Assets remain and keep counting against their quota.
 */
export async function materializeSiteMediaAvailabilityWithDb(
  db: MediaSpaceDbQueryable,
  siteId: number,
): Promise<DeclaredMediaSpaces> {
  const { rows } = await db.query<{ spaces: unknown }>(
    `SELECT revision.tree_json #> '{preset,config,modules,mediaSpaces}' AS spaces
     FROM phis.site_area_scopes scope
     JOIN phis.site_area_revisions revision ON revision.id = scope.published_revision_id
     WHERE scope.site_id = $1`,
    [siteId],
  );

  const union = rows.reduce<DeclaredMediaSpaces>((carried, row) => {
    const declared = readDeclaredMediaSpaces(row.spaces);
    return {
      flags: carried.flags | declared.flags,
      userSpaceContentKinds: [...carried.userSpaceContentKinds, ...declared.userSpaceContentKinds],
      groupSpaceContentKinds: [...carried.groupSpaceContentKinds, ...declared.groupSpaceContentKinds],
    };
  }, { flags: 0, userSpaceContentKinds: [], groupSpaceContentKinds: [] });

  // Sorted rather than in declaration order: this crosses Areas, and a stable row is what makes the
  // write below a no-op when nothing actually changed.
  const resolved: DeclaredMediaSpaces = {
    flags: union.flags,
    userSpaceContentKinds: [...new Set(union.userSpaceContentKinds)].sort(),
    groupSpaceContentKinds: [...new Set(union.groupSpaceContentKinds)].sort(),
  };

  await insertSiteMediaConfigWithDb(db, siteId);
  await db.query(
    `UPDATE phis.site_media_config
     SET flags = $2,
         user_space_content_kinds = $3::varchar(32)[],
         group_space_content_kinds = $4::varchar(32)[],
         updated_at = NOW()
     WHERE site_id = $1
       AND (flags IS DISTINCT FROM $2
         OR user_space_content_kinds IS DISTINCT FROM $3::varchar(32)[]
         OR group_space_content_kinds IS DISTINCT FROM $4::varchar(32)[])`,
    [siteId, resolved.flags, resolved.userSpaceContentKinds, resolved.groupSpaceContentKinds],
  );
  return resolved;
}

/**
 * Materializes a group's Media Space on first authorized write.
 *
 * Discovery is a Member right and must not create a row -- a group nobody has stored anything in
 * leaves no trace -- so this is called from the Author path, never from a read. The Site's
 * availability flag is checked by the caller, as it is for User Spaces.
 */
export async function ensureGroupMediaSpace(siteId: number, groupId: number) {
  const existing = await getGroupMediaSpace(siteId, groupId);
  if (existing) return existing;

  return withTransaction(async (client) => {
    const profile = await ensureLocalStorageProfileWithDb(client, siteId);
    const { rows } = await client.query<{
      id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
      default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
      reserved_bytes: number | string; flags: number;
    }>(
      `INSERT INTO phis.media_spaces (site_id, kind, group_id, default_storage_profile_id)
       SELECT $1, $2, g.id, $4
       FROM phis.site_groups g
       WHERE g.id = $3 AND g.site_id = $1 AND g.retired_at IS NULL
       ON CONFLICT (site_id, group_id) WHERE kind = 3
       DO UPDATE SET updated_at = NOW()
       RETURNING id, site_id, kind, user_id, group_id, default_storage_profile_id,
                 quota_bytes, used_bytes, reserved_bytes, flags`,
      [siteId, PhisMediaSpaceKind.Group, groupId, profile.id],
    );
    // No row means the group does not exist on this Site or is retired; the caller reports that.
    return rows[0] ? mapSpace(rows[0]) : null;
  });
}

export async function getGroupMediaSpace(siteId: number, groupId: number) {
  const { rows } = await getPool().query<{
    id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; flags: number;
  }>(
    `SELECT id, site_id, kind, user_id, group_id, default_storage_profile_id,
            quota_bytes, used_bytes, ${liveReservedBytes("")} AS reserved_bytes, flags
     FROM phis.media_spaces WHERE site_id = $1 AND kind = $2 AND group_id = $3`,
    [siteId, PhisMediaSpaceKind.Group, groupId],
  );
  return rows[0] ? mapSpace(rows[0]) : null;
}

export function isPhiMediaSpaceKindEnabled(config: SiteMediaConfigRecord, kind: number) {
  if (kind === PhisMediaSpaceKind.Site) return true;
  if (kind === PhisMediaSpaceKind.User) {
    return (config.flags & PhiSiteMediaFlags.UserSpacesEnabled) !== 0;
  }
  if (kind === PhisMediaSpaceKind.Group) {
    return (config.flags & PhiSiteMediaFlags.GroupSpacesEnabled) !== 0;
  }
  return false;
}

/**
 * Resolves the capacity that actually applies to one Space.
 *
 * Resolution is live rather than a creation-time snapshot: a `NULL` override reads the current Site
 * default, so changing that default moves every Space that has not been overridden. `0` is an explicit
 * revocation, and `null` here means no limit.
 */
export function resolveEffectiveMediaQuotaBytes(
  space: Pick<MediaSpaceRecord, "kind" | "quotaBytes">,
  config: SiteMediaConfigRecord,
): number | null {
  if (space.quotaBytes != null) return space.quotaBytes;
  if (space.kind === PhisMediaSpaceKind.User) return config.defaultUserQuotaBytes;
  if (space.kind === PhisMediaSpaceKind.Group) return config.defaultGroupQuotaBytes;
  // An Add-on Space inherits too. Leaving it out here said "no limit" while `reserveMediaSpaceQuota`
  // resolved the same default and refused against it -- a reader and an enforcer disagreeing about the
  // one number both exist to report.
  if (space.kind === PhisMediaSpaceKind.Addon) return config.defaultAddonQuotaBytes;
  return null;
}

export type MediaSpaceResolutionError =
  | "space_not_found"
  | "space_forbidden"
  | "space_kind_unavailable"
  /**
   * Authorized, enabled, and addressable -- but nothing has been written to it yet, so it has no row.
   * A read says so rather than creating one, because discovery is a Member right and must leave no
   * trace. A write materializes instead of reporting this.
   */
  | "space_not_materialized";

export type MediaSpaceResolution =
  | { ok: true; space: MediaSpaceRecord; config: SiteMediaConfigRecord }
  | { ok: false; reason: MediaSpaceResolutionError };

/**
 * Resolves the destination Space for a Media operation from trusted server state.
 *
 * The Site Space is the default and is always available. Any other Space must be both enabled for the
 * Site and authorized for the actor, and an unavailable Space kind is reported separately from a
 * forbidden one so an interface can distinguish "not enabled" from "not yours" and from "quota
 * exceeded". A browser supplied id is never trusted beyond being looked up.
 */
export async function resolveAuthorizedMediaSpace(input: {
  siteId: number;
  userId: number;
  requestedSpaceId?: RequestedMediaSpace | null;
  /**
   * What the caller is about to do. Only a write may bring a Group Space into existence; a read of one
   * that does not exist yet reports `space_not_materialized` and creates nothing. Defaults to a read,
   * so a caller that forgets to say cannot accidentally materialize.
   */
  intent?: "read" | "write";
  /**
   * Developer and Admin authority. The Core Admin override is a normative Site-superuser rule that
   * applies to every Site-scoped access decision, so it reaches a Group Space too -- a Space they can
   * see listed but not open would be a broken half of that rule.
   */
  siteWide?: boolean;
}): Promise<MediaSpaceResolution> {
  const config = await ensureSiteMediaConfig(input.siteId);
  if (input.requestedSpaceId == null) {
    const { space } = await ensureSiteMediaSpace(input.siteId);
    return { ok: true, space, config };
  }

  // The actor's own User Space is addressed semantically because its row may not exist yet: this is
  // the contract's lazy creation on first authorized use, gated on the availability flag. A numeric id
  // can only ever address a Space that already exists.
  if (input.requestedSpaceId === "user") {
    if (!isPhiMediaSpaceKindEnabled(config, PhisMediaSpaceKind.User)) {
      return { ok: false, reason: "space_kind_unavailable" };
    }
    const space = await ensureUserMediaSpace(input.siteId, input.userId);
    return { ok: true, space, config };
  }

  if (typeof input.requestedSpaceId === "object" && input.requestedSpaceId.kind === "group") {
    const groupId = input.requestedSpaceId.groupId;
    if (!isPhiMediaSpaceKindEnabled(config, PhisMediaSpaceKind.Group)) {
      return { ok: false, reason: "space_kind_unavailable" };
    }
    // A group that does not exist is not an empty Space; it is nothing. Checked before authority,
    // because site-wide authority would otherwise turn a bad id into a plausible empty answer.
    const group = await getSiteGroupById(input.siteId, groupId);
    if (!group) {
      return { ok: false, reason: "space_not_found" };
    }
    const flags = input.siteWide
      ? PhiGroupMembershipFlags.Manager
      : await readEffectiveGroupMembershipFlags(input.siteId, groupId, input.userId);
    if ((flags & PhiGroupMembershipFlags.Member) === 0) {
      return { ok: false, reason: "space_forbidden" };
    }
    // Writing is an Author operation -- putting something of one's own into the group -- and it is what
    // materializes the Space.
    if (input.intent === "write") {
      // A retired group takes nothing new, site-wide authority included. Its Space stays readable so
      // what is in it can be moved out; adding to it would be filling something that has ended.
      if (group.retiredAt != null) {
        return { ok: false, reason: "space_forbidden" };
      }
      if ((flags & PhiGroupMembershipFlags.Author) !== PhiGroupMembershipFlags.Author) {
        return { ok: false, reason: "space_forbidden" };
      }
      const space = await ensureGroupMediaSpace(input.siteId, groupId);
      return space ? { ok: true, space, config } : { ok: false, reason: "space_not_found" };
    }
    const space = await getGroupMediaSpace(input.siteId, groupId);
    return space ? { ok: true, space, config } : { ok: false, reason: "space_not_materialized" };
  }

  if (typeof input.requestedSpaceId === "object") {
    // `user:<id>` names someone else's Space; only administration may, and it does so through the
    // administrative route rather than here.
    return { ok: false, reason: "space_forbidden" };
  }

  const space = await getMediaSpaceById(input.siteId, input.requestedSpaceId);
  if (!space) return { ok: false, reason: "space_not_found" };
  if (!isPhiMediaSpaceKindEnabled(config, space.kind)) {
    return { ok: false, reason: "space_kind_unavailable" };
  }

  // Targeted authorization instead of materializing the full authorized list: a User Space belongs
  // to exactly one user and a Group Space to one group's effective members.
  if (space.kind === PhisMediaSpaceKind.Group && space.groupId != null) {
    /*
     * The same rule as the `group:<id>` branch above, reached by Space id instead of by group: a
     * Member may read, writing takes an Author, and a retired group takes nothing new. It used to ask
     * only for membership here, so a holder of the Media role who was a mere Member of the group could
     * rename and delete its folders by naming the Space's number instead of the group -- the one door
     * the other branch had closed. The flags come from the claim projection, as they do there, so a
     * membership whose provider is unavailable counts for nothing in either branch.
     */
    const flags = input.siteWide
      ? PhiGroupMembershipFlags.Manager
      : await readEffectiveGroupMembershipFlags(input.siteId, space.groupId, input.userId);
    if ((flags & PhiGroupMembershipFlags.Member) === 0) {
      return { ok: false, reason: "space_forbidden" };
    }
    if (input.intent === "write") {
      const group = await getSiteGroupById(input.siteId, space.groupId);
      if (group?.retiredAt != null) return { ok: false, reason: "space_forbidden" };
      if ((flags & PhiGroupMembershipFlags.Author) !== PhiGroupMembershipFlags.Author) {
        return { ok: false, reason: "space_forbidden" };
      }
    }
    return { ok: true, space, config };
  }
  const authorized = input.siteWide || space.kind === PhisMediaSpaceKind.Site ||
    (space.kind === PhisMediaSpaceKind.User && space.userId === input.userId);
  if (!authorized) return { ok: false, reason: "space_forbidden" };
  return { ok: true, space, config };
}

/**
 * Lists the Spaces an actor may select, filtered by what the Site actually enables.
 *
 * The Site Space is included for Media managers because that is the Space CMS content lives in. A
 * disabled Space kind never appears, so a selector built from this result cannot offer something the
 * Site has not switched on.
 */
export async function listSelectableMediaSpaces(input: {
  siteId: number;
  userId: number;
  includeSiteSpace: boolean;
  /** Reuses an already-resolved Site Media config instead of resolving it a second time. */
  config?: SiteMediaConfigRecord;
}) {
  const config = input.config ?? await ensureSiteMediaConfig(input.siteId);
  const spaces = (await listAuthorizedMediaSpaces(input))
    .filter((space) => isPhiMediaSpaceKindEnabled(config, space.kind));
  return {
    config,
    spaces,
    // A group the actor belongs to belongs in the selector whether or not anything has been written to
    // it: discovery is a Member right, and it must not be the thing that creates the row.
    pendingGroups: isPhiMediaSpaceKindEnabled(config, PhisMediaSpaceKind.Group)
      ? await listGroupsWithoutMediaSpace(input.siteId, input.userId)
      : [],
  };
}

/**
 * The actor's groups that have no Space row yet.
 *
 * Effective membership is read through the same join the authorized Space list uses, so a group only
 * appears here on a membership that is currently effective.
 */
export async function listGroupsWithoutMediaSpace(siteId: number, userId: number) {
  const { rows } = await getPool().query<{ id: number; name: string }>(
    `SELECT DISTINCT g.id, g.name
     FROM phis.site_groups g
     JOIN phis.site_group_members gm
       ON gm.group_id = g.id AND gm.site_id = g.site_id AND gm.user_id = $2
       AND (gm.valid_until IS NULL OR gm.valid_until > NOW())
     LEFT JOIN phis.media_spaces s ON s.site_id = g.site_id AND s.kind = $3 AND s.group_id = g.id
     WHERE g.site_id = $1 AND s.id IS NULL AND g.retired_at IS NULL
     ORDER BY g.name, g.id`,
    [siteId, userId, PhisMediaSpaceKind.Group],
  );
  return rows;
}


/**
 * Writes one Space's capacity override.
 *
 * `null` restores inheritance from the Site default, `0` is an explicit revocation that leaves the
 * Space and its Assets in place, and a positive value is that Space's own capacity. The ceiling is
 * enforced by the caller, which is the only place that knows who is asking.
 */
export async function setMediaSpaceQuotaBytes(
  siteId: number,
  spaceId: number,
  quotaBytes: number | null,
) {
  const { rows } = await getPool().query<{
    id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; flags: number;
  }>(
    `UPDATE phis.media_spaces SET quota_bytes = $3, updated_at = NOW()
     WHERE site_id = $1 AND id = $2
     RETURNING id, site_id, kind, user_id, group_id, default_storage_profile_id,
               quota_bytes, used_bytes, ${liveReservedBytes("")} AS reserved_bytes, flags`,
    [siteId, spaceId, quotaBytes],
  );
  return rows[0] ? mapSpace(rows[0]) : null;
}

export type SiteMediaConfigUpdate = {
  defaultUserQuotaBytes?: number | null;
  defaultGroupQuotaBytes?: number | null;
  maxUserQuotaBytes?: number | null;
  maxGroupQuotaBytes?: number | null;
  defaultAddonQuotaBytes?: number | null;
  maxAddonQuotaBytes?: number | null;
  /** Always positive: the schema does not allow a Site to accept an object of any size. */
  maxObjectBytes?: number;
};

/**
 * Applies an administrative change to the effective per-Site Media policy.
 *
 * The row is materialized first so an update on a never-touched Site starts from the seeded
 * installation defaults instead of implicitly creating divergent state. Only the provided fields
 * change; an explicit `null` quota clears the override back to "no Site default".
 *
 * Capacity only. Neither availability nor what a Space accepts is administered here -- both are derived
 * from what the Site's Modules declare, so `flags` and the content kinds stay untouched and an
 * administrator cannot pull them apart from the Modules that need them.
 */
export async function updateSiteMediaConfig(
  siteId: number,
  update: SiteMediaConfigUpdate,
): Promise<SiteMediaConfigRecord> {
  const current = await ensureSiteMediaConfig(siteId);
  const { rows } = await getPool().query<SiteMediaConfigRow>(
    `UPDATE phis.site_media_config
     SET default_user_quota_bytes = $2, default_group_quota_bytes = $3,
         max_user_quota_bytes = $4, max_group_quota_bytes = $5,
         default_addon_quota_bytes = $6, max_addon_quota_bytes = $7,
         max_object_bytes = $8, updated_at = NOW()
     WHERE site_id = $1
     RETURNING ${SITE_MEDIA_CONFIG_COLUMNS}`,
    [
      siteId,
      update.defaultUserQuotaBytes !== undefined ? update.defaultUserQuotaBytes : current.defaultUserQuotaBytes,
      update.defaultGroupQuotaBytes !== undefined ? update.defaultGroupQuotaBytes : current.defaultGroupQuotaBytes,
      update.maxUserQuotaBytes !== undefined ? update.maxUserQuotaBytes : current.maxUserQuotaBytes,
      update.maxGroupQuotaBytes !== undefined ? update.maxGroupQuotaBytes : current.maxGroupQuotaBytes,
      update.defaultAddonQuotaBytes !== undefined ? update.defaultAddonQuotaBytes : current.defaultAddonQuotaBytes,
      update.maxAddonQuotaBytes !== undefined ? update.maxAddonQuotaBytes : current.maxAddonQuotaBytes,
      update.maxObjectBytes !== undefined ? update.maxObjectBytes : current.maxObjectBytes,
    ],
  );
  return mapSiteMediaConfig(rows[0]!);
}

/**
 * Materializes the actor's own User Space on first authorized use.
 *
 * Callers gate on the Site's availability flag before calling this; the function itself only owns the
 * idempotent creation. The Space starts with a NULL quota override, so it inherits the current Site
 * default live, and it binds to the Site's Local Storage Profile like the Site Space does.
 */
export async function ensureUserMediaSpace(siteId: number, userId: number) {
  const existing = await getPool().query<{
    id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
    default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
    reserved_bytes: number | string; flags: number;
  }>(
    `SELECT id, site_id, kind, user_id, group_id, default_storage_profile_id,
            quota_bytes, used_bytes, ${liveReservedBytes("")} AS reserved_bytes, flags
     FROM phis.media_spaces WHERE site_id = $1 AND kind = $2 AND user_id = $3`,
    [siteId, PhisMediaSpaceKind.User, userId],
  );
  if (existing.rows[0]) return mapSpace(existing.rows[0]);

  return withTransaction(async (client) => {
    const profile = await ensureLocalStorageProfileWithDb(client, siteId);
    const { rows } = await client.query<{
      id: number; site_id: number; kind: number; user_id: number | null; group_id: number | null;
      default_storage_profile_id: number; quota_bytes: number | string | null; used_bytes: number | string;
      reserved_bytes: number | string; flags: number;
    }>(
      `INSERT INTO phis.media_spaces (site_id, kind, user_id, default_storage_profile_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (site_id, user_id) WHERE kind = 2
       DO UPDATE SET updated_at = NOW()
       RETURNING id, site_id, kind, user_id, group_id, default_storage_profile_id,
                 quota_bytes, used_bytes, reserved_bytes, flags`,
      [siteId, PhisMediaSpaceKind.User, userId, profile.id],
    );
    return mapSpace(rows[0]!);
  });
}

/**
 * Whether a Space accepts this content at all.
 *
 * Separate from quota, which asks whether there is room: this asks whether the Space is for the thing
 * in the first place. Only a Module knows that, so the list is derived from the Modules a Site
 * activates and materialized on publish -- never administered, exactly as availability is not.
 *
 * The Site Space always accepts: its authority is `PHI_ACCESS_SITE_MEDIA`, a role rather than a list,
 * and what a Site publishes includes binaries offered for download. A delegated Space accepts only
 * what some active Module said it was for, and an empty list therefore means nothing rather than
 * everything -- the opposite of how an administered list has to be read, because this one is only ever
 * empty when no Module has spoken.
 *
 * The kind is derived from the content type, which at this point is still what the uploader claimed.
 * That is deliberate and not the whole story: it refuses the wrong thing early, before any bytes move,
 * and `finalize` is where the bytes themselves decide.
 */
export function resolveMediaSpaceContentKinds(
  space: Pick<MediaSpaceRecord, "kind">,
  config: Pick<SiteMediaConfigRecord, "userSpaceContentKinds" | "groupSpaceContentKinds">,
): readonly string[] | null {
  if (space.kind === PhisMediaSpaceKind.User) return config.userSpaceContentKinds;
  if (space.kind === PhisMediaSpaceKind.Group) return config.groupSpaceContentKinds;
  return null;
}

export function isPhiMediaContentAllowedInSpace(
  contentType: string,
  space: Pick<MediaSpaceRecord, "kind">,
  config: Pick<SiteMediaConfigRecord, "userSpaceContentKinds" | "groupSpaceContentKinds">,
) {
  const accepted = resolveMediaSpaceContentKinds(space, config);
  if (accepted === null) return true;
  return accepted.includes(resolvePhiMediaKindFromContentType(contentType));
}

/**
 * There is always an object cap.
 *
 * `site_media_config_quota_check` requires `max_object_bytes > 0`, so a Site cannot state that it
 * accepts an object of any size -- an unbounded upload is a decision the schema does not offer, and
 * this reads it the same way rather than inventing a disabled value the column cannot hold.
 */
export function isPhiMediaObjectSizeAllowed(
  sizeBytes: number,
  config: Pick<SiteMediaConfigRecord, "maxObjectBytes">,
) {
  return sizeBytes <= config.maxObjectBytes;
}
