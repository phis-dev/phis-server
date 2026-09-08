import "server-only";

import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { PhiCmsRevisionFlags } from "@phis/contracts/cms";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import {
  collectSiteCmsReferences,
  PhiCmsReferenceSourceKind,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import {
  readPhiCmsInstanceId,
  readPhiCmsInstanceIdDescriptor,
  type PhiCmsInstanceId,
  type PhiCmsInstanceOrigin,
} from "@/lib/cms/instance-id";
import { readPhiPageReference } from "@/lib/internal-references";
import { listSitePageScopes } from "@/db/site-pages";

type DbQueryable = Pick<PoolClient, "query">;

export type SiteNavigationItemPlacement = {
  parentId: PhiCmsInstanceId | null;
  index: number;
};

export type SiteNavigationItemOverride = {
  id: PhiCmsInstanceId;
  label?: string;
  icon?: string | null;
  placement?: SiteNavigationItemPlacement;
};

export type SiteNavigationCustomItem = {
  id: PhiCmsInstanceId;
  kind: "link" | "container" | "separator";
  label: string;
  icon?: string | null;
  target?:
    | { kind: "page"; reference: string; resolvedPath?: string | null; deleted?: boolean }
    | { kind: "external"; href: string };
  newTab?: boolean;
  placement: SiteNavigationItemPlacement;
};

export type SiteNavigationOverlay = {
  navKey: string;
  label?: string;
  itemOverrides: SiteNavigationItemOverride[];
  customItems: SiteNavigationCustomItem[];
  tombstones: PhiCmsInstanceId[];
};

export async function projectSiteNavigationOverlayTargets(
  siteId: number,
  overlay: SiteNavigationOverlay,
): Promise<SiteNavigationOverlay> {
  const areaKey = overlay.navKey.slice(0, overlay.navKey.indexOf(":"));
  if (!isPhisCmsAreaKey(areaKey)) return overlay;
  const scopes = await listSitePageScopes(siteId, resolvePhisCmsAreaMask(areaKey));
  const scopesById = new Map(scopes.map((scope) => [scope.id, scope] as const));
  return {
    ...overlay,
    customItems: overlay.customItems.map((item) => {
      if (item.target?.kind !== "page") return item;
      const reference = readPhiPageReference(item.target.reference);
      if (!reference || reference.target.kind !== "site") return item;
      const scope = scopesById.get(reference.target.pageScopeId);
      const deleted = !scope || scope.tombstonedAt != null || !scope.path;
      return {
        ...item,
        target: {
          ...item.target,
          resolvedPath: deleted ? null : scope.path,
          deleted,
        },
      };
    }),
  };
}

export type SiteNavigationScopeRecord = {
  id: number;
  siteId: number;
  key: string;
  label: string | null;
  flags: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SiteNavigationRevisionRecord = {
  id: number;
  navScopeId: number;
  flags: number;
  nextNodeSequence: number;
  treeJson: Record<string, unknown>;
  message: string | null;
  metaJson: Record<string, unknown>;
  sourceRevisionId: number | null;
  createdByUserId: number | null;
  createdAt: string;
};

function normalizeSiteNavigationKey(value: string) {
  return value.trim().toLowerCase();
}

function requireSiteNavigationScopeKey(value: string) {
  const normalized = normalizeSiteNavigationKey(value);
  const separatorIndex = normalized.indexOf(":");
  const localKey = normalized.slice(separatorIndex + 1);
  if (
    separatorIndex <= 0 ||
    separatorIndex >= normalized.length - 1 ||
    normalized.indexOf(":", separatorIndex + 1) !== -1 ||
    normalized.length > 64 ||
    !isPhisCmsAreaKey(normalized.slice(0, separatorIndex)) ||
    !/^[a-z0-9](?:[a-z0-9/_-]*[a-z0-9])?$/.test(localKey)
  ) {
    throw new Error("Navigation key must be formatted as area:key.");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function readNavigationInstanceId(
  value: unknown,
  label: string,
  origin?: PhiCmsInstanceOrigin,
) {
  const id = readPhiCmsInstanceId(value);
  const descriptor = readPhiCmsInstanceIdDescriptor(id);
  if (!id || !descriptor || descriptor.domain !== "navigation" || (origin && descriptor.origin !== origin)) {
    throw new Error(
      `${label} must be a canonical ${origin ? `${origin}-origin ` : ""}Navigation PhiCmsInstanceId.`,
    );
  }
  return id;
}

function readBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}

function readNextNodeSequence(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0x1_0000_0000) {
    throw new Error("Navigation nextNodeSequence must be an integer from 1 through 4294967296.");
  }
  return value as number;
}

function readNavigationHref(value: unknown, label: string) {
  const href = readRequiredString(value, label);
  if (
    !href.startsWith("/") &&
    !href.startsWith("#") &&
    !href.startsWith("https://") &&
    !href.startsWith("http://") &&
    !href.startsWith("mailto:") &&
    !href.startsWith("tel:")
  ) {
    throw new Error(`${label} must be an internal path or an approved external URL.`);
  }
  return href;
}

function normalizeSiteNavigationTarget(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.kind === "page") {
    const parsed = readPhiPageReference(value.reference);
    if (!parsed) throw new Error(`${label} requires a valid opaque Page reference.`);
    return { kind: "page" as const, reference: parsed.reference };
  }
  if (value.kind === "external") {
    const href = readNavigationHref(value.href, `${label} href`);
    if (href.startsWith("/") || href.startsWith("#")) {
      throw new Error(`${label} external href must not be a local path.`);
    }
    return { kind: "external" as const, href };
  }
  throw new Error(`${label} has an invalid kind.`);
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

function normalizeSiteNavigationPlacement(value: unknown): SiteNavigationItemPlacement {
  if (!isRecord(value)) {
    throw new Error("Navigation item placement must be an object.");
  }
  const parentId = value.parentId === null
    ? null
    : readNavigationInstanceId(value.parentId, "Navigation parent id");
  const index = value.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error("Navigation item placement index must be a non-negative integer.");
  }
  return { parentId, index };
}

function normalizeSiteNavigationItemOverride(value: unknown): SiteNavigationItemOverride {
  if (!isRecord(value)) {
    throw new Error("Navigation item override must be an object.");
  }
  const id = readNavigationInstanceId(value.id, "Navigation item id", "preset");
  const hasLabel = Object.hasOwn(value, "label");
  const hasIcon = Object.hasOwn(value, "icon");
  const hasPlacement = Object.hasOwn(value, "placement");
  if (!hasLabel && !hasIcon && !hasPlacement) {
    throw new Error(`Navigation item override "${id}" is empty.`);
  }
  const label = hasLabel ? readRequiredString(value.label, `Navigation item "${id}" label`) : undefined;
  const icon = hasIcon
    ? value.icon === null
      ? null
      : readRequiredString(value.icon, `Navigation item "${id}" icon`)
    : undefined;
  const placement = hasPlacement ? normalizeSiteNavigationPlacement(value.placement) : undefined;
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(hasIcon ? { icon } : {}),
    ...(placement ? { placement } : {}),
  };
}

