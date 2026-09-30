import "server-only";

import type { PoolClient } from "pg";

import {
  collectRevisionContentIds,
  deleteOrphanedSiteContentByIdsWithDb,
} from "@/db/site-content";
import { getPool, withTransaction } from "@/lib/db";
import { hasPhiFlag } from "@/lib/helpers/flags";
import { isPhisCmsAreaKey, resolvePhisCmsAreaKey } from "@/lib/constants/cms-areas";
import { PhiCmsRevisionFlags } from "@phis/contracts/cms";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import { normalizeSiteThemeScopeKey } from "@/db/site-theme";
import {
  deleteSiteRevisionsWithDb,
  getSiteKeyedScopeWithDb,
  getSiteRevisionByIdWithDb,
  insertSiteRevisionWithDb,
  pruneSiteRevisionScopeReferencesWithDb,
  setSiteRevisionScopePointersWithDb,
  SITE_REVISION_TABLES,
  type SiteRevisionKind,
  type SiteRevisionTable,
} from "@/db/site-revision-scopes";

type DbQueryable = Pick<PoolClient, "query">;

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
  /**
   * The Area's second Working Draft -- its Module selection, saved apart from its structure. Null for
   * every other scope kind, which has only ever had one draft to begin with.
   */
  workingModuleDraftRevisionId: number | null;
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
    !isPhisCmsAreaKey(normalized.slice(0, separatorIndex))
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
    workingModuleDraftRevisionId?: number | null;
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
      workingModuleDraftRevisionId: null,
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
      workingModuleDraftRevisionId: null,
    };
  }

  const area = resolvePhisCmsAreaKey(input.areaMask);
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
    // Only an "area" scope ever has one: a Page has no Modules of its own to select.
    workingModuleDraftRevisionId: input.kind === "area" ? pointers.workingModuleDraftRevisionId ?? null : null,
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
    workingModuleDraftRevisionId?: number | null;
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
      // An Area keeps two Working Drafts open at once -- structure and Modules -- so a row is a
      // Working Draft if it is either one, not only the first.
      isWorkingDraft:
        scope.workingDraftRevisionId === row.id || scope.workingModuleDraftRevisionId === row.id,
      isDeleted: hasPhiFlag(row.flags, PhiCmsRevisionFlags.Deleted),
      sourcePreset,
    };
  });
}

async function listRevisionRowsWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
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
     FROM phis.${table.revisionTable} revision
     LEFT JOIN phis.user_account_directory account
       ON account.id = revision.created_by_user_id
     LEFT JOIN phis.user_profiles profile
       ON profile.user_id = revision.created_by_user_id
     WHERE revision.${table.scopeColumn} = $1
     ORDER BY revision.created_at DESC, revision.id DESC`,
    [scopeId],
  );

  return rows;
}

async function getAreaScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  forUpdate = false,
): Promise<{
  id: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
  workingModuleDraftRevisionId: number | null;
} | null> {
  const { rows } = await db.query<{
    id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
    working_module_draft_revision_id: number | null;
  }>(
    `SELECT id, published_revision_id, working_draft_revision_id, working_module_draft_revision_id
     FROM phis.site_area_scopes
     WHERE site_id = $1
       AND area_id = $2
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [siteId, areaMask],
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        publishedRevisionId: row.published_revision_id,
        workingDraftRevisionId: row.working_draft_revision_id,
        workingModuleDraftRevisionId: row.working_module_draft_revision_id,
      }
    : null;
}

async function getPageScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SiteRevisionPageAddress,
  forUpdate = false,
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
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
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

