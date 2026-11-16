import type { Pool } from "pg";

import { deleteSitePageOverrideWithDb } from "../db/site-page-override.mts";
import { withPoolTransaction } from "../lib/db-transaction.ts";
import { isPhisCmsAreaKey, PHIS_CMS_AREA_KEYS, resolvePhisCmsAreaKey, resolvePhisCmsAreaMask } from "../lib/constants/cms-areas.ts";
import { normalizeSiteCmsPath } from "../lib/helpers/cms-path.ts";

/**
 * `phis page list|reset`: the Pages a Site has stored itself, and taking a Module's Page back to its preset.
 *
 * `list` reads `phis.site_page_scopes` and nothing else. `reset` finds the one stored Page the operator
 * means and then runs `deleteSitePageOverrideWithDb`, the function behind the Builder's "Reset to preset"
 * (`handleSiteCmsPageOverrideDelete`; CONTENT.md, Reset), in one transaction. The deletion, the Content
 * sweep, the reference rows and the change markers are that function's; nothing here deletes a row.
 */

export type PhiStoredPage = {
  scopeId: number;
  area: string;
  path: string | null;
  ownerModuleId: string | null;
  presetKey: string | null;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
  tombstoned: boolean;
  updatedAt: string;
};

type ScopeRow = {
  id: number;
  area_id: number;
  path: string | null;
  draft_path: string | null;
  owner_module_id: string | null;
  preset_key: string | null;
  tombstoned_at: Date | null;
  published_revision_id: number | null;
  working_draft_revision_id: number | null;
  updated_at: Date;
};

const SCOPE_COLUMNS = `id, area_id, path, draft_path, owner_module_id, preset_key, tombstoned_at,
       published_revision_id, working_draft_revision_id, updated_at`;

function toStoredPage(row: ScopeRow): PhiStoredPage {
  return {
    scopeId: row.id,
    area: resolvePhisCmsAreaKey(row.area_id),
    path: row.path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
    tombstoned: row.tombstoned_at != null,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function requireSiteId(pool: Pool, siteKey: string) {
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM phis.sites WHERE key = $1", [siteKey]);
  if (!rows[0]) throw new Error(`No Site has the key "${siteKey}".`);
  return rows[0].id;
}

/** The Area is named by its key, as in the Builder's route and the Site's `area` parameter. */
function requireAreaMask(area: string) {
  if (!isPhisCmsAreaKey(area)) {
    throw new Error(`"${area}" is not an Area; the Areas are ${PHIS_CMS_AREA_KEYS.join(", ")}.`);
  }
  return resolvePhisCmsAreaMask(area);
}

/** Every Page the Site itself has stored, in one Area or in all of them. */
export async function listPhiStoredPages(pool: Pool, options: { siteKey: string; area?: string | null }) {
  const siteId = await requireSiteId(pool, options.siteKey);
  const areaMask = options.area ? requireAreaMask(options.area) : null;
  const { rows } = await pool.query<ScopeRow>(
    `SELECT ${SCOPE_COLUMNS}
     FROM phis.site_page_scopes
     WHERE site_id = $1 AND ($2::int IS NULL OR area_id = $2)
     ORDER BY area_id, COALESCE(path, owner_module_id || '/' || preset_key), id`,
    [siteId, areaMask],
  );
  return rows.map(toStoredPage);
}

export type PhiPageResetPlan = {
  site: string;
  page: PhiStoredPage;
  revisions: number;
};

export type PhiPageResetResult = PhiPageResetPlan & { dryRun: boolean; deleted: boolean };

/**
 * Resets the one stored Module Page the options name to its preset.
 *
 * Refused, with the reason as the message: an unknown Site or Area, nothing stored for the address, more
 * than one stored Page for it, and a stored Page that is a Site's own and so has no preset to go back to.
 * Without `confirmed` it reports what would go and changes nothing.
 */
export async function resetPhiPageToPreset(
  pool: Pool,
  options: {
    siteKey: string;
    area: string;
    presetKey?: string | null;
    moduleId?: string | null;
    path?: string | null;
    confirmed: boolean;
    dryRun: boolean;
  },
): Promise<PhiPageResetResult> {
  if ((options.presetKey == null) === (options.path == null)) {
    throw new Error("Name the Page with --preset <preset key> or --path <path>, one of them.");
  }
  if (options.path != null && options.moduleId != null) {
    throw new Error("--module narrows --preset; a path names a Site's own Page, which has no Module.");
  }
  const siteId = await requireSiteId(pool, options.siteKey);
  const areaMask = requireAreaMask(options.area);

  const byPreset = options.presetKey != null;
  const wanted = byPreset ? options.presetKey : normalizeSiteCmsPath(options.path);
  const { rows } = await pool.query<ScopeRow>(
    byPreset
      ? `SELECT ${SCOPE_COLUMNS} FROM phis.site_page_scopes
         WHERE site_id = $1 AND area_id = $2 AND preset_key = $3 AND ($4::text IS NULL OR owner_module_id = $4)
         ORDER BY id`
      : `SELECT ${SCOPE_COLUMNS} FROM phis.site_page_scopes
         WHERE site_id = $1 AND area_id = $2 AND (path = $3 OR draft_path = $3) AND $4::text IS NULL
         ORDER BY id`,
    [siteId, areaMask, wanted, options.moduleId ?? null],
  );
  const target = `${byPreset ? `preset "${wanted}"` : `path "${wanted}"`} in Area ${options.area} of ${options.siteKey}`;
  if (rows.length === 0) {
    throw new Error(`Nothing stored for ${target}; the preset is already live.`);
  }
  if (rows.length > 1) {
    const found = rows.map((row) => `${row.owner_module_id ?? row.path}/${row.preset_key ?? ""}`).join(", ");
    throw new Error(`More than one stored Page matches ${target} (${found}); add --module <Module id> to name one.`);
  }
  const row = rows[0]!;
  if (row.owner_module_id == null || row.preset_key == null) {
    throw new Error(
      `The stored Page at ${row.path} (${target}) is the Site's own, not a Module's: there is no preset to go back to, and this command does not delete it.`,
    );
  }

  const page = toStoredPage(row);
  const { rows: counted } = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM phis.site_page_revisions WHERE page_scope_id = $1",
    [row.id],
  );
  const plan = { site: options.siteKey, page, revisions: Number(counted[0]?.count ?? 0) };
  if (options.dryRun || !options.confirmed) {
    return { ...plan, dryRun: true, deleted: false };
  }

  // `deleted` of the function is false for a scope that held no revision; the scope is gone either way.
  await withPoolTransaction(pool, (client) =>
    deleteSitePageOverrideWithDb(client, siteId, {
      areaMask,
      sourcePreset: { ownerModuleId: row.owner_module_id!, presetKey: row.preset_key! },
    }));
  return { ...plan, dryRun: false, deleted: true };
}
