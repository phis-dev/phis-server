import "server-only";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

import { getPool, withTransaction } from "@/lib/db";
import { PhiMediaStorageProfileFlags } from "@/lib/constants/media";
import { ensureSiteMediaConfig, ensureSiteMediaSpace } from "@/db/media-spaces";

/**
 * Which Storage Profile a Site's Spaces write to, as a Site administrator sets it.
 *
 * The Profiles themselves are the operator's: creating one names a bucket and a secret, which is why it
 * stays a CLI step (`phis storage add`). What is administered here is where the Site's Spaces point among
 * them, which ones may be pointed at, and which ones take new objects at all. Pointing a Space elsewhere
 * moves no bytes: what a Space already holds stays on the Profile it was written to.
 */
export type SiteMediaStorageProfileSummary = {
  id: number;
  key: string;
  providerId: string;
  /** The Site's Local Profile: what an unset default for new Spaces means. */
  local: boolean;
  /** `PhiMediaStorageProfileFlags.Disabled`: still delivered from, never written into. */
  disabled: boolean;
  /** How many Spaces write new uploads here, so disabling one says what it pauses. */
  spaces: number;
};

export type SiteMediaStorageSettings = {
  profiles: SiteMediaStorageProfileSummary[];
  siteSpaceProfileId: number;
  /** `null` is the Site's Local Profile, which every Space was born on before this was administered. */
  defaultUserProfileId: number | null;
  defaultGroupProfileId: number | null;
  /** Empty offers every Profile of the Site. */
  allowedProfileIds: number[];
};

export type SiteMediaStorageSettingsUpdate = {
  siteSpaceProfileId?: number;
  defaultUserProfileId?: number | null;
  defaultGroupProfileId?: number | null;
  allowedProfileIds?: number[];
  /** The whole set of disabled Profiles: every Profile named is disabled, every other one enabled. */
  disabledProfileIds?: number[];
};

export async function readSiteMediaStorageSettings(siteId: number): Promise<SiteMediaStorageSettings> {
  // Both made on first use, as everywhere else: the settings page must not fail because nobody uploaded.
  const [{ space }] = await Promise.all([ensureSiteMediaSpace(siteId), ensureSiteMediaConfig(siteId)]);
  const pool = getPool();
  const [profiles, config] = await Promise.all([
    pool.query<{ id: number; key: string; provider_id: string; flags: number; spaces: string }>(
      `SELECT p.id, p.key, p.provider_id, p.flags,
              (SELECT count(*) FROM phis.media_spaces s
                WHERE s.site_id = p.site_id AND s.default_storage_profile_id = p.id)::text AS spaces
         FROM phis.media_storage_profiles p
        WHERE p.site_id = $1 AND (p.flags & $2::int) = 0
        ORDER BY p.key`,
      // A CDN Profile is the operator's and holds no media, so it is neither listed nor offered here.
      [siteId, PhiMediaStorageProfileFlags.Cdn],
    ),
    pool.query<{
      default_user_storage_profile_id: number | null;
      default_group_storage_profile_id: number | null;
      allowed_storage_profile_ids: number[];
    }>(
      `SELECT default_user_storage_profile_id, default_group_storage_profile_id, allowed_storage_profile_ids
         FROM phis.site_media_config WHERE site_id = $1`,
      [siteId],
    ),
  ]);
  const row = config.rows[0];
  return {
    profiles: profiles.rows.map((profile) => ({
      id: profile.id,
      key: profile.key,
      providerId: profile.provider_id,
      local: profile.provider_id === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID,
      disabled: (profile.flags & PhiMediaStorageProfileFlags.Disabled) !== 0,
      spaces: Number(profile.spaces),
    })),
    siteSpaceProfileId: space.defaultStorageProfileId,
    defaultUserProfileId: row?.default_user_storage_profile_id ?? null,
    defaultGroupProfileId: row?.default_group_storage_profile_id ?? null,
    allowedProfileIds: row?.allowed_storage_profile_ids ?? [],
  };
}