function normalizeSiteNavigationCustomItem(value: unknown): SiteNavigationCustomItem {
  if (!isRecord(value)) {
    throw new Error("Navigation custom item must be an object.");
  }
  const id = readNavigationInstanceId(value.id, "Navigation custom item id", "draft");
  const kind = value.kind === "link" || value.kind === "container" || value.kind === "separator"
    ? value.kind
    : null;
  if (!kind) {
    throw new Error(`Navigation custom item "${id}" has an invalid kind.`);
  }
  const label = kind === "separator"
    ? typeof value.label === "string" ? value.label.trim() : ""
    : readRequiredString(value.label, `Navigation custom item "${id}" label`);
  const target = kind === "link"
    ? normalizeSiteNavigationTarget(value.target, `Navigation custom item "${id}" target`)
    : undefined;
  if (kind !== "link" && Object.hasOwn(value, "target")) {
    throw new Error(`Navigation custom item "${id}" permits a target only for links.`);
  }
  const icon = Object.hasOwn(value, "icon")
    ? value.icon === null
      ? null
      : readRequiredString(value.icon, `Navigation custom item "${id}" icon`)
    : undefined;
  const newTab = Object.hasOwn(value, "newTab")
    ? readBoolean(value.newTab, `Navigation custom item "${id}" newTab`)
    : undefined;
  if (kind !== "link" && newTab !== undefined) {
    throw new Error(`Navigation custom item "${id}" permits link flags only for links.`);
  }
  return {
    id,
    kind,
    label,
    ...(icon !== undefined ? { icon } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(newTab !== undefined ? { newTab } : {}),
    placement: normalizeSiteNavigationPlacement(value.placement),
  };
}

function normalizeSiteNavigationOverlay(value: unknown, expectedNavKey: string): SiteNavigationOverlay {
  if (!isRecord(value)) {
    throw new Error("Navigation overlay must be an object.");
  }
  const navKey = requireSiteNavigationScopeKey(readRequiredString(value.navKey, "Navigation navKey"));
  if (navKey !== expectedNavKey) {
    throw new Error("Navigation overlay navKey does not match its scope.");
  }
  const label = value.label == null
    ? undefined
    : readRequiredString(value.label, "Navigation label");
  if (!Array.isArray(value.itemOverrides) || !Array.isArray(value.customItems) || !Array.isArray(value.tombstones)) {
    throw new Error("Navigation overlay requires itemOverrides, customItems, and tombstones arrays.");
  }
  const itemOverrides = value.itemOverrides.map(normalizeSiteNavigationItemOverride);
  const customItems = value.customItems.map(normalizeSiteNavigationCustomItem);
  const overrideKeys = new Set<PhiCmsInstanceId>();
  for (const override of itemOverrides) {
    if (overrideKeys.has(override.id)) {
      throw new Error(`Duplicate navigation override "${override.id}".`);
    }
    overrideKeys.add(override.id);
  }
  const tombstones = value.tombstones.map((entry) =>
    readNavigationInstanceId(entry, "Navigation tombstone item id", "preset"),
  );
  if (new Set(tombstones).size !== tombstones.length) {
    throw new Error("Navigation tombstones must be unique.");
  }
  const customIds = customItems.map((item) => item.id);
  if (new Set(customIds).size !== customIds.length) {
    throw new Error("Navigation custom item keys must be unique.");
  }
  if (customIds.some((id) => overrideKeys.has(id) || tombstones.includes(id))) {
    throw new Error("Navigation custom items must not also be overridden or tombstoned.");
  }
  return {
    navKey,
    ...(label ? { label } : {}),
    itemOverrides: itemOverrides.sort((left, right) => left.id.localeCompare(right.id)),
    customItems: customItems.sort((left, right) => left.id.localeCompare(right.id)),
    tombstones: tombstones.sort((left, right) => left.localeCompare(right)),
  };
}

function parseSiteNavigationOverlay(value: unknown, expectedNavKey: string) {
  return normalizeSiteNavigationOverlay(value, expectedNavKey);
}

async function validateNavigationDraftIdsWithDb(
  db: DbQueryable,
  navScopeId: number,
  overlay: SiteNavigationOverlay,
  nextNodeSequence: number,
) {
  const revisionIds = new Set<number>();
  for (const item of overlay.customItems) {
    const descriptor = readPhiCmsInstanceIdDescriptor(item.id);
    if (!descriptor || descriptor.origin !== "draft" || descriptor.domain !== "navigation") {
      throw new Error(`Navigation custom item "${item.id}" has an invalid CMS identity.`);
    }
    if (descriptor.sequence >= nextNodeSequence) {
      throw new Error(
        `Navigation custom item "${item.id}" sequence must be below nextNodeSequence ${nextNodeSequence}.`,
      );
    }
    revisionIds.add(descriptor.draftRevisionId);
  }
  if (revisionIds.size === 0) return;
  const ids = [...revisionIds];
  const { rows } = await db.query<{ id: number }>(
    `SELECT id
     FROM phis.site_nav_revisions
     WHERE nav_scope_id = $1 AND id = ANY($2::int[])`,
    [navScopeId, ids],
  );
  const owned = new Set(rows.map((row) => row.id));
  const foreignId = ids.find((id) => !owned.has(id));
  if (foreignId !== undefined) {
    throw new Error(`Navigation custom item references Draft revision ${foreignId} outside its scope.`);
  }
}

function buildNavigationRevisionSummary(
  overlay: SiteNavigationOverlay,
  source: unknown,
  sourceRevisionId: number | null,
) {
  const changed = source == null || stableJsonStringify(source) !== stableJsonStringify(overlay);
  const suffix = sourceRevisionId != null ? ` from revision #${sourceRevisionId}` : "";
  return {
    message: changed ? `Navigation: overlay changed${suffix}` : `Navigation: saved draft${suffix}`,
    metaJson: {
      messageKey: changed ? "navigation_overlay_changed" : "navigation_saved",
      sourceRevisionId,
      origin: sourceRevisionId == null ? "new" : "revision",
      changeKinds: changed ? ["navigation_overlay"] : [],
      navigation: {
        overrideCount: overlay.itemOverrides.length,
        customItemCount: overlay.customItems.length,
        tombstoneCount: overlay.tombstones.length,
      },
    },
  };
}

function mapSiteNavigationScopeRow(row: {
  id: number;
  site_id: number;
  key: string;
  label: string | null;
  flags: number;
  published_revision_id: number | null;
  working_draft_revision_id: number | null;
}): SiteNavigationScopeRecord {
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

function mapSiteNavigationRevisionRow(row: {
  id: number;
  nav_scope_id: number;
  flags: number;
  next_node_sequence: string | number;
  tree_json: Record<string, unknown>;
  message: string | null;
  meta_json: Record<string, unknown> | null;
  source_revision_id: number | null;
  created_by_user_id: number | null;
  created_at: string;
}): SiteNavigationRevisionRecord {
  return {
    id: row.id,
    navScopeId: row.nav_scope_id,
    flags: row.flags,
    nextNodeSequence: Number(row.next_node_sequence),
    treeJson: row.tree_json,
    message: row.message,
    metaJson: toJsonRecord(row.meta_json),
    sourceRevisionId: row.source_revision_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

async function getSiteNavigationScopeByKeyWithDb(
  db: DbQueryable,
  siteId: number,
  key: string,
) {
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, site_id, key, label, flags, published_revision_id, working_draft_revision_id
     FROM phis.site_nav_scopes
     WHERE site_id = $1 AND key = $2
     LIMIT 1`,
    [siteId, key],
  );
  return rows[0] ? mapSiteNavigationScopeRow(rows[0]) : null;
}

export async function listSiteNavigationScopes(siteId: number, area?: string | null) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return [];
  }
  const normalizedArea = area?.trim().toLowerCase() ?? "";
  if (normalizedArea && !isPhisCmsAreaKey(normalizedArea)) {
    throw new Error("Invalid navigation Area.");
  }
  const { rows } = await getPool().query<{
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, site_id, key, label, flags, published_revision_id, working_draft_revision_id
     FROM phis.site_nav_scopes
     WHERE site_id = $1
       AND ($2::text = '' OR key LIKE $2::text || ':%')
     ORDER BY key`,
    [siteId, normalizedArea],
  );
  return rows.map(mapSiteNavigationScopeRow);
}

async function upsertSiteNavigationScopeWithDb(
  db: DbQueryable,
  siteId: number,
  input: { key: string; label?: string | null },
) {
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    key: string;
    label: string | null;
    flags: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `INSERT INTO phis.site_nav_scopes (site_id, key, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key)
     DO UPDATE SET label = COALESCE(EXCLUDED.label, phis.site_nav_scopes.label)
     RETURNING id, site_id, key, label, flags, published_revision_id, working_draft_revision_id`,
    [siteId, input.key, input.label ?? null],
  );
  return mapSiteNavigationScopeRow(rows[0]!);
}

async function insertSiteNavigationRevisionWithDb(
  db: DbQueryable,
  input: {
    navScopeId: number;
    flags: number;
    nextNodeSequence: number;
    treeJson: Record<string, unknown>;
    message?: string | null;
    metaJson?: Record<string, unknown> | null;
    sourceRevisionId?: number | null;
    createdByUserId?: number | null;
  },
) {
  const { rows } = await db.query<{
    id: number;
    nav_scope_id: number;
    flags: number;
    next_node_sequence: string | number;
    tree_json: Record<string, unknown>;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_at: string;
  }>(
    `INSERT INTO phis.site_nav_revisions
       (nav_scope_id, flags, next_node_sequence, tree_json, message, meta_json, source_revision_id, created_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8)
     RETURNING id, nav_scope_id, flags, next_node_sequence, tree_json, message, meta_json,
               source_revision_id, created_by_user_id, created_at`,
    [
      input.navScopeId,
      input.flags,
      input.nextNodeSequence,
      JSON.stringify(input.treeJson),
      input.message ?? null,
      JSON.stringify(input.metaJson ?? {}),
      input.sourceRevisionId ?? null,
      input.createdByUserId ?? null,
    ],
  );
  return mapSiteNavigationRevisionRow(rows[0]!);
}

async function getSiteNavigationRevisionByIdWithDb(db: DbQueryable, revisionId: number) {
  const { rows } = await db.query<{
    id: number;
    nav_scope_id: number;
    flags: number;
    next_node_sequence: string | number;
    tree_json: Record<string, unknown>;
    message: string | null;
    meta_json: Record<string, unknown> | null;
    source_revision_id: number | null;
    created_by_user_id: number | null;
    created_at: string;
  }>(
    `SELECT id, nav_scope_id, flags, next_node_sequence, tree_json, message, meta_json,
            source_revision_id, created_by_user_id, created_at
     FROM phis.site_nav_revisions
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  );
  return rows[0] ? mapSiteNavigationRevisionRow(rows[0]) : null;
}

async function updateSiteNavigationScopePointersWithDb(
  db: DbQueryable,
  scopeId: number,
  input: { publishedRevisionId: number | null; workingDraftRevisionId: number | null },
) {
  await db.query(
    `UPDATE phis.site_nav_scopes
     SET published_revision_id = $2, working_draft_revision_id = $3, updated_at = now()
     WHERE id = $1`,
    [scopeId, input.publishedRevisionId, input.workingDraftRevisionId],
  );
}

export async function getPublishedSiteNavigationRevision(siteId: number, key: string) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }
  const normalizedKey = requireSiteNavigationScopeKey(key);
  const scope = await getSiteNavigationScopeByKeyWithDb(getPool(), siteId, normalizedKey);
  if (!scope?.publishedRevisionId) {
    return null;
  }
  const revision = await getSiteNavigationRevisionByIdWithDb(getPool(), scope.publishedRevisionId);
  if (!revision || (revision.flags & PhiCmsRevisionFlags.Published) === 0) {
    return null;
  }
  return {
    revisionId: revision.id,
    nextNodeSequence: revision.nextNodeSequence,
    overlay: parseSiteNavigationOverlay(revision.treeJson, normalizedKey),
  };
}

export async function getPublishedSiteNavigationOverlay(siteId: number, key: string) {
  return (await getPublishedSiteNavigationRevision(siteId, key))?.overlay ?? null;
}

export async function getSiteNavigationOverlayRevisionById(
  siteId: number,
  key: string,
  revisionId: number,
) {
  if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(revisionId) || revisionId <= 0) {
    return null;
  }
  const normalizedKey = requireSiteNavigationScopeKey(key);
  const scope = await getSiteNavigationScopeByKeyWithDb(getPool(), siteId, normalizedKey);
  if (!scope) {
    return null;
  }
  const revision = await getSiteNavigationRevisionByIdWithDb(getPool(), revisionId);
  if (!revision || revision.navScopeId !== scope.id) {
    return null;
  }
  return parseSiteNavigationOverlay(revision.treeJson, normalizedKey);
}

export async function getSiteCurrentNavigationDraft(siteId: number, input: { key: string }) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return null;
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const scope = await getSiteNavigationScopeByKeyWithDb(getPool(), siteId, normalizedKey);
  if (!scope?.workingDraftRevisionId) {
    return null;
  }
  const revision = await getSiteNavigationRevisionByIdWithDb(getPool(), scope.workingDraftRevisionId);
  if (!revision) {
    return null;
  }
  return {
    revisionId: revision.id,
    nextNodeSequence: revision.nextNodeSequence,
    overlay: parseSiteNavigationOverlay(revision.treeJson, normalizedKey),
  };
}

export async function saveSiteNavigationDraftRevision(
  siteId: number,
  input: { key: string; overlay: unknown; nextNodeSequence: unknown },
  options?: { createdByUserId?: number | null },
) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const overlay = normalizeSiteNavigationOverlay(input.overlay, normalizedKey);
  const nextNodeSequence = readNextNodeSequence(input.nextNodeSequence);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await upsertSiteNavigationScopeWithDb(client, siteId, {
      key: normalizedKey,
      label: overlay.label ?? normalizedKey.slice(normalizedKey.indexOf(":") + 1),
    });
    const sourceRevisionId = scope.workingDraftRevisionId ?? scope.publishedRevisionId ?? null;
    const sourceRevision = sourceRevisionId == null
      ? null
      : await getSiteNavigationRevisionByIdWithDb(client, sourceRevisionId);
    if (sourceRevision && nextNodeSequence < sourceRevision.nextNodeSequence) {
      throw new Error(
        `Navigation nextNodeSequence must not move backwards from ${sourceRevision.nextNodeSequence} ` +
        `to ${nextNodeSequence}.`,
      );
    }
    await validateNavigationDraftIdsWithDb(client, scope.id, overlay, nextNodeSequence);
    const summary = buildNavigationRevisionSummary(
      overlay,
      sourceRevision?.treeJson ?? null,
      sourceRevisionId,
    );
    const revision = await insertSiteNavigationRevisionWithDb(client, {
      navScopeId: scope.id,
      flags: PhiCmsRevisionFlags.Draft,
      nextNodeSequence,
      treeJson: overlay,
      message: summary.message,
      metaJson: summary.metaJson,
      sourceRevisionId,
      createdByUserId: options?.createdByUserId ?? null,
    });
    await updateSiteNavigationScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: revision.id,
    });
    const areaKey = normalizedKey.slice(0, normalizedKey.indexOf(":"));
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Navigation,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(overlay, {
        targetAreaId: resolvePhisCmsAreaMask(areaKey),
      }),
    });
    await client.query("COMMIT");
    return { revisionId: revision.id, nextNodeSequence: revision.nextNodeSequence, overlay };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function publishSiteNavigationRevision(
  siteId: number,
  input: { key: string; revisionId?: number | null },
) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await getSiteNavigationScopeByKeyWithDb(client, siteId, normalizedKey);
    if (!scope) {
      throw new Error("Navigation scope not found.");
    }
    const revisionId = input.revisionId ?? scope.workingDraftRevisionId;
    if (typeof revisionId !== "number" || !Number.isInteger(revisionId) || revisionId <= 0) {
      throw new Error("No navigation draft revision selected for publish.");
    }
    const revision = await getSiteNavigationRevisionByIdWithDb(client, revisionId);
    if (!revision || revision.navScopeId !== scope.id) {
      throw new Error("Navigation draft revision not found.");
    }
    const overlay = parseSiteNavigationOverlay(revision.treeJson, normalizedKey);
    if ((revision.flags & PhiCmsRevisionFlags.Published) === 0) {
      await client.query(
        `UPDATE phis.site_nav_revisions SET flags = flags | $2 WHERE id = $1`,
        [revision.id, PhiCmsRevisionFlags.Published],
      );
    }
    await updateSiteNavigationScopePointersWithDb(client, scope.id, {
      publishedRevisionId: revision.id,
      workingDraftRevisionId: null,
    });
    await client.query("COMMIT");
    return { revisionId: revision.id, nextNodeSequence: revision.nextNodeSequence, overlay };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSiteNavigationDraftRevision(
  siteId: number,
  input: { key: string },
): Promise<{ deleted: boolean }> {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const scope = await getSiteNavigationScopeByKeyWithDb(client, siteId, normalizedKey);
    if (!scope?.workingDraftRevisionId) {
      await client.query("COMMIT");
      return { deleted: false };
    }
    await client.query(`DELETE FROM phis.site_nav_revisions WHERE id = $1`, [scope.workingDraftRevisionId]);
    if (scope.publishedRevisionId == null) {
      await client.query(`DELETE FROM phis.site_nav_scopes WHERE id = $1`, [scope.id]);
    } else {
      await updateSiteNavigationScopePointersWithDb(client, scope.id, {
        publishedRevisionId: scope.publishedRevisionId,
        workingDraftRevisionId: null,
      });
    }
    await client.query("COMMIT");
    return { deleted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
