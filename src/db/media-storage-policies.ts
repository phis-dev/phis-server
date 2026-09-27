import "server-only";

import { getPool } from "@/lib/db";
import { resolvePhisMediaStorageConfig } from "@/lib/media-storage";
import type { PhiMediaStoragePolicyProfile } from "@/lib/media-storage-policies-core";

/**
 * Every Storage Profile with the Site that belongs to it.
 *
 * What a storage is told about a Site -- which origins may write to it, which keys are staging -- is derived
 * rather than configured, and this is the read it is derived from: a Site states its origin in
 * `public_base_url`, and the Sites a storage serves are the ones whose Profiles resolve to it. Ordered by
 * Profile id so a report reads the same twice.
 *
 * The grouping and the rule-writing live in `@/lib/media-storage-policies-core`, which the CLI shares and
 * which therefore holds no SQL: it takes these rows as a parameter.
 */
export async function readPhiMediaStoragePolicyProfiles(): Promise<PhiMediaStoragePolicyProfile[]> {
  const { rows } = await getPool().query<{
    id: number; site_id: number; provider_id: string; config: Record<string, unknown>;
    secret_reference: string | null; site_key: string; public_base_url: string;
  }>(
    `SELECT p.id, p.site_id, p.provider_id, p.config, p.secret_reference,
            s.key AS site_key, s.public_base_url
     FROM phis.media_storage_profiles p
     JOIN phis.sites s ON s.id = p.site_id
     ORDER BY p.id`,
  );
  // Core's key prefix is one installation-wide setting, so it is read once rather than per row.
  const { storageKeyPrefix } = resolvePhisMediaStorageConfig();
  return rows.map((row): PhiMediaStoragePolicyProfile => ({
    id: row.id,
    siteId: row.site_id,
    siteKey: row.site_key,
    providerId: row.provider_id,
    config: row.config ?? {},
    secretReference: row.secret_reference,
    publicBaseUrl: row.public_base_url,
    storageKeyPrefix,
  }));
}
