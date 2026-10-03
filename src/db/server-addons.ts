import "server-only";

import { getPool } from "@/lib/db";
import { hasPhiFlag } from "@/lib/helpers/flags";
import {
  PHIS_ADDON_FLAG_GLOBALLY_ENABLED,
  PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED,
} from "@/lib/constants/server-addons";
import { phiPrepared } from "@/lib/db-prepared";

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

type PhisAddonRegistryRow = {
  addon_id: string;
  package_name: string;
  package_version: string;
  server_abi: string;
  migration_version: number;
  manifest_digest: string;
  release_build_id: string;
  flags: number;
};

function mapPhisAddonRegistryRow(row: PhisAddonRegistryRow) {
  return {
    addonId: row.addon_id,
    packageName: row.package_name,
    packageVersion: row.package_version,
    serverAbi: row.server_abi,
    migrationVersion: row.migration_version,
    manifestDigest: row.manifest_digest,
    releaseBuildId: row.release_build_id,
    globallyEnabled:
      hasPhiFlag(row.flags, PHIS_ADDON_FLAG_GLOBALLY_ENABLED),
  } satisfies PhisAddonRegistryRecord;
}

export async function getPhisAddonRegistryRecord(addonId: string) {
  const { rows } = await getPool().query<PhisAddonRegistryRow>(
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
  return row ? mapPhisAddonRegistryRow(row) : null;
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
      hasPhiFlag(row.flags, PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED) &&
      row.configuration_status === "ready",
  );
}

export type PhisAddonCapabilityStateRow = PhisAddonRegistryRow & {
  site_flags: number | null;
  configuration_status: string | null;
  diagnostic_code: string | null;
};

export type PhisAddonCapabilityState = {
  registry: PhisAddonRegistryRecord;
  siteState: { requestedEnabled: boolean; configurationStatus: string; diagnosticCode: string | null } | null;
};

/**
 * The registry rows of the named Add-ons with their state on one Site, the ids and the Site given as SQL
 * expressions. Read here, and embedded in the request-actor read (`site-request-actor.ts`).
 */
export function phisAddonCapabilityStatesSql(addonIdsRef: string, siteRef: string) {
  return `SELECT a.addon_id,
            a.package_name,
            a.package_version,
            a.server_abi,
            a.migration_version,
            a.manifest_digest,
            a.release_build_id,
            a.flags,
            s.flags AS site_flags,
            s.configuration_status,
            s.diagnostic_code
       FROM phis.server_addons a
       LEFT JOIN phis.site_server_addons s
         ON s.addon_id = a.addon_id
        AND s.site_id = ${siteRef}
      WHERE a.addon_id = ANY(${addonIdsRef})`;
}

export function mapPhisAddonCapabilityStateRows(rows: readonly PhisAddonCapabilityStateRow[]) {
  return new Map<string, PhisAddonCapabilityState>(rows.map((row) => [row.addon_id, {
    registry: mapPhisAddonRegistryRow(row),
    siteState: row.site_flags === null || row.configuration_status === null
      ? null
      : {
          requestedEnabled: hasPhiFlag(row.site_flags, PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED),
          configurationStatus: row.configuration_status,
          diagnosticCode: row.diagnostic_code,
        },
  }]));
}

/**
 * The registry row of each named Add-on and its state on one Site, in one statement.
 *
 * The capability snapshot needs both for every installed Add-on, and it is built on every authorization
 * read. Asked one Add-on at a time it cost two statements per Add-on per read; asked here it costs one,
 * however many are installed. An Add-on without a registry row is absent from the answer; one the Site
 * has no row for carries `siteState: null`.
 */
export async function readPhisAddonCapabilityStates(addonIds: readonly string[], siteId: number) {
  if (addonIds.length === 0) {
    return new Map<string, PhisAddonCapabilityState>();
  }
  const { rows } = await getPool().query<PhisAddonCapabilityStateRow>(phiPrepared(
    phisAddonCapabilityStatesSql("$1::text[]", "$2"),
    [addonIds, siteId],
  ));
  return mapPhisAddonCapabilityStateRows(rows);
}