export type ResolvedRevisionScope =
  | {
      kind: "area";
      areaMask: number;
      sourcePreset: SiteRevisionPresetIdentity;
      scopeId: number | null;
      publishedRevisionId: number | null;
      workingDraftRevisionId: number | null;
      workingModuleDraftRevisionId: number | null;
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

/**
 * `forUpdate` holds the scope row for the rest of the transaction. Restore and history delete decide on
 * its pointers -- which revisions are live, which one the new Draft replaces -- and a publish or save
 * moving them in between would leave a pointer on a revision this transaction deletes.
 */
async function resolveRevisionScopeWithDb(
  db: DbQueryable,
  siteId: number,
  input: SiteRevisionScopeInput,
  options?: { forUpdate?: boolean },
): Promise<ResolvedRevisionScope> {
  const forUpdate = options?.forUpdate ?? false;
  if (input.kind === "area") {
    const scope = await getAreaScopeWithDb(db, siteId, input.areaMask, forUpdate);
    return {
      kind: "area",
      areaMask: input.areaMask,
      sourcePreset: input.sourcePreset,
      scopeId: scope?.id ?? null,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
      workingModuleDraftRevisionId: scope?.workingModuleDraftRevisionId ?? null,
    };
  }

  if (input.kind === "page") {
    const address = input.address.kind === "path"
      ? { kind: "path" as const, path: normalizeSiteCmsPath(input.address.path) }
      : input.address;
    const scope = await getPageScopeWithDb(db, siteId, input.areaMask, address, forUpdate);
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
    const scope = await getSiteKeyedScopeWithDb(db, SITE_REVISION_TABLES.theme, siteId, normalizedKey, {
      forUpdate,
    });
    return {
      kind: "theme",
      key: normalizedKey,
      scopeId: scope?.id ?? null,
      publishedRevisionId: scope?.publishedRevisionId ?? null,
      workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
    };
  }

  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const scope = await getSiteKeyedScopeWithDb(
    db,
    SITE_REVISION_TABLES.navigation,
    siteId,
    normalizedKey,
    { forUpdate },
  );
  return {
    kind: "navigation",
    key: normalizedKey,
    scopeId: scope?.id ?? null,
    publishedRevisionId: scope?.publishedRevisionId ?? null,
    workingDraftRevisionId: scope?.workingDraftRevisionId ?? null,
  };
}

/**
 * The Draft metadata a restored revision starts with.
 *
 * Without it the new Working Draft carried `meta_json = '{}'`, and the next save refused it for lacking
 * canonical Draft metadata -- a restore that left the Draft unusable. The version and the node sequence
 * are taken above everything the scope has used: the version so an editor still holding the old Draft
 * is told it changed, the sequence so a node created now cannot take an instance id one of the scope's
 * revisions already carries.
 */
async function readRestoredDraftMetaWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
  scopeId: number,
) {
  const { rows } = await db.query<{ version: string | null; next_node_sequence: string | null }>(
    `SELECT MAX(CASE WHEN jsonb_typeof(meta_json->'draft'->'version') = 'number'
                     THEN (meta_json->'draft'->>'version')::bigint END)::text AS version,
            MAX(CASE WHEN jsonb_typeof(meta_json->'draft'->'nextNodeSequence') = 'number'
                     THEN (meta_json->'draft'->>'nextNodeSequence')::bigint END)::text
              AS next_node_sequence
     FROM phis.${table.revisionTable}
     WHERE ${table.scopeColumn} = $1`,
    [scopeId],
  );
  return {
    version: Number(rows[0]?.version ?? 0) + 1,
    nextNodeSequence: Math.max(1, Number(rows[0]?.next_node_sequence ?? 1)),
  };
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

class SiteRevisionConflictError extends Error {}
class SiteRevisionNotFoundError extends Error {}

/**
 * Deletes history entries of a scope and answers how many went. A removed Area or Page revision may
 * have been the last to use some Content, which is swept with it; a Page scope left with no revision
 * at all goes too.
 */
async function deleteScopeRevisionsWithDb(
  db: DbQueryable,
  siteId: number,
  scope: { kind: SiteRevisionKind; scopeId: number },
  revisionIds: readonly number[],
) {
  const table = SITE_REVISION_TABLES[scope.kind];
  const removed = await deleteSiteRevisionsWithDb(db, table, scope.scopeId, revisionIds);
  if (table.carriesContent) {
    await deleteOrphanedSiteContentByIdsWithDb(
      db,
      siteId,
      removed.trees.flatMap((tree) => collectRevisionContentIds(tree)),
    );
  }
  if (scope.kind === "page" && removed.deletedCount > 0) {
    await cleanupEmptyPageScopeWithDb(db, scope.scopeId);
  }
  return removed.deletedCount;
}

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
    workingModuleDraftRevisionId: scope.kind === "area" ? scope.workingModuleDraftRevisionId : null,
  });

  if (!scope.scopeId) {
    return {
      scope: scopeSummary,
      rows: [],
    };
  }

  const rows = await listRevisionRowsWithDb(db, SITE_REVISION_TABLES[scope.kind], scope.scopeId);
  return {
    scope: scopeSummary,
    rows: mapRevisionRows(rows, scope),
  };
}


/**
 * Whether a pointer of the scope still names this revision. An Area has a third one, its Module draft:
 * deleting that revision from history left the pointer hanging, and every Module save after it threw.
 */
