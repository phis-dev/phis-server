import "server-only";

import type { PoolClient } from "pg";

import {
  PhiCmsReferenceSourceKind,
  collectSiteCmsReferences,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import { clearSiteConfigCache } from "@/db/site-config";
import { getPool } from "@/lib/db";
import { PhiCmsRevisionFlags } from "@phis/contracts/cms";

type DbQueryable = Pick<PoolClient, "query">;

export const SITE_THEME_DEFAULT_SCOPE_KEY = "default";

export type SiteThemeRevisionTree = {
  key: string;
  label: string | null;
  theme: Record<string, unknown>;
};

export type SiteThemeScopeRecord = {
  id: number;
  siteId: number;
  key: string;
  label: string | null;
  flags: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SiteThemeRevisionRecord = {
  id: number;
  themeScopeId: number;
  flags: number;
  treeJson: Record<string, unknown>;
  message: string | null;
  metaJson: Record<string, unknown>;
  sourceRevisionId: number | null;
  createdByUserId: number | null;
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toJsonRecord(value: unknown) {
  return isRecord(value) ? value : {};
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function countRecordLeaves(value: unknown): number {
  if (!isRecord(value)) {
    return 0;
  }

  return Object.values(value).reduce<number>(
    (count, entry) => count + (isRecord(entry) ? countRecordLeaves(entry) : 1),
    0,
  );
}

function buildThemeRevisionSummary(
  input: SiteThemeRevisionTree,
  source: SiteThemeRevisionTree | null,
  sourceRevisionId: number | null,
) {
  const preset = readString(input.theme.preset) ?? "custom";
  const presetVersion = typeof input.theme.presetVersion === "number" ? input.theme.presetVersion : null;
  // What the Site owns beyond the blocks it follows: its palette, its style tokens, its component overrides.
  const customOverrideCount = countRecordLeaves(toJsonRecord(input.theme.palette))
    + countRecordLeaves(toJsonRecord(input.theme.style))
    + countRecordLeaves(toJsonRecord(input.theme.components));
  const changed = stableJsonStringify(source?.theme ?? {}) !== stableJsonStringify(input.theme);
  const suffix = sourceRevisionId != null ? ` from revision #${sourceRevisionId}` : "";
  const versionLabel = presetVersion != null ? ` v${presetVersion}` : "";

  return {
    message: changed
      ? `Theme: based on ${preset}${versionLabel}, ${customOverrideCount} custom overrides${suffix}`
      : `Theme: saved draft${suffix}`,
    metaJson: {
      messageKey: changed ? "theme_changed" : "theme_saved",
      sourceRevisionId,
      origin: sourceRevisionId == null ? "new" : "revision",
      changeKinds: changed ? ["theme"] : [],
      theme: {
        preset,
        presetVersion,
        customOverrideCount,
        isCustom: customOverrideCount > 0,
      },
    },
  };
}

export function normalizeSiteThemeScopeKey(value?: string | null) {
  const normalized = (value ?? SITE_THEME_DEFAULT_SCOPE_KEY).trim().toLowerCase();
  if (!normalized || normalized.includes(":")) {
    throw new Error("Theme key must be provided without area prefix.");
  }

  return normalized;
}

function normalizeSiteThemeWriteValue(value: unknown) {
  if (!isRecord(value)) {
    throw new Error("theme must be an object.");
  }

  return value;
}

function parseSiteThemeRevisionTree(value: unknown, fallbackKey: string): SiteThemeRevisionTree {
  const record = toJsonRecord(value);
  const key = normalizeSiteThemeScopeKey(readString(record.key) ?? fallbackKey);
  return {
    key,
    label: readString(record.label),
    theme: toJsonRecord(record.theme),
  };
}

function mapSiteThemeScopeRow(
  row: {
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  },
): SiteThemeScopeRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    label: row.label,
    flags: row.flags,
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
  };
}

function mapSiteThemeRevisionRow(
  row: {
    id: number;
    theme_scope_id: number;
    flags: number;
    tree_json: Record<string, unknown>;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_at: string;
  },
): SiteThemeRevisionRecord {
  return {
    id: row.id,
    themeScopeId: row.theme_scope_id,
    flags: row.flags,
    treeJson: row.tree_json,
    message: row.message,
    metaJson: toJsonRecord(row.meta_json),
    sourceRevisionId: row.source_revision_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function getSiteThemeScopeByKeyWithDb(
  db: DbQueryable,
  siteId: number,
  key: string,
): Promise<SiteThemeScopeRecord | null> {
  const normalizedKey = normalizeSiteThemeScopeKey(key);
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id,
            site_id,
            key,
            label,
            flags,
            published_revision_id,
            working_draft_revision_id
     FROM phis.site_theme_scopes
     WHERE site_id = $1
       AND key = $2
     LIMIT 1`,
    [siteId, normalizedKey],
  );

  return rows[0] ? mapSiteThemeScopeRow(rows[0]) : null;
}

export async function getSiteThemeScope(
  siteId: number,
  input?: { key?: string | null },
): Promise<SiteThemeScopeRecord | null> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);
  return getSiteThemeScopeByKeyWithDb(getPool(), siteId, normalizedKey);
}

async function upsertSiteThemeScopeWithDb(
  db: DbQueryable,
  siteId: number,
  input: {
    key: string;
    label?: string | null;
  },
): Promise<SiteThemeScopeRecord> {
  const normalizedKey = normalizeSiteThemeScopeKey(input.key);
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `INSERT INTO phis.site_theme_scopes (
       site_id,
       key,
       label
     )
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key)
     DO UPDATE SET label = COALESCE(EXCLUDED.label, phis.site_theme_scopes.label)
     RETURNING id,
               site_id,
               key,
               label,
               flags,
               published_revision_id,
               working_draft_revision_id`,
    [siteId, normalizedKey, input.label ?? null],
  );

  return mapSiteThemeScopeRow(rows[0]!);
}

async function insertSiteThemeRevisionWithDb(
  db: DbQueryable,
  input: {
    themeScopeId: number;
    flags: number;
    treeJson: Record<string, unknown>;
    message?: string | null;
    metaJson?: Record<string, unknown> | null;
    sourceRevisionId?: number | null;
    createdByUserId?: number | null;
  },
): Promise<SiteThemeRevisionRecord> {
  const { rows } = await db.query<{
    id: number;
    theme_scope_id: number;
    flags: number;
    tree_json: Record<string, unknown>;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_at: string;
  }>(
    `INSERT INTO phis.site_theme_revisions (
       theme_scope_id,
       flags,
       tree_json,
       message,
       meta_json,
       source_revision_id,
       created_by_user_id
     )
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)
     RETURNING id,
               theme_scope_id,
               flags,
               tree_json,
               message,
               meta_json,
               source_revision_id,
               created_by_user_id,
               created_at`,
    [
      input.themeScopeId,
      input.flags,
      JSON.stringify(input.treeJson),
      input.message ?? null,
      JSON.stringify(input.metaJson ?? {}),
      input.sourceRevisionId ?? null,
      input.createdByUserId ?? null,
    ],
  );

  return mapSiteThemeRevisionRow(rows[0]!);
}

export async function getSiteThemeRevisionByIdWithDb(
  db: DbQueryable,
  revisionId: number,
): Promise<SiteThemeRevisionRecord | null> {
  const { rows } = await db.query<{
    id: number;
    theme_scope_id: number;
    flags: number;
    tree_json: Record<string, unknown>;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_at: string;
  }>(
    `SELECT id,
            theme_scope_id,
            flags,
            tree_json,
            message,
            meta_json,
            source_revision_id,
            created_by_user_id,
            created_at
     FROM phis.site_theme_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  );

  return rows[0] ? mapSiteThemeRevisionRow(rows[0]) : null;
}

async function updateSiteThemeScopePointersWithDb(
  db: DbQueryable,
  scopeId: number,
  input: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
  },
) {
  await db.query(
    `UPDATE phis.site_theme_scopes
     SET published_revision_id = $2,
         working_draft_revision_id = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [scopeId, input.publishedRevisionId, input.workingDraftRevisionId],
  );
}

export async function getSiteCurrentThemeDraft(
  siteId: number,
  input?: { key?: string | null },
): Promise<{ revisionId: number; theme: SiteThemeRevisionTree } | null> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);
  const scope = await getSiteThemeScopeByKeyWithDb(getPool(), siteId, normalizedKey);
  if (!scope?.workingDraftRevisionId) {
    return null;
  }

  const revision = await getSiteThemeRevisionByIdWithDb(getPool(), scope.workingDraftRevisionId);
  if (!revision) {
    return null;
  }

  return {
    revisionId: revision.id,
    theme: parseSiteThemeRevisionTree(revision.treeJson, normalizedKey),
  };
}

export async function getSiteThemeRevisionReview(
  siteId: number,
  revisionId: number,
  input?: { key?: string | null },
): Promise<{ revisionId: number; theme: SiteThemeRevisionTree } | null> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);
  const scope = await getSiteThemeScopeByKeyWithDb(getPool(), siteId, normalizedKey);
  if (!scope) {
    return null;
  }

  const revision = await getSiteThemeRevisionByIdWithDb(getPool(), revisionId);
  if (!revision || revision.themeScopeId !== scope.id) {
    return null;
  }

  return {
    revisionId: revision.id,
    theme: parseSiteThemeRevisionTree(revision.treeJson, normalizedKey),
  };
}

export async function saveSiteThemeDraftRevision(
  siteId: number,
  input: {
    key?: string | null;
    label?: string | null;
    theme: unknown;
    message?: string | null;
  },
  options?: {
    createdByUserId?: number | null;
  },
): Promise<{ revisionId: number; theme: SiteThemeRevisionTree }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input.key);
  const theme = normalizeSiteThemeWriteValue(input.theme);
  const tree: SiteThemeRevisionTree = {
    key: normalizedKey,
    label: readString(input.label),
    theme,
  };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const scope = await upsertSiteThemeScopeWithDb(client, siteId, {
      key: normalizedKey,
      label: tree.label ?? normalizedKey,
    });
    const sourceRevisionId = scope.workingDraftRevisionId ?? scope.publishedRevisionId ?? null;
    const sourceRevision = sourceRevisionId == null ? null : await getSiteThemeRevisionByIdWithDb(client, sourceRevisionId);
    const sourceTree = sourceRevision ? parseSiteThemeRevisionTree(sourceRevision.treeJson, normalizedKey) : null;
    const summary = buildThemeRevisionSummary(tree, sourceTree, sourceRevisionId);
    const revision = await insertSiteThemeRevisionWithDb(client, {
      themeScopeId: scope.id,
      flags: PhiCmsRevisionFlags.Draft,
      treeJson: tree,
      message: readString(input.message) ?? summary.message,
      metaJson: summary.metaJson,
      sourceRevisionId,
      createdByUserId: options?.createdByUserId ?? null,
    });

    await updateSiteThemeScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: revision.id,
    });
    /*
     * A Theme carries pictures like any other authored tree: a ground somebody edited was uploaded on
     * the way here and is an Asset of this Site from that moment, and the brand logo names one too.
     * Without this the delete guard read the Theme as referencing nothing, and the picture the Site is
     * built around was the one picture nothing protected. Inside the same transaction as the revision,
     * so a rolled-back save leaves no reference behind.
     */
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Theme,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(tree),
    });

    await client.query("COMMIT");
    return {
      revisionId: revision.id,
      theme: tree,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function publishSiteThemeRevision(
  siteId: number,
  input?: {
    key?: string | null;
    revisionId?: number | null;
  },
): Promise<{ revisionId: number; theme: SiteThemeRevisionTree }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const scope = await getSiteThemeScopeByKeyWithDb(client, siteId, normalizedKey);
    if (!scope) {
      throw new Error("Theme scope not found.");
    }

    const revisionId = input?.revisionId ?? scope.workingDraftRevisionId;
    if (typeof revisionId !== "number" || !Number.isInteger(revisionId) || revisionId <= 0) {
      throw new Error("No theme draft revision selected for publish.");
    }

    const revision = await getSiteThemeRevisionByIdWithDb(client, revisionId);
    if (!revision || revision.themeScopeId !== scope.id) {
      throw new Error("Theme draft revision not found.");
    }

    const tree = parseSiteThemeRevisionTree(revision.treeJson, normalizedKey);
    if ((revision.flags & PhiCmsRevisionFlags.Published) === 0) {
      await client.query(
        `UPDATE phis.site_theme_revisions
         SET flags = flags | $2
         WHERE id = $1`,
        [revision.id, PhiCmsRevisionFlags.Published],
      );
    }

    await updateSiteThemeScopePointersWithDb(client, scope.id, {
      publishedRevisionId: revision.id,
      workingDraftRevisionId: null,
    });
    /*
     * Rewritten rather than left standing, because this publish does not have to be the draft's own.
     * A caller may name an older revision, and the draft pointer is cleared either way: whichever
     * revision becomes the published one, its references are the Scope's whole set afterwards.
     */
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Theme,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(tree),
    });

    await client.query(
      `UPDATE phis.sites
       SET theme = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [siteId, JSON.stringify(tree.theme)],
    );

    await client.query("COMMIT");
    clearSiteConfigCache(siteId);
    return {
      revisionId: revision.id,
      theme: tree,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSiteThemeDraftRevision(
  siteId: number,
  input?: { key?: string | null },
): Promise<{ deleted: boolean }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const scope = await getSiteThemeScopeByKeyWithDb(client, siteId, normalizedKey);
    if (!scope?.workingDraftRevisionId) {
      await client.query("COMMIT");
      return { deleted: false };
    }

    await client.query(
      `DELETE FROM phis.site_theme_revisions
       WHERE id = $1
         AND theme_scope_id = $2`,
      [scope.workingDraftRevisionId, scope.id],
    );
    await updateSiteThemeScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: null,
    });

    await client.query("COMMIT");
    return { deleted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
