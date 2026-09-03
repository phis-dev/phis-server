import "server-only";

import { getPool } from "@/lib/db";
import {
  PHIS_ADDON_FLAG_GLOBALLY_ENABLED,
  PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED,
} from "@/lib/constants/server-addons";

export type PhisAddonRegistryRecord = {
  addonId: string;
  packageName: string;
  packageVersion: string;
  serverAbi: string;
  migrationVersion: number;
  manifestDigest: string;
  releaseBuildId: string;
  globallyEnabled: boolean;
};

export async function getPhisAddonRegistryRecord(addonId: string) {
  const { rows } = await getPool().query<{
    addon_id: string;
    package_name: string;
    package_version: string;
    server_abi: string;
    migration_version: number;
    manifest_digest: string;
    release_build_id: string;
    flags: number;
  }>(
    `SELECT addon_id,
            package_name,
            package_version,
            server_abi,
            migration_version,
            manifest_digest,
            release_build_id,
            flags
       FROM phis.server_addons
      WHERE addon_id = $1
      LIMIT 1`,
    [addonId],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    addonId: row.addon_id,
    packageName: row.package_name,
    packageVersion: row.package_version,
    serverAbi: row.server_abi,
    migrationVersion: row.migration_version,
    manifestDigest: row.manifest_digest,
    releaseBuildId: row.release_build_id,
    globallyEnabled:
      (row.flags & PHIS_ADDON_FLAG_GLOBALLY_ENABLED) !== 0,
  } satisfies PhisAddonRegistryRecord;
}

export async function isPhisAddonEnabledForSite(addonId: string, siteId: number) {
  const { rows } = await getPool().query<{
    flags: number;
    configuration_status: string;
  }>(
    `SELECT flags, configuration_status
       FROM phis.site_server_addons
      WHERE addon_id = $1
        AND site_id = $2
      LIMIT 1`,
    [addonId, siteId],
  );

  const row = rows[0];
  return Boolean(
    row &&
      (row.flags & PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED) !== 0 &&
      row.configuration_status === "ready",
  );
}

export async function getPhisAddonSiteState(addonId: string, siteId: number) {
  const { rows } = await getPool().query<{
    flags: number;
    configuration_status: string;
    effective_status: string;
    diagnostic_code: string | null;
  }>(
    `SELECT flags,
            configuration_status,
            effective_status,
            diagnostic_code
       FROM phis.site_server_addons
      WHERE addon_id = $1
        AND site_id = $2
      LIMIT 1`,
    [addonId, siteId],
  );

  const row = rows[0];
  return row
    ? {
        requestedEnabled:
          (row.flags & PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED) !== 0,
        configurationStatus: row.configuration_status,
        effectiveStatus: row.effective_status,
        diagnosticCode: row.diagnostic_code,
      }
    : null;
}