export function isLiveScopeRevision(scope: ResolvedRevisionScope, revisionId: number) {
  return (
    scope.publishedRevisionId === revisionId ||
    scope.workingDraftRevisionId === revisionId ||
    (scope.kind === "area" && scope.workingModuleDraftRevisionId === revisionId)
  );
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

  return withTransaction(async (client) => {
    const scope = await resolveRevisionScopeWithDb(client, siteId, input, { forUpdate: true });
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }

    const table = SITE_REVISION_TABLES[scope.kind];
    const revision = await getSiteRevisionByIdWithDb(client, table, input.revisionId);
    if (!revision || revision.scopeId !== scope.scopeId) {
      throw new SiteRevisionNotFoundError(`${table.label} revision not found for the requested scope.`);
    }

    // Pages and Areas keep their Draft metadata in the revision; Navigations and Themes start empty.
    const keepsDraftMeta = scope.kind === "area" || scope.kind === "page";
    const restored = await insertSiteRevisionWithDb(client, table, {
      scopeId: scope.scopeId,
      // A restored Page deletion stays a deletion: the Draft says what publishing it will do.
      flags: PhiCmsRevisionFlags.Draft |
        (scope.kind === "page" && hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Deleted)
          ? PhiCmsRevisionFlags.Deleted
          : 0),
      nextNodeSequence: revision.nextNodeSequence,
      treeJson: revision.treeJson,
      message: `Restored from revision #${input.revisionId}`,
      metaJson: keepsDraftMeta
        ? {
            ...revision.metaJson,
            draft: await readRestoredDraftMetaWithDb(client, table, scope.scopeId),
          }
        : null,
      sourceRevisionId: input.revisionId,
      createdByUserId: input.createdByUserId ?? null,
    });
    const newRevisionId = restored.id;
    // The scope row is held, so the published pointer written back is the one read above.
    await setSiteRevisionScopePointersWithDb(client, table, scope.scopeId, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: newRevisionId,
    });
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: newRevisionId,
      }),
      restoredFromRevisionId: input.revisionId,
      revisionId: newRevisionId,
    };
  });
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

  return withTransaction(async (client) => {
    const scope = await resolveRevisionScopeWithDb(client, siteId, input, { forUpdate: true });
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }
    if (isLiveScopeRevision(scope, input.revisionId)) {
      throw new SiteRevisionConflictError("Active published or draft revisions cannot be deleted.");
    }

    const deleted = (await deleteScopeRevisionsWithDb(
      client,
      siteId,
      { kind: scope.kind, scopeId: scope.scopeId },
      [input.revisionId],
    )) > 0;
    if (!deleted) {
      throw new SiteRevisionNotFoundError("Revision not found for the requested scope.");
    }

    await pruneSiteRevisionScopeReferencesWithDb(
      client,
      SITE_REVISION_TABLES[scope.kind],
      scope.scopeId,
    );
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: scope.workingDraftRevisionId,
      }),
      revisionId: input.revisionId,
      deleted: true,
    };
  });
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

  return withTransaction(async (client) => {
    const scope = await resolveRevisionScopeWithDb(client, siteId, input, { forUpdate: true });
    if (!scope.scopeId) {
      throw new SiteRevisionNotFoundError("Revision scope not found.");
    }

    if (normalizedRevisionIds.some((revisionId) => isLiveScopeRevision(scope, revisionId))) {
      throw new SiteRevisionConflictError("Active published or draft revisions cannot be deleted.");
    }

    const deletedCount = await deleteScopeRevisionsWithDb(
      client,
      siteId,
      { kind: scope.kind, scopeId: scope.scopeId },
      normalizedRevisionIds,
    );
    if (deletedCount !== normalizedRevisionIds.length) {
      throw new SiteRevisionNotFoundError("One or more revisions were not found for the requested scope.");
    }

    await pruneSiteRevisionScopeReferencesWithDb(
      client,
      SITE_REVISION_TABLES[scope.kind],
      scope.scopeId,
    );
    return {
      scope: buildScopeSummary(input, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: scope.workingDraftRevisionId,
      }),
      revisionIds: normalizedRevisionIds,
      deletedCount,
    };
  });
}

export function isSiteRevisionConflictError(error: unknown) {
  return error instanceof SiteRevisionConflictError;
}

export function isSiteRevisionNotFoundError(error: unknown) {
  return error instanceof SiteRevisionNotFoundError;
}

export function buildSiteNavigationScopeKeyFromArea(areaMask: number, navKey: string) {
  return `${resolvePhisCmsAreaKey(areaMask)}:${normalizeNavigationKeyPart(navKey)}`;
}
