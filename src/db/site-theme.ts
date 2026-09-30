import "server-only";

import { collectSiteCmsReferences } from "@/db/site-cms-references";
import { clearSiteConfigCache } from "@/db/site-config";
import {
  discardSiteKeyedDraftRevisionWithDb,
  getSiteKeyedScopeWithDb,
  getSiteRevisionByIdWithDb,
  publishSiteKeyedRevisionWithDb,
  saveSiteKeyedDraftRevisionWithDb,
  selectSiteKeyedRevisionForPublishWithDb,
  SITE_REVISION_TABLES,
  stableJsonStringify,
  type SiteKeyedScopeRecord,
} from "@/db/site-revision-scopes";
import { getPool, withTransaction } from "@/lib/db";
import { isPhiRecord, toPhiRecord } from "@/lib/helpers/record";

const THEME = SITE_REVISION_TABLES.theme;

export const SITE_THEME_DEFAULT_SCOPE_KEY = "default";

export type SiteThemeRevisionTree = {
  key: string;
  label: string | null;
  theme: Record<string, unknown>;
};

export type SiteThemeScopeRecord = SiteKeyedScopeRecord;

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function countRecordLeaves(value: unknown): number {
  if (!isPhiRecord(value)) {
    return 0;
  }

  return Object.values(value).reduce<number>(
    (count, entry) => count + (isPhiRecord(entry) ? countRecordLeaves(entry) : 1),
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
  const customOverrideCount = countRecordLeaves(toPhiRecord(input.theme.palette))
    + countRecordLeaves(toPhiRecord(input.theme.style))
    + countRecordLeaves(toPhiRecord(input.theme.components));
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
  if (!isPhiRecord(value)) {
    throw new Error("theme must be an object.");
  }

  return value;
}

function parseSiteThemeRevisionTree(value: unknown, fallbackKey: string): SiteThemeRevisionTree {
  const record = toPhiRecord(value);
  const key = normalizeSiteThemeScopeKey(readString(record.key) ?? fallbackKey);
  return {
    key,
    label: readString(record.label),
    theme: toPhiRecord(record.theme),
  };
}

export async function getSiteThemeScope(
  siteId: number,
  input?: { key?: string | null },
): Promise<SiteThemeScopeRecord | null> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  return getSiteKeyedScopeWithDb(getPool(), THEME, siteId, normalizeSiteThemeScopeKey(input?.key));
}

export async function getSiteCurrentThemeDraft(
  siteId: number,
  input?: { key?: string | null },
): Promise<{ revisionId: number; theme: SiteThemeRevisionTree } | null> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);
  const scope = await getSiteKeyedScopeWithDb(getPool(), THEME, siteId, normalizedKey);
  if (!scope?.workingDraftRevisionId) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(getPool(), THEME, scope.workingDraftRevisionId);
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
  const scope = await getSiteKeyedScopeWithDb(getPool(), THEME, siteId, normalizedKey);
  if (!scope) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(getPool(), THEME, revisionId);
  if (!revision || revision.scopeId !== scope.id) {
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

  return withTransaction(async (client) => {
    const { revision } = await saveSiteKeyedDraftRevisionWithDb(client, THEME, siteId, {
      key: normalizedKey,
      label: tree.label ?? normalizedKey,
      treeJson: tree,
      /*
       * A Theme carries pictures like any other authored tree: a ground somebody edited was uploaded on
       * the way here and is an Asset of this Site from that moment, and the brand logo names one too.
       * Without this the delete guard read the Theme as referencing nothing, and the picture the Site is
       * built around was the one picture nothing protected.
       */
      references: collectSiteCmsReferences(tree),
      createdByUserId: options?.createdByUserId ?? null,
      prepare: (source) => {
        const sourceTree = source.revision
          ? parseSiteThemeRevisionTree(source.revision.treeJson, normalizedKey)
          : null;
        const summary = buildThemeRevisionSummary(tree, sourceTree, source.revisionId);
        return { message: readString(input.message) ?? summary.message, metaJson: summary.metaJson };
      },
    });

    return {
      revisionId: revision.id,
      theme: tree,
    };
  });
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

  const published = await withTransaction(async (client) => {
    /*
     * As with Pages, Areas and Navigations: publishing clears the Working Draft, so it publishes that
     * Draft only, or the published revision again while no Draft is open. The Draft's references were
     * indexed when it was saved and stay the scope's set once it is the published revision.
     */
    const { scope, revision } = await selectSiteKeyedRevisionForPublishWithDb(client, THEME, siteId, {
      key: normalizedKey,
      revisionId: input?.revisionId,
    });
    const tree = parseSiteThemeRevisionTree(revision.treeJson, normalizedKey);
    await publishSiteKeyedRevisionWithDb(client, THEME, scope, revision);

    await client.query(
      `UPDATE phis.sites
       SET theme = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [siteId, JSON.stringify(tree.theme)],
    );

    return {
      revisionId: revision.id,
      theme: tree,
    };
  });
  clearSiteConfigCache(siteId);
  return published;
}

export async function deleteSiteThemeDraftRevision(
  siteId: number,
  input?: { key?: string | null },
): Promise<{ deleted: boolean }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }

  const normalizedKey = normalizeSiteThemeScopeKey(input?.key);

  return withTransaction((client) =>
    discardSiteKeyedDraftRevisionWithDb(client, THEME, siteId, { key: normalizedKey }),
  );
}
