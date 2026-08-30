import "server-only";

import type { PoolClient } from "pg";

import {
  collectRevisionContentIds,
  deleteOrphanedSiteContentByIdsWithDb,
} from "@/db/site-content";
import { getPool } from "@/lib/db";
import { isPhiServerCmsAreaKey, resolvePhiServerCmsAreaKey } from "@/lib/constants/cms-areas";
import { PhiCmsRevisionFlags } from "@/lib/constants/phi-cms";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import { getSiteThemeRevisionByIdWithDb, normalizeSiteThemeScopeKey } from "@/db/site-theme";

type DbQueryable = Pick<PoolClient, "query">;

export type SiteRevisionKind = "area" | "page" | "navigation" | "theme";

export type SiteRevisionPresetIdentity = {
  ownerModuleId: string;
  presetKey: string;
};

export type SiteRevisionPageAddress =
  | { kind: "path"; path: string }
  | ({ kind: "preset" } & SiteRevisionPresetIdentity);

export type SiteRevisionScopeInput =
  | {
      kind: "area";
      areaMask: number;
      sourcePreset: SiteRevisionPresetIdentity;
    }
  | {
      kind: "page";
      areaMask: number;
      address: SiteRevisionPageAddress;
    }
  | {
      kind: "navigation";
      key: string;
    }
  | {
      kind: "theme";
      key?: string | null;
    };

export type SiteRevisionScopeSummary = {
  kind: SiteRevisionKind;
  area: string;
  path: string | null;
  navKey: string | null;
  themeKey: string | null;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SiteRevisionHistoryRow = {
  revisionId: number;
  createdAt: string;
  createdByUserId: number | null;
  createdByLabel: string | null;
  message: string | null;
  meta: Record<string, unknown>;
  sourceRevisionId: number | null;
  isPublished: boolean;
  isWorkingDraft: boolean;
  isDeleted: boolean;
  sourcePreset: (SiteRevisionPresetIdentity & { sourcePresetVersion: number }) | null;
};

export type SiteRevisionHistoryResult = {
  scope: SiteRevisionScopeSummary;
  rows: SiteRevisionHistoryRow[];
};

export type RestoreSiteRevisionResult = {
  scope: SiteRevisionScopeSummary;
  restoredFromRevisionId: number;
  revisionId: number;
};

function normalizeNavigationKeyPart(input: string) {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized.includes(":")) {
    throw new Error("navKey must be provided without area prefix.");
  }

  return normalized;
}

function requireSiteNavigationScopeKey(value: string) {
  const normalized = value.trim().toLowerCase();
  const separatorIndex = normalized.indexOf(":");
  if (
    separatorIndex <= 0 ||
    separatorIndex >= normalized.length - 1 ||
    normalized.indexOf(":", separatorIndex + 1) !== -1 ||
    !isPhiServerCmsAreaKey(normalized.slice(0, separatorIndex))
  ) {
    throw new Error("Navigation key must be formatted as area:key.");
  }

  return normalized;
}

function buildScopeSummary(
  input: SiteRevisionScopeInput,
  pointers: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
  },
): SiteRevisionScopeSummary {
  if (input.kind === "navigation") {
    const [area, navKey] = requireSiteNavigationScopeKey(input.key).split(":");
    return {
      kind: "navigation",
      area,
      path: null,
      navKey,
      themeKey: null,
      publishedRevisionId: pointers.publishedRevisionId,
      workingDraftRevisionId: pointers.workingDraftRevisionId,
    };
  }

  if (input.kind === "theme") {
    return {
      kind: "theme",
      area: "site",
      path: null,
      navKey: null,
      themeKey: normalizeSiteThemeScopeKey(input.key),
      publishedRevisionId: pointers.publishedRevisionId,
      workingDraftRevisionId: pointers.workingDraftRevisionId,
    };
  }

  const area = resolvePhiServerCmsAreaKey(input.areaMask);
  return {
    kind: input.kind,
    area,
    path: input.kind === "page" && input.address.kind === "path"
      ? normalizeSiteCmsPath(input.address.path)
      : null,
    navKey: null,
    themeKey: null,
    publishedRevisionId: pointers.publishedRevisionId,
    workingDraftRevisionId: pointers.workingDraftRevisionId,
  };
}