/**
 * Writes the settings in one transaction, after the caller has checked them against the Site's Profiles
 * (`checkSiteMediaStorageSettingsUpdate`). Only the Site Space is re-pointed; User and Group Spaces that
 * already exist keep their Profile, and the defaults decide only for the ones made from now on.
 */
export async function updateSiteMediaStorageSettings(siteId: number, update: SiteMediaStorageSettingsUpdate) {
  await ensureSiteMediaConfig(siteId);
  await ensureSiteMediaSpace(siteId);
  await withTransaction(async (client) => {
    if (update.siteSpaceProfileId !== undefined) {
      await client.query(
        `UPDATE phis.media_spaces SET default_storage_profile_id = $2, updated_at = NOW()
          WHERE site_id = $1 AND kind = 1`,
        [siteId, update.siteSpaceProfileId],
      );
    }
    const sets: string[] = [];
    const values: unknown[] = [siteId];
    for (const [column, value] of [
      ["default_user_storage_profile_id", update.defaultUserProfileId],
      ["default_group_storage_profile_id", update.defaultGroupProfileId],
      ["allowed_storage_profile_ids", update.allowedProfileIds],
    ] as const) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}${column === "allowed_storage_profile_ids" ? "::int[]" : ""}`);
    }
    if (sets.length > 0) {
      await client.query(
        `UPDATE phis.site_media_config SET ${sets.join(", ")}, updated_at = NOW() WHERE site_id = $1`,
        values,
      );
    }
    if (update.disabledProfileIds !== undefined) {
      await client.query(
        `UPDATE phis.media_storage_profiles
            SET flags = CASE WHEN id = ANY($2::int[]) THEN flags | $3::int ELSE flags & ~$3::int END,
                updated_at = NOW()
          WHERE site_id = $1 AND (flags & $4::int) = 0
            AND ((flags & $3::int) <> 0) IS DISTINCT FROM (id = ANY($2::int[]))`,
        [siteId, update.disabledProfileIds, PhiMediaStorageProfileFlags.Disabled, PhiMediaStorageProfileFlags.Cdn],
      );
    }
  });
  return readSiteMediaStorageSettings(siteId);
}

/**
 * Why an update cannot be written, one sentence per reason, or nothing when it can.
 *
 * Pure, so the rules are tested without a database: every id names a Profile of this Site; what a
 * Space points at is an allowed Profile (the list as it will be after this update); and a Space is not
 * newly pointed at a disabled Profile. Disabling the Profile a Space already writes to is allowed -- it
 * is what pausing uploads there means.
 */
export function checkSiteMediaStorageSettingsUpdate(
  current: SiteMediaStorageSettings,
  update: SiteMediaStorageSettingsUpdate,
): string[] {
  const issues: string[] = [];
  const known = new Set(current.profiles.map((profile) => profile.id));
  const allowed = update.allowedProfileIds ?? current.allowedProfileIds;
  const disabled = new Set(
    update.disabledProfileIds ?? current.profiles.filter((profile) => profile.disabled).map((profile) => profile.id),
  );
  for (const id of [...(update.allowedProfileIds ?? []), ...(update.disabledProfileIds ?? [])]) {
    if (!known.has(id)) issues.push(`Storage Profile #${id} does not belong to this Site.`);
  }
  const pointed: [string, number | null | undefined, boolean][] = [
    ["siteSpaceProfileId", update.siteSpaceProfileId ?? current.siteSpaceProfileId,
      update.siteSpaceProfileId !== undefined && update.siteSpaceProfileId !== current.siteSpaceProfileId],
    ["defaultUserProfileId", update.defaultUserProfileId === undefined ? current.defaultUserProfileId : update.defaultUserProfileId,
      update.defaultUserProfileId !== undefined && update.defaultUserProfileId !== current.defaultUserProfileId],
    ["defaultGroupProfileId", update.defaultGroupProfileId === undefined ? current.defaultGroupProfileId : update.defaultGroupProfileId,
      update.defaultGroupProfileId !== undefined && update.defaultGroupProfileId !== current.defaultGroupProfileId],
  ];
  for (const [field, id, changed] of pointed) {
    if (id == null) continue;
    if (!known.has(id)) {
      issues.push(`${field}: Storage Profile #${id} does not belong to this Site.`);
      continue;
    }
    if (allowed.length > 0 && !allowed.includes(id)) {
      issues.push(`${field}: Storage Profile #${id} is not among the allowed Profiles.`);
    }
    if (changed && disabled.has(id)) {
      issues.push(`${field}: Storage Profile #${id} is disabled and takes no new uploads.`);
    }
  }
  return [...new Set(issues)];
}

