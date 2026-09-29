import "server-only";

import type { PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db";
import { PhiCmsRevisionFlags } from "@phis/contracts/cms";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import {
  collectSiteCmsReferences,
  PhiCmsReferenceSourceKind,
  pruneSiteCmsReferencesToLiveRevisionsWithDb,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import {
  readPhiCmsInstanceId,
  readPhiCmsInstanceIdDescriptor,
  type PhiCmsInstanceId,
  type PhiCmsInstanceOrigin,
} from "@/lib/cms/instance-id";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import { readPhiPageReference } from "@/lib/internal-references";
import { listSitePageScopes, SiteCmsDraftConflictError } from "@/db/site-pages";
import { isPhiRecord } from "@/lib/helpers/record";

type DbQueryable = Pick<PoolClient, "query">;

export type SiteNavigationItemPlacement = {
  parentId: PhiCmsInstanceId | null;
  index: number;
};

/**
 * What a folder address leads to: a Page, by its reference, so a renamed Page needs nothing here, or a
 * sub-folder, by its address, whose own target the lookup follows on. It names the target rather than a
 * child of this Navigation, so the same folder in another Navigation can take it over unchanged.
 */
export type SiteNavigationFolderTarget =
  | { kind: "page"; reference: string }
  | { kind: "folder"; address: string };

/**
 * Where a container leads when its folder address is requested (REFERENCES.md, "Folder addresses"). The
 * Builder resolves `address` when the Draft is saved -- the folder its direct children share, package
 * namespace included -- and writes a `target` that one of those children stands for. Whether it still
 * does is decided when the address is looked up.
 */
export type SiteNavigationFolder = {
  /** Null when the container's direct children share no folder. */
  address: string | null;
  /**
   * Null when the address leads nowhere, which answers 404. A container keeps its address even then, so a
   * target chosen for the same folder in another Navigation can be carried over to it.
   */
  target: SiteNavigationFolderTarget | null;
};

export type SiteNavigationFolderCarry = {
  key: string;
  revisionId: number;
  nextNodeSequence: number;
  folders: { address: string; target: SiteNavigationFolderTarget | null }[];
};

export type SiteNavigationItemOverride = {
  id: PhiCmsInstanceId;
  label?: string;
  icon?: string | null;
  placement?: SiteNavigationItemPlacement;
  /** Only meaningful on a Module container; the overlay cannot tell a Module item's kind. */
  folder?: SiteNavigationFolder;
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
  /** Containers only. */
  folder?: SiteNavigationFolder;
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
  if (!isPhiRecord(value)) throw new Error(`${label} must be an object.`);
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
  return isPhiRecord(value) ? value : {};
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (isPhiRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeSiteNavigationPlacement(value: unknown): SiteNavigationItemPlacement {
  if (!isPhiRecord(value)) {
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

function readSiteNavigationFolderAddress(value: unknown, label: string) {
  const address = readRequiredString(value, label);
  // The Area root is a slot with its own route setting, never a folder address.
  if (!address.startsWith("/") || address === "/" || normalizeSiteCmsPath(address) !== address) {
    throw new Error(`${label} must be a canonical path below the Area root.`);
  }
  return address;
}

function normalizeSiteNavigationFolderTarget(value: unknown, label: string): SiteNavigationFolderTarget {
  if (!isPhiRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (value.kind === "page") {
    const parsed = readPhiPageReference(value.reference);
    if (!parsed) {
      throw new Error(`${label} reference must be a Page reference.`);
    }
    return { kind: "page", reference: parsed.reference };
  }
  if (value.kind === "folder") {
    return { kind: "folder", address: readSiteNavigationFolderAddress(value.address, `${label} address`) };
  }
  throw new Error(`${label} must lead to a page or a folder.`);
}

function normalizeSiteNavigationFolder(value: unknown, label: string): SiteNavigationFolder {
  if (!isPhiRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const target = value.target === null ? null : normalizeSiteNavigationFolderTarget(value.target, `${label} target`);
  const address = value.address === null ? null : readSiteNavigationFolderAddress(value.address, `${label} address`);
  if (address == null && target == null) {
    throw new Error(`${label} carries neither an address nor a target.`);
  }
  if (target?.kind === "folder" && address != null && !target.address.startsWith(`${address}/`)) {
    throw new Error(`${label} target must lie beneath its address.`);
  }
  return { address, target };
}

function encodeSiteNavigationFolderTarget(target: SiteNavigationFolderTarget | null) {
  if (target == null) return "";
  return target.kind === "page" ? `page:${target.reference}` : `folder:${target.address}`;
}

/**
 * The target each folder address of a Navigation leads to. One address has one target: a Navigation that
 * holds the same folder twice with two targets is refused, because a request can be answered only once.
 */
function collectSiteNavigationFolderTargets(overlay: SiteNavigationOverlay) {
  const targets = new Map<string, SiteNavigationFolderTarget | null>();
  for (const folder of [...overlay.customItems, ...overlay.itemOverrides].map((item) => item.folder)) {
    if (!folder?.address) continue;
    const known = targets.get(folder.address);
    if (targets.has(folder.address) && encodeSiteNavigationFolderTarget(known ?? null) !== encodeSiteNavigationFolderTarget(folder.target)) {
      throw new Error(`Navigation "${overlay.navKey}" leads the folder "${folder.address}" to two targets.`);
    }
    targets.set(folder.address, folder.target);
  }
  return targets;
}

/** The overlay with the given folder targets applied, and the addresses that actually changed. */
function applySiteNavigationFolderTargets(
  overlay: SiteNavigationOverlay,
  targets: ReadonlyMap<string, SiteNavigationFolderTarget | null>,
) {
  const changed = new Set<string>();
  const apply = <TItem extends { folder?: SiteNavigationFolder }>(item: TItem): TItem => {
    const address = item.folder?.address;
    if (!address || !targets.has(address)) return item;
    const target = targets.get(address) ?? null;
    if (encodeSiteNavigationFolderTarget(item.folder!.target) === encodeSiteNavigationFolderTarget(target)) return item;
    changed.add(address);
    return { ...item, folder: { address, target } };
  };
  return {
    overlay: {
      ...overlay,
      itemOverrides: overlay.itemOverrides.map(apply),
      customItems: overlay.customItems.map(apply),
    },
    changed,
  };
}

function normalizeSiteNavigationItemOverride(value: unknown): SiteNavigationItemOverride {
  if (!isPhiRecord(value)) {
    throw new Error("Navigation item override must be an object.");
  }
  const id = readNavigationInstanceId(value.id, "Navigation item id", "preset");
  const hasLabel = Object.hasOwn(value, "label");
  const hasIcon = Object.hasOwn(value, "icon");
  const hasPlacement = Object.hasOwn(value, "placement");
  const hasFolder = Object.hasOwn(value, "folder");
  if (!hasLabel && !hasIcon && !hasPlacement && !hasFolder) {
    throw new Error(`Navigation item override "${id}" is empty.`);
  }
  const label = hasLabel ? readRequiredString(value.label, `Navigation item "${id}" label`) : undefined;
  const icon = hasIcon
    ? value.icon === null
      ? null
      : readRequiredString(value.icon, `Navigation item "${id}" icon`)
    : undefined;
  const placement = hasPlacement ? normalizeSiteNavigationPlacement(value.placement) : undefined;
  const folder = hasFolder ? normalizeSiteNavigationFolder(value.folder, `Navigation item "${id}" folder`) : undefined;
  return {
    id,
    ...(label !== undefined ? { label } : {}),
    ...(hasIcon ? { icon } : {}),
    ...(placement ? { placement } : {}),
    ...(folder ? { folder } : {}),
  };
}

function normalizeSiteNavigationCustomItem(value: unknown): SiteNavigationCustomItem {
  if (!isPhiRecord(value)) {
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
  if (kind !== "container" && Object.hasOwn(value, "folder")) {
    throw new Error(`Navigation custom item "${id}" permits a folder only for containers.`);
  }
  const folder = Object.hasOwn(value, "folder")
    ? normalizeSiteNavigationFolder(value.folder, `Navigation custom item "${id}" folder`)
    : undefined;
  return {
    id,
    kind,
    label,
    ...(icon !== undefined ? { icon } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(newTab !== undefined ? { newTab } : {}),
    placement: normalizeSiteNavigationPlacement(value.placement),
    ...(folder ? { folder } : {}),
  };
}

function normalizeSiteNavigationOverlay(value: unknown, expectedNavKey: string): SiteNavigationOverlay {
  if (!isPhiRecord(value)) {
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

export function parseSiteNavigationOverlay(value: unknown, expectedNavKey: string) {
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
  options?: { forUpdate?: boolean },
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
     LIMIT 1${options?.forUpdate ? "\n     FOR UPDATE" : ""}`,
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
  await pruneSiteCmsReferencesToLiveRevisionsWithDb(db, {
    sourceKind: PhiCmsReferenceSourceKind.Navigation,
    sourceScopeId: scopeId,
  });
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

/**
 * Carries the folder targets a save changed into every other Navigation of the Area that holds the same
 * folder (REFERENCES.md, "Folder addresses": one address, one target). Only targets this save changed travel:
 * a Navigation saved from an older state, with nobody touching its targets, must not carry those back.
 * Each Navigation that takes one gets a new Draft revision on top of its current one -- a Navigation with
 * only a published revision gets its first Draft -- and publishing stays each Navigation's own.
 */
async function carrySiteNavigationFolderTargetsWithDb(
  db: DbQueryable,
  siteId: number,
  input: {
    key: string;
    overlay: SiteNavigationOverlay;
    previousTreeJson: unknown;
    createdByUserId: number | null;
  },
): Promise<SiteNavigationFolderCarry[]> {
  const targets = collectSiteNavigationFolderTargets(input.overlay);
  let previous = new Map<string, SiteNavigationFolderTarget | null>();
  if (input.previousTreeJson != null) {
    try {
      previous = collectSiteNavigationFolderTargets(parseSiteNavigationOverlay(input.previousTreeJson, input.key));
    } catch {
      // A revision that no longer reads carries nothing to compare against: every target counts as changed.
    }
  }
  const changed = new Map([...targets].filter(([address, target]) =>
    encodeSiteNavigationFolderTarget(target) !== encodeSiteNavigationFolderTarget(previous.get(address) ?? null)));
  if (changed.size === 0) return [];

  const areaKey = input.key.slice(0, input.key.indexOf(":"));
  const { rows: siblings } = await db.query<{ key: string }>(
    `SELECT key FROM phis.site_nav_scopes
     WHERE site_id = $1 AND starts_with(key, $2::text || ':') AND key <> $3
     ORDER BY key
     FOR UPDATE`,
    [siteId, areaKey, input.key],
  );
  const carried: SiteNavigationFolderCarry[] = [];
  for (const { key } of siblings) {
    const scope = await getSiteNavigationScopeByKeyWithDb(db, siteId, key);
    const sourceRevisionId = scope?.workingDraftRevisionId ?? scope?.publishedRevisionId ?? null;
    const source = sourceRevisionId == null ? null : await getSiteNavigationRevisionByIdWithDb(db, sourceRevisionId);
    if (!scope || !source) continue;
    let sourceOverlay: SiteNavigationOverlay;
    try {
      sourceOverlay = parseSiteNavigationOverlay(source.treeJson, key);
    } catch {
      continue;
    }
    const next = applySiteNavigationFolderTargets(sourceOverlay, changed);
    if (next.changed.size === 0) continue;
    const revision = await insertSiteNavigationRevisionWithDb(db, {
      navScopeId: scope.id,
      flags: PhiCmsRevisionFlags.Draft,
      nextNodeSequence: source.nextNodeSequence,
      treeJson: next.overlay,
      message: `Navigation: folder target carried from ${input.key} onto revision #${source.id}`,
      metaJson: { messageKey: "navigation_folder_target_carried", sourceRevisionId: source.id, carriedFrom: input.key },
      sourceRevisionId: source.id,
      createdByUserId: input.createdByUserId,
    });
    await updateSiteNavigationScopePointersWithDb(db, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: revision.id,
    });
    await replaceSiteCmsReferencesWithDb(db, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Navigation,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(next.overlay, { targetAreaId: resolvePhisCmsAreaMask(areaKey) }),
    });
    carried.push({
      key,
      revisionId: revision.id,
      nextNodeSequence: revision.nextNodeSequence,
      folders: [...next.changed].map((address) => ({ address, target: changed.get(address) ?? null })),
    });
  }
  return carried;
}

/**
 * Where a folder address leads on the live Site (REFERENCES.md, "Folder addresses"), as the Page reference at
 * the end of its chain, or null for 404. It reads the published Navigations of the Area, the latest
 * publish deciding when two disagree, and follows a sub-folder target to that folder's own target. Every
 * step lies deeper than the one before, so the chain ends; the bound is only a guard. A Site Page must be
 * published, not tombstoned and in this Area; a Module Page's route is the Site's to check.
 */
export async function resolvePublishedSiteNavigationFolderTarget(
  siteId: number,
  area: string,
  address: string,
): Promise<{ reference: string } | null> {
  const areaKey = area.trim().toLowerCase();
  if (!Number.isInteger(siteId) || siteId <= 0 || !isPhisCmsAreaKey(areaKey)) {
    return null;
  }
  if (!address.startsWith("/") || address === "/" || normalizeSiteCmsPath(address) !== address) {
    return null;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ key: string; tree_json: unknown }>(
    `SELECT s.key, r.tree_json
     FROM phis.site_nav_scopes s
     JOIN phis.site_nav_revisions r ON r.id = s.published_revision_id
     WHERE s.site_id = $1 AND starts_with(s.key, $2::text || ':')
     ORDER BY r.created_at DESC, r.id DESC`,
    [siteId, areaKey],
  );
  const targets = new Map<string, SiteNavigationFolderTarget | null>();
  for (const row of rows) {
    let overlay: SiteNavigationOverlay;
    try {
      overlay = parseSiteNavigationOverlay(row.tree_json, row.key);
    } catch {
      continue;
    }
    for (const folder of [...overlay.customItems, ...overlay.itemOverrides].map((item) => item.folder)) {
      // Rows come newest first, so the first Navigation to name an address decides it.
      if (folder?.address && !targets.has(folder.address)) {
        targets.set(folder.address, folder.target);
      }
    }
  }

  let current = address;
  for (let depth = 0; depth < 32; depth += 1) {
    const target = targets.get(current);
    if (!target) return null;
    if (target.kind === "folder") {
      if (!target.address.startsWith(`${current}/`)) return null;
      current = target.address;
      continue;
    }
    const parsed = readPhiPageReference(target.reference);
    if (!parsed) return null;
    if (parsed.target.kind === "module") {
      return { reference: parsed.reference };
    }
    const { rows: pages } = await pool.query<{ id: number }>(
      `SELECT id FROM phis.site_page_scopes
       WHERE id = $1 AND site_id = $2 AND area_id = $3
         AND published_revision_id IS NOT NULL AND tombstoned_at IS NULL`,
      [parsed.target.pageScopeId, siteId, resolvePhisCmsAreaMask(areaKey)],
    );
    return pages[0] ? { reference: parsed.reference } : null;
  }
  return null;
}

export async function saveSiteNavigationDraftRevision(
  siteId: number,
  input: {
    key: string;
    overlay: unknown;
    nextNodeSequence: unknown;
    /**
     * The revision the saving editor's state came from. Folder targets are compared against it, so a
     * target another Navigation carried in after the editor loaded is not mistaken for this save's change.
     */
    baseRevisionId?: unknown;
  },
  options?: { createdByUserId?: number | null },
) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  const overlay = normalizeSiteNavigationOverlay(input.overlay, normalizedKey);
  const nextNodeSequence = readNextNodeSequence(input.nextNodeSequence);
  return withTransaction(async (client) => {
    /*
     * A save may carry folder targets into the other Navigations of its Area, so two saves in one Area
     * would each hold their own scope and wait for the other's. Saves of one Area take turns instead.
     */
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `phis.site_navigation:${siteId}:${normalizedKey.slice(0, normalizedKey.indexOf(":"))}`,
    ]);
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
    const baseRevision = Number.isInteger(input.baseRevisionId) && (input.baseRevisionId as number) > 0
      ? await getSiteNavigationRevisionByIdWithDb(client, input.baseRevisionId as number)
      : null;
    const carriedOver = await carrySiteNavigationFolderTargetsWithDb(client, siteId, {
      key: normalizedKey,
      overlay,
      previousTreeJson: baseRevision?.navScopeId === scope.id ? baseRevision.treeJson : sourceRevision?.treeJson ?? null,
      createdByUserId: options?.createdByUserId ?? null,
    });
    return { revisionId: revision.id, nextNodeSequence: revision.nextNodeSequence, overlay, carriedOver };
  });
}

export async function publishSiteNavigationRevision(
  siteId: number,
  input: { key: string; revisionId?: number | null },
) {
  if (!Number.isInteger(siteId) || siteId <= 0) {
    throw new Error("siteId must be a positive integer.");
  }
  const normalizedKey = requireSiteNavigationScopeKey(input.key);
  return withTransaction(async (client) => {
    const scope = await getSiteNavigationScopeByKeyWithDb(client, siteId, normalizedKey, {
      forUpdate: true,
    });
    if (!scope) {
      throw new Error("Navigation scope not found.");
    }
    // As with Pages and Areas: publishing clears the Working Draft, so it publishes that Draft only, or
    // the published revision again while no Draft is open.
    const republish =
      scope.workingDraftRevisionId == null && input.revisionId === scope.publishedRevisionId;
    if (input.revisionId != null && input.revisionId !== scope.workingDraftRevisionId && !republish) {
      throw new SiteCmsDraftConflictError(
        `Revision #${input.revisionId} is not the Navigation Working Draft; restore it to publish it.`,
      );
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
    return { revisionId: revision.id, nextNodeSequence: revision.nextNodeSequence, overlay };
  });
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