function mapRevisionRows(
  rows: Array<{
    id: number;
    flags: number;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_by_label: string | null;
    created_at: string;
    tree_json: Record<string, unknown> | null;
  }>,
  scope: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
  },
): SiteRevisionHistoryRow[] {
  return rows.map((row) => {
    const source = row.tree_json?.sourcePreset;
    const sourceRecord = source && typeof source === "object" && !Array.isArray(source)
      ? source as Record<string, unknown>
      : null;
    const sourcePreset = sourceRecord &&
      typeof sourceRecord.ownerModuleId === "string" && typeof sourceRecord.presetKey === "string" &&
      Number.isInteger(sourceRecord.sourcePresetVersion) && (sourceRecord.sourcePresetVersion as number) > 0
      ? {
          ownerModuleId: sourceRecord.ownerModuleId,
          presetKey: sourceRecord.presetKey,
          sourcePresetVersion: sourceRecord.sourcePresetVersion as number,
        }
      : null;
    return {
      revisionId: row.id,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      createdByLabel: row.created_by_label,
      message: row.message,
      meta: row.meta_json && typeof row.meta_json === "object" && !Array.isArray(row.meta_json)
        ? row.meta_json
        : {},
      sourceRevisionId: row.source_revision_id,
      isPublished: scope.publishedRevisionId === row.id,
      isWorkingDraft: scope.workingDraftRevisionId === row.id,
      isDeleted: (row.flags & PhiCmsRevisionFlags.Deleted) !== 0,
      sourcePreset,
    };
  });
}

async function listRevisionRowsWithDb(
  db: DbQueryable,
  scopeColumn: "area_scope_id" | "page_scope_id" | "nav_scope_id" | "theme_scope_id",
  tableName: "site_area_revisions" | "site_page_revisions" | "site_nav_revisions" | "site_theme_revisions",
  scopeId: number,
) {
  const { rows } = await db.query<{
    id: number;
    flags: number;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_by_label: string | null;
    created_at: string;
    tree_json: Record<string, unknown> | null;
  }>(
    `SELECT revision.id,
            revision.flags,
            revision.message,
            revision.meta_json,
            revision.source_revision_id,
            revision.created_by_user_id,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', profile.first_name, profile.last_name)), ''),
              account.email_normalized,
              CASE
                WHEN revision.created_by_user_id IS NOT NULL
                  THEN 'User #' || revision.created_by_user_id::text
                ELSE NULL
              END
            ) AS created_by_label,
            revision.created_at,
            revision.tree_json
     FROM phis.${tableName} revision
     LEFT JOIN phis.user_account_directory account
       ON account.id = revision.created_by_user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = revision.created_by_user_id
     WHERE revision.${scopeColumn} = $1
     ORDER BY revision.created_at DESC, revision.id DESC`,
    [scopeId],
  );

  return rows;
}

async function getAreaScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
): Promise<{
  id: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
} | null> {
  const { rows } = await db.query<{
    id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, published_revision_id, working_draft_revision_id
     FROM phis.site_area_scopes
     WHERE site_id = $1
       AND area_id = $2
     LIMIT 1`,
    [siteId, areaMask],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        publishedRevisionId: row.published_revision_id,
        workingDraftRevisionId: row.working_draft_revision_id,
      }
    : null;
}

async function getPageScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SiteRevisionPageAddress,
): Promise<{
  id: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
} | null> {
  const normalizedPath = address.kind === "path" ? normalizeSiteCmsPath(address.path) : null;
  const { rows } = await db.query<{
    id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, published_revision_id, working_draft_revision_id
     FROM phis.site_page_scopes
     WHERE site_id = $1
       AND area_id = $2
       AND ${address.kind === "path"
         ? "path = $3 AND owner_module_id IS NULL AND preset_key IS NULL"
         : "path IS NULL AND owner_module_id = $3 AND preset_key = $4"}
     LIMIT 1`,
    address.kind === "path"
      ? [siteId, areaMask, normalizedPath]
      : [siteId, areaMask, address.ownerModuleId, address.presetKey],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        publishedRevisionId: row.published_revision_id,
        workingDraftRevisionId: row.working_draft_revision_id,
      }
    : null;
}