/** One User or Group Space as the Admin storage table lists it. */
export type SiteMediaSpaceAdminRow = {
  id: number;
  kind: "user" | "group";
  /** Whose it is, as an administrator recognises them: a person's name, or a group's. */
  owner: string;
  /** A person's primary address; `null` for a group. */
  email: string | null;
  storageProfileId: number;
  /** The Space's own override; `null` inherits the Site default for its kind. */
  quotaBytes: number | null;
  usedBytes: number;
};

/**
 * The User or Group Spaces of a Site, a page at a time, for the Admin storage table.
 *
 * Only Spaces that exist: a person who never uploaded has no Space yet, and one is made on first use with
 * the Site's default Profile and quota, which is what the settings above the table already decide.
 */
export async function listSiteMediaSpacesForAdmin(
  siteId: number,
  kind: "user" | "group",
  page: { limit: number; offset: number; search?: string | null },
): Promise<{ rows: SiteMediaSpaceAdminRow[]; total: number }> {
  const search = page.search?.trim().toLowerCase() || null;
  const { rows } = await getPool().query<{
    id: number; owner: string | null; email: string | null; default_storage_profile_id: number;
    quota_bytes: string | null; used_bytes: string; total: string;
  }>(
    kind === "user"
      ? `SELECT s.id,
                COALESCE(NULLIF(p.display_name, ''), NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '')) AS owner,
                e.email_normalized AS email,
                s.default_storage_profile_id, s.quota_bytes::text, s.used_bytes::text,
                count(*) OVER ()::text AS total
           FROM phis.media_spaces s
           LEFT JOIN phis.user_profiles p ON p.user_id = s.user_id
           LEFT JOIN phis.user_emails e ON e.user_id = s.user_id AND (e.flags & 1) <> 0
          WHERE s.site_id = $1 AND s.kind = 2
            AND ($4::text IS NULL OR lower(CONCAT(p.display_name, ' ', p.first_name, ' ', p.last_name, ' ', e.email_normalized)) LIKE '%' || $4 || '%')
          ORDER BY owner NULLS LAST, s.id
          LIMIT $2 OFFSET $3`
      : `SELECT s.id, g.name AS owner, NULL::text AS email,
                s.default_storage_profile_id, s.quota_bytes::text, s.used_bytes::text,
                count(*) OVER ()::text AS total
           FROM phis.media_spaces s
           JOIN phis.site_groups g ON g.id = s.group_id
          WHERE s.site_id = $1 AND s.kind = 3
            AND ($4::text IS NULL OR lower(g.name) LIKE '%' || $4 || '%')
          ORDER BY g.name, s.id
          LIMIT $2 OFFSET $3`,
    [siteId, page.limit, page.offset, search],
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    rows: rows.map((row) => ({
      id: row.id,
      kind,
      owner: row.owner ?? `#${row.id}`,
      email: row.email,
      storageProfileId: row.default_storage_profile_id,
      quotaBytes: row.quota_bytes == null ? null : Number(row.quota_bytes),
      usedBytes: Number(row.used_bytes),
    })),
  };
}

/**
 * Points one User or Group Space at another Profile. Only new uploads follow; what the Space holds stays
 * where it was written. The caller checks the Profile against the offered list and the Instances.
 */
export async function setSiteMediaSpaceStorageProfile(siteId: number, spaceId: number, profileId: number) {
  const result = await getPool().query(
    `UPDATE phis.media_spaces SET default_storage_profile_id = $3, updated_at = NOW()
      WHERE site_id = $1 AND id = $2 AND kind IN (2, 3)`,
    [siteId, spaceId, profileId],
  );
  return (result.rowCount ?? 0) > 0;
}
