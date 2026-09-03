import type { Pool, PoolClient } from "pg";

import { PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED } from "../lib/constants/server-addons.ts";

/**
 * Whether an Add-on runs on one Site, and who says so.
 *
 * Three switches stand between an artifact on disk and a handler that answers: the desired state says
 * the instance has it, `server_addons.flags` says the instance allows it, and this row says the Site
 * wants it. They are separate because they are three different decisions by, in general, three
 * different people -- and the Site one is the only one that has never had a way to be made. The row was
 * declared in the first migration, read in two places, and written by nothing but a test harness, which
 * is why every installation so far has an operator's hand-written INSERT in it.
 *
 * The queryable is passed in rather than reached for, because `phis-cli` writes these before an
 * instance is up while the serving process reads them during a request.
 */

type Queryable = Pick<Pool | PoolClient, "query">;

export type PhisAddonSiteState = {
  siteId: number;
  addonId: string;
  requestedEnabled: boolean;
  configurationStatus: string;
  effectiveStatus: string;
  diagnosticCode: string | null;
};

type Row = {
  site_id: number;
  addon_id: string;
  flags: number;
  configuration_status: string;
  effective_status: string;
  diagnostic_code: string | null;
};

function mapRow(row: Row): PhisAddonSiteState {
  return {
    siteId: row.site_id,
    addonId: row.addon_id,
    requestedEnabled: (row.flags & PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED) !== 0,
    configurationStatus: row.configuration_status,
    effectiveStatus: row.effective_status,
    diagnosticCode: row.diagnostic_code,
  };
}

const COLUMNS =
  "site_id, addon_id, flags, configuration_status, effective_status, diagnostic_code";

export async function readPhisAddonSiteStates(db: Queryable, addonId: string) {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM phis.site_server_addons WHERE addon_id = $1 ORDER BY site_id`,
    [addonId],
  );
  return rows.map(mapRow);
}

/** The Sites that asked for this Add-on, which is where its per-Site state has to be kept up. */
export async function readPhisAddonEnabledSiteIds(db: Queryable, addonId: string) {
  const { rows } = await db.query<{ site_id: number }>(
    `SELECT site_id FROM phis.site_server_addons
      WHERE addon_id = $1 AND (flags & $2) <> 0
      ORDER BY site_id`,
    [addonId, PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED],
  );
  return rows.map((row) => row.site_id);
}

/**
 * Asks for an Add-on on one Site, or withdraws the request.
 *
 * `effective_status` is not written here. What a Site asks for and what it gets are different
 * questions -- the second one depends on the artifact loading, the capabilities resolving and the
 * configuration being complete -- and answering both in one statement would make the second one a
 * guess. Disabling sets it, because there the two cannot disagree.
 */
/**
 * Whether everything the Add-on can be configured with has an answer.
 *
 * Derived rather than stored as an opinion, and derived from the only thing there is: a setting either
 * has a value an operator wrote or a default the manifest states. An Add-on that declares nothing
 * configurable is ready the moment a Site asks for it, which is the common case and was previously
 * unreachable -- the column defaults to "missing" and nothing ever wrote it, so the check that reads it
 * could never have passed.
 *
 * A setting with neither value nor default is what makes this "missing". The manifest says the Add-on
 * must then handle null, so this is not a promise that it would fail -- it is the one place an operator
 * finds out that they were expected to say something.
 */
export function resolvePhisAddonConfigurationStatus(
  declared: ReadonlyArray<{ name: string; default?: unknown }>,
  stored: Record<string, unknown>,
) {
  const unanswered = declared.filter(
    (setting) => !(setting.name in stored) && setting.default === undefined,
  );
  return unanswered.length === 0 ? "ready" : "missing";
}

export async function setPhisAddonSiteEnabled(
  db: Queryable,
  input: {
    addonId: string;
    siteId: number;
    enabled: boolean;
    /** What the Add-on's declared settings currently amount to. Not written when disabling. */
    configurationStatus?: string;
  },
) {
  const flag = PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED;
  const { rows } = await db.query<Row>(
    input.enabled
      ? `INSERT INTO phis.site_server_addons
           (site_id, addon_id, flags, configuration_status, enabled_at, updated_at)
         VALUES ($1, $2, $3::int, $4, NOW(), NOW())
         ON CONFLICT (site_id, addon_id) DO UPDATE
           SET flags = phis.site_server_addons.flags | ($3::int),
               configuration_status = $4,
               enabled_at = NOW(),
               disabled_at = NULL,
               updated_at = NOW()
         RETURNING ${COLUMNS}`
      : `UPDATE phis.site_server_addons
            SET flags = flags & ~($3::int),
                effective_status = 'disabled',
                disabled_at = NOW(),
                updated_at = NOW()
          WHERE site_id = $1 AND addon_id = $2
         RETURNING ${COLUMNS}`,
    input.enabled
      ? [input.siteId, input.addonId, flag, input.configurationStatus ?? "missing"]
      : [input.siteId, input.addonId, flag],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Records what the last reconcile found, per Site that asked for the Add-on.
 *
 * A diagnosis and not a decision. The capability snapshot works out availability from the sources that
 * determine it -- desired state, registry, digests, migration level, request, configuration -- and no
 * longer reads this column; doing so made the answer depend on when it was last written, and nothing
 * ever wrote it, so every Add-on looked unavailable everywhere. What it is good for is an operator
 * asking "why is this not running here" without reproducing that reasoning.
 */
export async function recordPhisAddonSiteEffectiveStatus(
  db: Queryable,
  input: { addonId: string; status: string; diagnosticCode?: string | null },
) {
  const { rowCount } = await db.query(
    `UPDATE phis.site_server_addons
        SET effective_status = $2, diagnostic_code = $3, updated_at = NOW()
      WHERE addon_id = $1 AND (flags & $4) <> 0`,
    [
      input.addonId,
      input.status,
      input.diagnosticCode ?? null,
      PHI_SITE_SERVER_ADDON_FLAG_REQUESTED_ENABLED,
    ],
  );
  return rowCount ?? 0;
}