async function getNavigationScopeWithDb(
  db: DbQueryable,
  siteId: number,
  key: string,
): Promise<{
  id: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
} | null> {
  const normalizedKey = requireSiteNavigationScopeKey(key);
  const { rows } = await db.query<{
    id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, published_revision_id, working_draft_revision_id
     FROM phis.site_nav_scopes
     WHERE site_id = $1
       AND key = $2
     LIMIT 1`,
    [siteId, normalizedKey],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        publishedRevisionId: row.published_revision_id,
        workingDraftRevisionId: row.working_draft_revision_id,
      }
    : null;
}

async function getThemeScopeWithDb(
  db: DbQueryable,
  siteId: number,
  key: string | null | undefined,
): Promise<{
  id: number;
  key: string;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
} | null> {
  const normalizedKey = normalizeSiteThemeScopeKey(key);
  const { rows } = await db.query<{
    id: number;
    key: string;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, key, published_revision_id, working_draft_revision_id
     FROM phis.site_theme_scopes
     WHERE site_id = $1
       AND key = $2
     LIMIT 1`,
    [siteId, normalizedKey],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        key: row.key,
        publishedRevisionId: row.published_revision_id,
        workingDraftRevisionId: row.working_draft_revision_id,
      }
    : null;
}

type ResolvedRevisionScope =
  | {
      kind: "area";
      areaMask: number;
      sourcePreset: SiteRevisionPresetIdentity;
      scopeId: number | null;
      publishedRevisionId: number | null;
      workingDraftRevisionId: number | null;
    }
  | {
      kind: "page";
      areaMask: number;
      address: SiteRevisionPageAddress;
      scopeId: number | null;
      publishedRevisionId: number | null;
      workingDraftRevisionId: number | null;
    }
  | {
      kind: "navigation";
      key: string;
      scopeId: number | null;
      publishedRevisionId: number | null;
      workingDraftRevisionId: number | null;
    }
  | {
      kind: "theme";
      key: string;
      scopeId: number | null;
      publishedRevisionId: number | null;
      workingDraftRevisionId: number | null;
    };

async function resolveRevisionScopeWithDb(
  db: DbQueryable,
  siteId: number,
  input: SiteRevisionScopeInput,
): Promise<ResolvedRevisionScope> {
  if (input.kind === "area") {
    const scope = await getAreaScopeWithDb(db, siteId, input.areaMask);
    return {
      kind: "area",
      areaMask: input.areaMask,
      sourcePreset: input.sourcePreset,
      scopeId: scope?.id ?? null,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
    };
  }

  if (input.kind === "page") {
    const address = input.address.kind === "path"
      ? { kind: "path" as const, path: normalizeSiteCmsPath(input.address.path) }
      : input.address;
    const scope = await getPageScopeWithDb(db, siteId, input.areaMask, address);
    return {
      kind: "page",
      areaMask: input.areaMask,
      address,
      scopeId: scope?.id ?? null,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
    };
  }

  if (input.kind === "theme") {
    const normalizedKey = normalizeSiteThemeScopeKey(input.key);
    const scope = await getThemeScopeWithDb(db, siteId, normalizedKey);
    return {
      kind: "theme",
      key: normalizedKey,
      scopeId: scope?.id ?? null,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
    };
  }

  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const scope = await getNavigationScopeWithDb(db, siteId, normalizedKey);
  return {
    kind: "navigation",
    key: normalizedKey,
    scopeId: scope?.id ?? null,
    publishedRevisionId: scope?.publishedRevisionId ?? null,
    workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
  };
}

async function getAreaRevisionByIdWithDb(
  db: DbQueryable,
  revisionId: number,
) {
  const { rows } = await db.query<{
    id: number;
    area_scope_id: number;
    tree_json: Record<string, unknown>;
  }>(
    `SELECT id, area_scope_id, tree_json
     FROM phis.site_area_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  );

  return rows[0] ?? null;
}

async function getPageRevisionByIdWithDb(
  db: DbQueryable,
  revisionId: number,
) {
  const { rows } = await db.query<{
    id: number;
    page_scope_id: number;
    flags: number;
    tree_json: Record<string, unknown>;
  }>(
    `SELECT id, page_scope_id, flags, tree_json
     FROM phis.site_page_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  );

  return rows[0] ?? null;
}

async function cleanupEmptyPageScopeWithDb(db: DbQueryable, scopeId: number) {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM phis.site_page_revisions
     WHERE page_scope_id = $1`,
    [scopeId],
  );
  const revisionCount = Number.parseInt(rows[0]?.count ?? "0", 10);
  if (revisionCount > 0) {
    return;
  }

  await db.query(
    `DELETE FROM phis.site_page_scopes
     WHERE id = $1
       AND published_revision_id IS NULL
       AND working_draft_revision_id IS NULL`,
    [scopeId],
  );
}

async function getNavigationRevisionByIdWithDb(
  db: DbQueryable,
  revisionId: number,
) {
  const { rows } = await db.query<{
    id: number;
    nav_scope_id: number;
    next_node_sequence: string | number;
    tree_json: Record<string, unknown>;
  }>(
    `SELECT id, nav_scope_id, next_node_sequence, tree_json
     FROM phis.site_nav_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  );

  return rows[0] ?? null;
}

class SiteRevisionConflictError extends Error {}
class SiteRevisionNotFoundError extends Error {}

export async function listSiteRevisionHistory(
  siteId: number,
  input: SiteRevisionScopeInput,
): Promise<SiteRevisionHistoryResult> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const db = getPool();
  const scope = await resolveRevisionScopeWithDb(db, siteId, input);
  const scopeSummary = buildScopeSummary(input, {
    publishedRevisionId: scope.publishedRevisionId,
    workingDraftRevisionId: scope.workingDraftRevisionId,
  });

  if (!scope.scopeId) {
    return {
      scope: scopeSummary,
      rows: [],
    };
  }

  if (scope.kind === "area") {
    const rows = await listRevisionRowsWithDb(db, "area_scope_id", "site_area_revisions", scope.scopeId);
    return {
      scope: scopeSummary,
      rows: mapRevisionRows(rows, scope),
    };
  }

  if (scope.kind === "page") {
    const rows = await listRevisionRowsWithDb(db, "page_scope_id", "site_page_revisions", scope.scopeId);
    return {
      scope: scopeSummary,
      rows: mapRevisionRows(rows, scope),
    };
  }

  if (scope.kind === "theme") {
    const rows = await listRevisionRowsWithDb(db, "theme_scope_id", "site_theme_revisions", scope.scopeId);
    return {
      scope: scopeSummary,
      rows: mapRevisionRows(rows, scope),
    };
  }

  const rows = await listRevisionRowsWithDb(db, "nav_scope_id", "site_nav_revisions", scope.scopeId);
  return {
    scope: scopeSummary,
    rows: mapRevisionRows(rows, scope),
  };
}

export async function restoreSiteRevision(
  siteId: number,
  input: SiteRevisionScopeInput & {
    revisionId: number;
    createdByUserId?: number | null;
  },
): Promise<RestoreSiteRevisionResult> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  if (!Number.isInteger(input.revisionId) || input.revisionId <= 0) {
    throw new Error("revisionId must be a positive integer.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await resolveRevisionScopeWithDb(client, siteId, input);
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }

    let newRevisionId: number;
    if (scope.kind === "area") {
      const revision = await getAreaRevisionByIdWithDb(client, input.revisionId);
      if (!revision || revision.area_scope_id !== scope.scopeId) {
        throw new SiteRevisionNotFoundError("Area revision not found for the requested scope.");
      }

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO phis.site_area_revisions (
           area_scope_id,
           flags,
           tree_json,
           message,
           source_revision_id,
           created_by_user_id
         )
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING id`,
        [
          scope.scopeId,
          PhiCmsRevisionFlags.Draft,
          JSON.stringify(revision.tree_json ?? {}),
          `Restored from revision #${input.revisionId}`,
          input.revisionId,
          input.createdByUserId ?? null,
        ],
      );
      newRevisionId = rows[0]!.id;
      await client.query(
        `UPDATE phis.site_area_scopes
         SET working_draft_revision_id = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [scope.scopeId, newRevisionId],
      );
    } else if (scope.kind === "page") {
      const revision = await getPageRevisionByIdWithDb(client, input.revisionId);
      if (!revision || revision.page_scope_id !== scope.scopeId) {
        throw new SiteRevisionNotFoundError("Page revision not found for the requested scope.");
      }

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO phis.site_page_revisions (
           page_scope_id,
           flags,
           tree_json,
           message,
           source_revision_id,
           created_by_user_id,
           created_at
         )
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
         RETURNING id`,
        [
          scope.scopeId,
          PhiCmsRevisionFlags.Draft |
            ((revision.flags & PhiCmsRevisionFlags.Deleted) !== 0 ? PhiCmsRevisionFlags.Deleted : 0),
          JSON.stringify(revision.tree_json ?? {}),
          `Restored from revision #${input.revisionId}`,
          input.revisionId,
          input.createdByUserId ?? null,
        ],
      );
      newRevisionId = rows[0]!.id;
      await client.query(
        `UPDATE phis.site_page_scopes
         SET working_draft_revision_id = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [scope.scopeId, newRevisionId],
      );
    } else if (scope.kind === "navigation") {
      const revision = await getNavigationRevisionByIdWithDb(client, input.revisionId);
      if (!revision || revision.nav_scope_id !== scope.scopeId) {
        throw new SiteRevisionNotFoundError("Navigation revision not found for the requested scope.");
      }

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO phis.site_nav_revisions (
           nav_scope_id,
           flags,
           next_node_sequence,
           tree_json,
           message,
           source_revision_id,
           created_by_user_id
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         RETURNING id`,
        [
          scope.scopeId,
          PhiCmsRevisionFlags.Draft,
          Number(revision.next_node_sequence),
          JSON.stringify(revision.tree_json ?? {}),
          `Restored from revision #${input.revisionId}`,
          input.revisionId,
          input.createdByUserId ?? null,
        ],
      );
      newRevisionId = rows[0]!.id;
      await client.query(
        `UPDATE phis.site_nav_scopes
         SET working_draft_revision_id = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [scope.scopeId, newRevisionId],
      );
    } else {
      const revision = await getSiteThemeRevisionByIdWithDb(client, input.revisionId);
      if (!revision || revision.themeScopeId !== scope.scopeId) {
        throw new SiteRevisionNotFoundError("Theme revision not found for the requested scope.");
      }

      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO phis.site_theme_revisions (
           theme_scope_id,
           flags,
           tree_json,
           message,
           source_revision_id,
           created_by_user_id
         )
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING id`,
        [
          scope.scopeId,
          PhiCmsRevisionFlags.Draft,
          JSON.stringify(revision.treeJson ?? {}),
          `Restored from revision #${input.revisionId}`,
          input.revisionId,
          input.createdByUserId ?? null,
        ],
      );
      newRevisionId = rows[0]!.id;
      await client.query(
        `UPDATE phis.site_theme_scopes
         SET working_draft_revision_id = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [scope.scopeId, newRevisionId],
      );
    }

    await client.query("COMMIT");
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: newRevisionId,
      }),
      restoredFromRevisionId: input.revisionId,
      revisionId: newRevisionId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSiteRevisionHistoryEntry(
  siteId: number,
  input: SiteRevisionScopeInput & {
    revisionId: number;
  },
): Promise<{ scope: SiteRevisionScopeSummary; revisionId: number; deleted: boolean }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  if (!Number.isInteger(input.revisionId) || input.revisionId <= 0) {
    throw new Error("revisionId must be a positive integer.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await resolveRevisionScopeWithDb(client, siteId, input);
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }
    if (scope.publishedRevisionId === input.revisionId || scope.workingDraftRevisionId === input.revisionId) {
      throw new SiteRevisionConflictError("Active published or draft revisions cannot be deleted.");
    }

    let deleted = false;
    if (scope.kind === "area") {
      const result = await client.query<{ tree_json: Record<string, unknown> }>(
        `DELETE FROM phis.site_area_revisions
         WHERE id = $1
           AND area_scope_id = $2
         RETURNING tree_json`,
        [input.revisionId, scope.scopeId],
      );
      deleted = (result.rowCount ?? 0) > 0;
      await deleteOrphanedSiteContentByIdsWithDb(
        client,
        siteId,
        collectRevisionContentIds(result.rows[0]?.tree_json ?? null),
      );
    } else if (scope.kind === "page") {
      const result = await client.query<{ tree_json: Record<string, unknown> }>(
        `DELETE FROM phis.site_page_revisions
         WHERE id = $1
           AND page_scope_id = $2
         RETURNING tree_json`,
        [input.revisionId, scope.scopeId],
      );
      deleted = (result.rowCount ?? 0) > 0;
      await deleteOrphanedSiteContentByIdsWithDb(
        client,
        siteId,
        collectRevisionContentIds(result.rows[0]?.tree_json ?? null),
      );
      if (deleted) {
        await cleanupEmptyPageScopeWithDb(client, scope.scopeId);
      }
    } else if (scope.kind === "navigation") {
      const result = await client.query(
        `DELETE FROM phis.site_nav_revisions
         WHERE id = $1
           AND nav_scope_id = $2`,
        [input.revisionId, scope.scopeId],
      );
      deleted = (result.rowCount ?? 0) > 0;
    } else {
      const result = await client.query(
        `DELETE FROM phis.site_theme_revisions
         WHERE id = $1
           AND theme_scope_id = $2`,
        [input.revisionId, scope.scopeId],
      );
      deleted = (result.rowCount ?? 0) > 0;
    }

    if (!deleted) {
      throw new SiteRevisionNotFoundError("Revision not found for the requested scope.");
    }

    await client.query("COMMIT");
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: scope.workingDraftRevisionId,
      }),
      revisionId: input.revisionId,
      deleted: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSiteRevisionHistoryEntries(
  siteId: number,
  input: SiteRevisionScopeInput & {
    revisionIds: number[];
  },
): Promise<{ scope: SiteRevisionScopeSummary; revisionIds: number[]; deletedCount: number }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  if (!Array.isArray(input.revisionIds) || input.revisionIds.length === 0) {
    throw new Error("revisionIds must be a non-empty array.");
  }

  const normalizedRevisionIds = [...new Set(input.revisionIds)].filter((value) =>
    Number.isInteger(value) && value > 0,
  );
  if (normalizedRevisionIds.length === 0) {
    throw new Error("revisionIds must be a non-empty array.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await resolveRevisionScopeWithDb(client, siteId, input);
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }

    if (
      normalizedRevisionIds.some(
        (revisionId) => scope.publishedRevisionId === revisionId || scope.workingDraftRevisionId === revisionId,
      )
    ) {
      throw new SiteRevisionConflictError("Active published or draft revisions cannot be deleted.");
    }

    let deletedCount = 0;
    if (scope.kind === "area") {
      const result = await client.query<{ tree_json: Record<string, unknown> }>(
        `DELETE FROM phis.site_area_revisions
         WHERE id = ANY($1::int[])
           AND area_scope_id = $2
         RETURNING tree_json`,
        [normalizedRevisionIds, scope.scopeId],
      );
      deletedCount = result.rowCount ?? 0;
      await deleteOrphanedSiteContentByIdsWithDb(
        client,
        siteId,
        result.rows.flatMap((row) => collectRevisionContentIds(row.tree_json)),
      );
    } else if (scope.kind === "page") {
      const result = await client.query<{ tree_json: Record<string, unknown> }>(
        `DELETE FROM phis.site_page_revisions
         WHERE id = ANY($1::int[])
           AND page_scope_id = $2
         RETURNING tree_json`,
        [normalizedRevisionIds, scope.scopeId],
      );
      deletedCount = result.rowCount ?? 0;
      await deleteOrphanedSiteContentByIdsWithDb(
        client,
        siteId,
        result.rows.flatMap((row) => collectRevisionContentIds(row.tree_json)),
      );
      if (deletedCount > 0) {
        await cleanupEmptyPageScopeWithDb(client, scope.scopeId);
      }
    } else if (scope.kind === "navigation") {
      const result = await client.query(
        `DELETE FROM phis.site_nav_revisions
         WHERE id = ANY($1::int[])
           AND nav_scope_id = $2`,
        [normalizedRevisionIds, scope.scopeId],
      );
      deletedCount = result.rowCount ?? 0;
    } else {
      const result = await client.query(
        `DELETE FROM phis.site_theme_revisions
         WHERE id = ANY($1::int[])
           AND theme_scope_id = $2`,
        [normalizedRevisionIds, scope.scopeId],
      );
      deletedCount = result.rowCount ?? 0;
    }

    if (deletedCount !== normalizedRevisionIds.length) {
      throw new SiteRevisionNotFoundError("One or more revisions were not found for the requested scope.");
    }

    await client.query("COMMIT");
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: scope.workingDraftRevisionId,
      }),
      revisionIds: normalizedRevisionIds,
      deletedCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function isSiteRevisionConflictError(error: unknown) {
  return error instanceof SiteRevisionConflictError;
}

export function isSiteRevisionNotFoundError(error: unknown) {
  return error instanceof SiteRevisionNotFoundError;
}

export function buildSiteNavigationScopeKeyFromArea(areaMask: number, navKey: string) {
  return `${resolvePhiServerCmsAreaKey(areaMask)}:${normalizeNavigationKeyPart(navKey)}`;
}
