import "server-only";

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  collectRevisionContentIds,
  deleteOrphanedSiteContentByIdsWithDb,
  getResolvedSiteContentByVersionIds,
  upsertSiteContentAssetWithClient,
  upsertSiteContentHtmlWithClient,
  upsertSiteContentMarkdownWithClient,
  upsertSiteContentTextWithClient,
  type SiteResolvedContentRecord,
} from "@/db/site-content";
import { getMediaAssetBySiteAndId } from "@/db/media";
import { listSiteModuleBlockUsageWithDb } from "@/db/site-module-usage";
import { materializeSiteMediaAvailabilityWithDb } from "@/db/media-spaces";
import { materializeSiteThreadKindsWithDb } from "@/db/threads";
import { materializeSiteModuleSeedsWithDb } from "@/db/module-seeds";
import {
  collectSiteCmsContentReferences,
  collectSiteCmsReferences,
  countSiteCmsReferencesToPageWithDb,
  PhiCmsReferenceSourceKind,
  replaceSiteCmsReferencesWithDb,
} from "@/db/site-cms-references";
import {
  assertPublishesWorkingDraft,
  deleteSiteRevisionsWithDb,
  getSiteRevisionByIdWithDb,
  insertSiteRevisionWithDb,
  pruneSiteRevisionScopeReferencesWithDb,
  setSiteRevisionScopePointersWithDb,
  SITE_REVISION_TABLES,
  SiteCmsAreaBaselineRequiredError,
  SiteCmsDraftConflictError,
  stableJsonStringify,
  updateSiteDraftRevisionWithDb,
  writePublishedSiteRevisionWithDb,
  type SiteRevisionRecord,
} from "@/db/site-revision-scopes";
import { getResolvedSiteMessageFields, type ResolvedSiteMessageField } from "@/db/translations";
import { getPool, withTransaction } from "@/lib/db";
import {
  PhiCmsFlags,
  PhiCmsRegionType,
  PhiCmsRevisionFlags,
  PhiCmsStatus,
} from "@phis/contracts/cms";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import { hasPhiFlag } from "@/lib/helpers/flags";
import type {
  CmsAreaModulesWriteInput,
  CmsAreaPresetWriteInput,
  CmsDraftContentBindingInput,
  CmsDraftWriteState,
  CmsPageWriteInput,
} from "@/lib/cms/write-validation";
import type { PhiCmsInstanceId } from "@/lib/cms/instance-id";
import {
  PHI_AREA_CONFIG_MODULES_NAMESPACE,
  readPhiAreaConfigNamespace,
} from "@/lib/cms/area-config";
import { mergePhiAreaTreeForPublish } from "@/lib/cms/area-publish-merge";
import {
  validateCmsAreaPresetWriteInput,
  validateCmsPageWriteInput,
} from "@/lib/cms/write-validation";
import {
  validateCmsAreaRevisionForPublish,
  validateCmsPageRevisionForPublish,
} from "@/lib/cms/publish-validation";
import type { PhiViewerAccessPolicy } from "@/lib/authorization";
import { toPhiRecord } from "@/lib/helpers/record";
import { phiPrepared } from "@/lib/db-prepared";

type DbQueryable = Pick<PoolClient, "query">;

const AREA = SITE_REVISION_TABLES.area;
const PAGE = SITE_REVISION_TABLES.page;

function readWidgetContentBindingSourceValue(
  config: Record<string, unknown> | null | undefined,
  binding: CmsDraftContentBindingInput,
  widgetId: PhiCmsInstanceId,
) {
  const rawValue = config?.[binding.sourceField];
  if (typeof rawValue !== "string") {
    throw new Error(
      `Widget ${widgetId} requires config.${binding.sourceField} for ${binding.storage} content persistence.`,
    );
  }

  if (binding.storage === "text" && !rawValue.trim()) {
    throw new Error(
      `Widget ${widgetId} requires a non-empty config.${binding.sourceField} for text content persistence.`,
    );
  }

  return rawValue;
}

function readWidgetAssetContentBindingSourceValue(
  config: Record<string, unknown> | null | undefined,
  binding: CmsDraftContentBindingInput,
  widgetId: PhiCmsInstanceId,
) {
  const rawValue = config?.[binding.sourceField];
  if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue > 0) {
    return rawValue;
  }

  if (typeof rawValue === "string") {
    const parsed = Number.parseInt(rawValue.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error(
    `Widget ${widgetId} requires config.${binding.sourceField} for asset content persistence.`,
  );
}

export type SitePageRecord = {
  id: number;
  siteId: number;
  areaMask: number;
  path: string;
  pageType: number;
  status: number;
  flags: number;
  visibilityMask: number;
  accessPolicy: PhiViewerAccessPolicy;
  titleMsgId: number | null;
  descriptionMsgId: number | null;
  heroRootLayoutNodeId: PhiCmsInstanceId | null;
  headerBottomRootLayoutNodeId: PhiCmsInstanceId | null;
  siderRightRootLayoutNodeId: PhiCmsInstanceId | null;
  footerTopRootLayoutNodeId: PhiCmsInstanceId | null;
  drawerRightRootLayoutNodeId: PhiCmsInstanceId | null;
  contentRootLayoutNodeId: PhiCmsInstanceId | null;
  layoutConfig: Record<string, unknown>;
};

export type SiteResolvedRegionRecord = {
  id: number;
  pageId: number;
  areaPresetId: number | null;
  regionType: number;
  rootLayoutNodeId: PhiCmsInstanceId;
  status: number;
  flags: number;
  visibilityMask: number;
  sortOrder: number;
  config: Record<string, unknown>;
};

export type SiteOverlayRecord = {
  id: PhiCmsInstanceId;
  overlayType: "modal" | "drawer";
  headerLayoutNodeId: PhiCmsInstanceId | null;
  bodyLayoutNodeId: PhiCmsInstanceId;
  footerLayoutNodeId: PhiCmsInstanceId | null;
  status: number;
  flags: number;
  visibilityMask: number;
  sortOrder: number;
  label: string | null;
  config: Record<string, unknown>;
};

export type SiteAreaPresetRecord = {
  id: number;
  siteId: number;
  areaMask: number;
  status: number;
  flags: number;
  visibilityMask: number;
  config: Record<string, unknown>;
};

export type SiteLayoutNodeRecord = {
  id: PhiCmsInstanceId;
  siteId: number;
  parentLayoutNodeId: PhiCmsInstanceId | null;
  widgetType: string;
  slotIndex: number;
  sortOrder: number;
  status: number;
  flags: number;
  visibilityMask: number;
  label: string | null;
  config: Record<string, unknown>;
};

export type SiteContentWidgetRecord = {
  id: PhiCmsInstanceId;
  siteId: number;
  parentLayoutNodeId: PhiCmsInstanceId;
  widgetType: string;
  slotIndex: number;
  sortOrder: number;
  status: number;
  flags: number;
  visibilityMask: number;
  label: string | null;
  config: Record<string, unknown>;
  contentId: number | null;
  contentVersionId: number | null;
  resolvedContent?: SiteResolvedContentRecord | null;
};

export type SiteResolvedWidgetTree = {
  sourcePreset: CmsPageWriteInput["sourcePreset"];
  page: SitePageRecord;
  pageMeta: SiteResolvedPageMeta | null;
  regions: SiteResolvedRegionRecord[];
  overlays: SiteOverlayRecord[];
  layoutNodes: SiteLayoutNodeRecord[];
  contentWidgets: SiteContentWidgetRecord[];
};

export type SiteResolvedPageMeta = {
  title: ResolvedSiteMessageField | null;
  description: ResolvedSiteMessageField | null;
};

export type SiteResolvedAreaPresetTree = {
  sourcePreset: CmsAreaPresetWriteInput["sourcePreset"];
  preset: SiteAreaPresetRecord;
  regions: SiteResolvedRegionRecord[];
  overlays: SiteOverlayRecord[];
  layoutNodes: SiteLayoutNodeRecord[];
  contentWidgets: SiteContentWidgetRecord[];
};

export type SiteAreaRevisionRecord = SiteRevisionRecord;

export type SitePageRevisionRecord = SiteRevisionRecord;

type SiteAreaScopeRecord = {
  id: number;
  siteId: number;
  areaMask: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
  /** The Area's Module selection is drafted apart from its structure, so it points at its own row. */
  workingModuleDraftRevisionId: number | null;
};

type SitePageScopeRecord = {
  id: number;
  siteId: number;
  areaMask: number;
  path: string | null;
  /** The path a published change would move this Page to, or null while none stands. */
  draftPath: string | null;
  ownerModuleId: string | null;
  presetKey: string | null;
  tombstonedAt: string | null;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SitePageScopeAddress =
  | { kind: "path"; path: string }
  | { kind: "preset"; ownerModuleId: string; presetKey: string };

export type SitePresetIdentity = Pick<
  CmsAreaPresetWriteInput["sourcePreset"],
  "ownerModuleId" | "presetKey"
>;

function resolveSitePageScopeAddress(input: Pick<CmsPageWriteInput, "path" | "sourcePreset">): SitePageScopeAddress {
  return input.sourcePreset
    ? {
        kind: "preset",
        ownerModuleId: input.sourcePreset.ownerModuleId,
        presetKey: input.sourcePreset.presetKey,
      }
    : { kind: "path", path: input.path };
}

function hasSamePresetIdentity(
  left: SitePresetIdentity | null,
  right: SitePresetIdentity | null,
) {
  return left == null || right == null
    ? left === right
    : left.ownerModuleId === right.ownerModuleId && left.presetKey === right.presetKey;
}

function resolveSnapshotPresetSource<T extends CmsPageWriteInput["sourcePreset"] | CmsAreaPresetWriteInput["sourcePreset"]>(
  persisted: T | undefined,
  requested: T,
): T {
  if (persisted === undefined) {
    return requested;
  }
  if (!hasSamePresetIdentity(persisted, requested)) {
    throw new SiteCmsDraftConflictError("CMS snapshot preset identity does not match the requested scope.");
  }
  return persisted;
}

export type SitePageScopeCatalogRecord = SitePageScopeRecord & {
  createdAt: string;
  updatedAt: string;
};

export type SiteCmsDraftState = CmsDraftWriteState;

export class SitePagePathChangeError extends Error {
  constructor(
    readonly code: "invalid_path" | "page_not_found" | "module_owned" | "path_collision" | "path_nested",
    message: string,
  ) {
    super(message);
    this.name = "SitePagePathChangeError";
  }
}

/**
 * Creating a Page at an address a Scope already holds. The create writes nothing then: the Builder that
 * asked did not know the Page, and what it wants is to open it, not to lay a blank draft over it.
 */
export class SitePageExistsError extends Error {
  readonly code = "page_exists";

  constructor(
    readonly pageScopeId: number,
    readonly path: string,
    readonly tombstoned: boolean,
  ) {
    super("A Page already exists at this path.");
    this.name = "SitePageExistsError";
  }
}

function normalizeMutableSitePagePath(value: string) {
  const path = normalizeSiteCmsPath(value);
  if (
    path.length > 512 ||
    /[?#\\]/u.test(path) ||
    /(?:^|\/)\.\.?(?:\/|$)/u.test(path) ||
    /^\/(?:api|_next|operator|setup)(?:\/|$)/iu.test(path)
  ) {
    throw new SitePagePathChangeError("invalid_path", "The requested Page path is invalid or reserved.");
  }
  return path;
}

function readSiteCmsDraftState(revision: Pick<SiteAreaRevisionRecord | SitePageRevisionRecord, "id" | "metaJson">) {
  const draft = revision.metaJson.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new SiteCmsDraftConflictError(
      `Working Draft revision #${revision.id} does not contain canonical Draft metadata.`,
    );
  }

  const record = draft as Record<string, unknown>;
  const version = record.version;
  const nextNodeSequence = record.nextNodeSequence;
  if (
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    !Number.isSafeInteger(nextNodeSequence) ||
    (nextNodeSequence as number) < 1 ||
    (nextNodeSequence as number) > 0xffffffff
  ) {
    throw new SiteCmsDraftConflictError(
      `Working Draft revision #${revision.id} contains invalid Draft metadata.`,
    );
  }

  return {
    revisionId: revision.id,
    version: version as number,
    nextNodeSequence: nextNodeSequence as number,
  } satisfies SiteCmsDraftState;
}

function assertSiteCmsDraftWriteState(
  persisted: SiteCmsDraftState,
  requested: CmsDraftWriteState | undefined,
) {
  if (!requested) {
    throw new SiteCmsDraftConflictError(
      `Working Draft revision #${persisted.revisionId} requires revision and version metadata.`,
    );
  }
  if (requested.revisionId !== persisted.revisionId || requested.version !== persisted.version) {
    throw new SiteCmsDraftConflictError(
      `Working Draft changed from revision #${requested.revisionId} version ${requested.version} to revision #${persisted.revisionId} version ${persisted.version}.`,
    );
  }
  if (requested.nextNodeSequence < persisted.nextNodeSequence) {
    throw new SiteCmsDraftConflictError(
      `Working Draft nextNodeSequence must not move backwards from ${persisted.nextNodeSequence} to ${requested.nextNodeSequence}.`,
    );
  }
}

function withSiteCmsDraftMeta(
  metaJson: Record<string, unknown>,
  draft: Pick<SiteCmsDraftState, "version" | "nextNodeSequence">,
) {
  return {
    ...metaJson,
    draft: {
      version: draft.version,
      nextNodeSequence: draft.nextNodeSequence,
    },
  };
}

function readRevisionNodeKey(node: { id?: string | number | null; widgetType?: string | null }) {
  if ((typeof node.id === "string" && node.id) || (typeof node.id === "number" && Number.isInteger(node.id))) {
    return `id:${node.id}`;
  }

  return `anonymous:${node.widgetType ?? "node"}:${stableJsonStringify(node)}`;
}

function diffRevisionNodes<TNode extends { id?: string | number | null; widgetType?: string | null }>(
  previous: TNode[],
  next: TNode[],
) {
  const previousByKey = new Map(previous.map((node) => [readRevisionNodeKey(node), stableJsonStringify(node)]));
  const nextByKey = new Map(next.map((node) => [readRevisionNodeKey(node), stableJsonStringify(node)]));
  let added = 0;
  let changed = 0;
  let removed = 0;

  for (const [key, value] of nextByKey.entries()) {
    if (!previousByKey.has(key)) {
      added += 1;
    } else if (previousByKey.get(key) !== value) {
      changed += 1;
    }
  }

  for (const key of previousByKey.keys()) {
    if (!nextByKey.has(key)) {
      removed += 1;
    }
  }

  return { added, changed, removed, total: added + changed + removed };
}

function slugifySegment(input: string | null | undefined, fallback: string) {
  const normalized = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

function buildRandomSlugSuffix() {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
}

function buildWidgetContentSlug(
  scope: {
    scopeKind: "page" | "area";
    areaMask: number;
    path?: string | null;
  },
  widget: {
    id: PhiCmsInstanceId;
    label: string | null;
  },
  contentTypeKey: string,
) {
  const scopeSegment =
    scope.scopeKind === "page"
      ? `${scope.scopeKind}-${slugifySegment(scope.path, "root")}`
      : `${scope.scopeKind}-${scope.areaMask}`;
  const widgetSegment = slugifySegment(widget.label, `widget-${widget.id}`);
  return fitSiteContentSlug(
    `cms-${scopeSegment}-${contentTypeKey}-${widgetSegment}-${buildRandomSlugSuffix()}`,
  );
}

/** The width of `phis.site_content.slug`. */
const SITE_CONTENT_SLUG_MAX_LENGTH = 255;

/**
 * Brings a built slug within the column, the same way every time.
 *
 * A deep page path or a long widget label easily builds a slug past the column, and the insert would
 * then fail outright. Cutting it alone would let two slugs that differ only past the cut collide, so a
 * short hash of the whole slug replaces the tail: the result stays readable at the front and distinct
 * for distinct inputs.
 */
function fitSiteContentSlug(slug: string) {
  if (slug.length <= SITE_CONTENT_SLUG_MAX_LENGTH) return slug;
  const hash = createHash("sha256").update(slug).digest("hex").slice(0, 12);
  const head = slug.slice(0, SITE_CONTENT_SLUG_MAX_LENGTH - hash.length - 1).replace(/-+$/u, "");
  return `${head}-${hash}`;
}

function readPageRegionConfig(layoutConfig: Record<string, unknown>, regionKey: string) {
  const pageRegionConfigs = toPhiRecord(layoutConfig.pageRegionConfigs);
  return toPhiRecord(pageRegionConfigs[regionKey]);
}

function buildDraftPreviewPageTree(siteId: number, input: CmsPageWriteInput): SiteResolvedWidgetTree {
  const normalizedPath = normalizeSiteCmsPath(input.path);
  const pageId = input.page?.id ?? -1;
  const page: SitePageRecord = {
    id: pageId,
    siteId,
    areaMask: input.areaMask,
    path: normalizedPath,
    pageType: input.page?.pageType ?? 0,
    status: input.page?.status ?? 0,
    flags: input.page?.flags ?? 0,
    visibilityMask: input.page?.visibilityMask ?? input.areaMask,
    accessPolicy: input.page?.accessPolicy ?? { access: "anyone" },
    titleMsgId: input.page?.titleMsgId ?? null,
    descriptionMsgId: input.page?.descriptionMsgId ?? null,
    heroRootLayoutNodeId: input.page?.heroRootLayoutNodeId ?? null,
    headerBottomRootLayoutNodeId: input.page?.headerBottomRootLayoutNodeId ?? null,
    siderRightRootLayoutNodeId: input.page?.siderRightRootLayoutNodeId ?? null,
    footerTopRootLayoutNodeId: input.page?.footerTopRootLayoutNodeId ?? null,
    drawerRightRootLayoutNodeId: input.page?.drawerRightRootLayoutNodeId ?? null,
    contentRootLayoutNodeId: input.page?.contentRootLayoutNodeId ?? null,
    layoutConfig: toPhiRecord(input.page?.layoutConfig),
  };
  const regions: SiteResolvedRegionRecord[] = [];
  const regionPairs: Array<[number, PhiCmsInstanceId | null | undefined]> = [
    [PhiCmsRegionType.HeaderBottom, input.page?.headerBottomRootLayoutNodeId],
    [PhiCmsRegionType.Hero, input.page?.heroRootLayoutNodeId],
    [PhiCmsRegionType.Content, input.page?.contentRootLayoutNodeId],
    [PhiCmsRegionType.SiderRight, input.page?.siderRightRootLayoutNodeId],
    [PhiCmsRegionType.FooterTop, input.page?.footerTopRootLayoutNodeId],
    [PhiCmsRegionType.Drawer, input.page?.drawerRightRootLayoutNodeId],
  ];

  regionPairs.forEach(([regionType, rootLayoutNodeId], index) => {
    if (rootLayoutNodeId == null) {
      return;
    }

    const regionKey =
      regionType === PhiCmsRegionType.HeaderBottom
        ? "header_bottom"
        : regionType === PhiCmsRegionType.Hero
          ? "hero"
          : regionType === PhiCmsRegionType.Content
            ? "content"
            : regionType === PhiCmsRegionType.SiderRight
              ? "sider_right"
              : "footer_top";

    regions.push({
      id: -(index + 1),
      pageId,
      areaPresetId: null,
      regionType,
      rootLayoutNodeId,
      status: 1,
      flags: 0,
      visibilityMask: input.areaMask,
      sortOrder: index,
      config: readPageRegionConfig(page.layoutConfig, regionKey),
    });
  });

  return {
    sourcePreset: input.sourcePreset,
    page,
    pageMeta: null,
    regions,
    overlays: input.overlays.map((overlay) => ({
      id: overlay.id,
      overlayType: overlay.overlayType,
      headerLayoutNodeId: overlay.headerLayoutNodeId,
      bodyLayoutNodeId: overlay.bodyLayoutNodeId,
      footerLayoutNodeId: overlay.footerLayoutNodeId,
      status: overlay.status ?? 0,
      flags: overlay.flags ?? 0,
      visibilityMask: overlay.visibilityMask ?? input.areaMask,
      sortOrder: overlay.sortOrder ?? 0,
      label: overlay.label ?? null,
      config: toPhiRecord(overlay.config),
    })),
    layoutNodes: input.layoutNodes.map((node) => ({
      id: node.id,
      siteId,
      parentLayoutNodeId: node.parentLayoutNodeId,
      widgetType: node.widgetType,
      slotIndex: node.slotIndex,
      sortOrder: node.sortOrder ?? 0,
      status: node.status ?? 0,
      flags: node.flags ?? 0,
      visibilityMask: node.visibilityMask ?? 0,
      label: node.label ?? null,
      config: toPhiRecord(node.config),
    })),
    contentWidgets: input.contentWidgets.map((widget) => ({
      id: widget.id,
      siteId,
      parentLayoutNodeId: widget.parentLayoutNodeId,
      widgetType: widget.widgetType,
      slotIndex: widget.slotIndex,
      sortOrder: widget.sortOrder ?? 0,
      status: widget.status ?? 0,
      flags: widget.flags ?? 0,
      visibilityMask: widget.visibilityMask ?? 0,
      label: widget.label ?? null,
      config: toPhiRecord(widget.config),
      contentId: widget.contentId ?? null,
      contentVersionId: widget.contentVersionId ?? null,
      resolvedContent: null,
    })),
  };
}

function buildDraftPreviewAreaTree(siteId: number, input: CmsAreaPresetWriteInput): SiteResolvedAreaPresetTree {
  return {
    sourcePreset: input.sourcePreset,
    preset: {
      id: input.preset?.id ?? -1,
      siteId,
      areaMask: input.areaMask,
      status: input.preset?.status ?? 0,
      flags: input.preset?.flags ?? 0,
      visibilityMask: input.preset?.visibilityMask ?? input.areaMask,
      config: toPhiRecord(input.preset?.config),
    },
    regions: input.regions.map((region, index) => ({
      id: region.id ?? -(index + 1),
      pageId: 0,
      areaPresetId: input.preset?.id ?? -1,
      regionType: region.regionType,
      rootLayoutNodeId: region.rootLayoutNodeId,
      status: region.status ?? 0,
      flags: region.flags ?? 0,
      visibilityMask: region.visibilityMask ?? input.areaMask,
      sortOrder: region.sortOrder ?? index,
      config: toPhiRecord(region.config),
    })),
    overlays: input.overlays.map((overlay) => ({
      id: overlay.id,
      overlayType: overlay.overlayType,
      headerLayoutNodeId: overlay.headerLayoutNodeId,
      bodyLayoutNodeId: overlay.bodyLayoutNodeId,
      footerLayoutNodeId: overlay.footerLayoutNodeId,
      status: overlay.status ?? 0,
      flags: overlay.flags ?? 0,
      visibilityMask: overlay.visibilityMask ?? input.areaMask,
      sortOrder: overlay.sortOrder ?? 0,
      label: overlay.label ?? null,
      config: toPhiRecord(overlay.config),
    })),
    layoutNodes: input.layoutNodes.map((node) => ({
      id: node.id,
      siteId,
      parentLayoutNodeId: node.parentLayoutNodeId,
      widgetType: node.widgetType,
      slotIndex: node.slotIndex,
      sortOrder: node.sortOrder ?? 0,
      status: node.status ?? 0,
      flags: node.flags ?? 0,
      visibilityMask: node.visibilityMask ?? 0,
      label: node.label ?? null,
      config: toPhiRecord(node.config),
    })),
    contentWidgets: input.contentWidgets.map((widget) => ({
      id: widget.id,
      siteId,
      parentLayoutNodeId: widget.parentLayoutNodeId,
      widgetType: widget.widgetType,
      slotIndex: widget.slotIndex,
      sortOrder: widget.sortOrder ?? 0,
      status: widget.status ?? 0,
      flags: widget.flags ?? 0,
      visibilityMask: widget.visibilityMask ?? 0,
      label: widget.label ?? null,
      config: toPhiRecord(widget.config),
      contentId: widget.contentId ?? null,
      contentVersionId: widget.contentVersionId ?? null,
      resolvedContent: null,
    })),
  };
}

async function resolveTreeContentWidgetsWithDb(
  db: DbQueryable,
  siteId: number,
  widgets: SiteContentWidgetRecord[],
  locale?: string | null,
) {
  const pinned = widgets.filter((widget) => widget.contentVersionId != null);
  const translatedVersionIds = pinned
    .filter((widget) => !hasPhiFlag(widget.flags, PhiCmsFlags.NoTranslate))
    .map((widget) => widget.contentVersionId ?? 0);
  const sourceOnlyVersionIds = pinned
    .filter((widget) => hasPhiFlag(widget.flags, PhiCmsFlags.NoTranslate))
    .map((widget) => widget.contentVersionId ?? 0);

  const [translatedResolvedById, sourceOnlyResolvedById] = await Promise.all([
    getResolvedSiteContentByVersionIds(siteId, translatedVersionIds, locale ?? null),
    getResolvedSiteContentByVersionIds(siteId, sourceOnlyVersionIds, null),
  ]);

  return widgets.map((widget) => ({
    ...widget,
    resolvedContent:
      widget.contentVersionId == null
        ? null
        : hasPhiFlag(widget.flags, PhiCmsFlags.NoTranslate)
          ? sourceOnlyResolvedById.get(widget.contentVersionId) ?? null
          : translatedResolvedById.get(widget.contentVersionId) ?? null,
  }));
}

async function buildResolvedPageTreeFromRevisionWithDb(
  db: DbQueryable,
  siteId: number,
  scope: SitePageScopeRecord,
  input: CmsPageWriteInput,
  locale?: string | null,
): Promise<SiteResolvedWidgetTree> {
  const tree = buildDraftPreviewPageTree(siteId, {
    ...input,
    page: {
      ...(input.page ?? {}),
      id: scope.id,
    },
  });

  const pageMeta = await resolveSitePageMetaWithDb(tree.page, locale ?? null);

  return {
    ...tree,
    pageMeta,
    contentWidgets: await resolveTreeContentWidgetsWithDb(db, siteId, tree.contentWidgets, locale ?? null),
  };
}

async function resolveSitePageMetaWithDb(
  page: SitePageRecord,
  locale?: string | null,
): Promise<SiteResolvedPageMeta | null> {
  if (!locale?.trim()) {
    return null;
  }

  const msgIds = [page.titleMsgId, page.descriptionMsgId].filter(
    (msgId): msgId is number => typeof msgId === "number" && Number.isInteger(msgId) && msgId > 0,
  );
  if (msgIds.length === 0) {
    return null;
  }

  const resolvedFields = await getResolvedSiteMessageFields(msgIds, locale);
  const title = page.titleMsgId ? (resolvedFields.get(page.titleMsgId) ?? null) : null;
  const description = page.descriptionMsgId
    ? (resolvedFields.get(page.descriptionMsgId) ?? null)
    : null;

  if (!title && !description) {
    return null;
  }

  return {
    title,
    description,
  };
}

async function buildResolvedAreaTreeFromRevisionWithDb(
  db: DbQueryable,
  siteId: number,
  scope: SiteAreaScopeRecord,
  input: CmsAreaPresetWriteInput,
  locale?: string | null,
): Promise<SiteResolvedAreaPresetTree> {
  const tree = buildDraftPreviewAreaTree(siteId, {
    ...input,
    preset: {
      ...(input.preset ?? {}),
      id: scope.id,
    },
  });

  return {
    ...tree,
    contentWidgets: await resolveTreeContentWidgetsWithDb(db, siteId, tree.contentWidgets, locale ?? null),
  };
}

function parseWidgetNamespacedTypeKey(value: string) {
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid widget type key "${value}".`);
  }

  const typeKey = parts.at(-1)!;
  const pluginKey = parts.slice(0, -1).join("/");
  if (!pluginKey || !typeKey) {
    throw new Error(`Invalid widget type key "${value}".`);
  }

  return { pluginKey, typeKey };
}

async function getSiteAreaScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  options?: { forUpdate?: boolean },
): Promise<SiteAreaScopeRecord | null> {
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
    working_module_draft_revision_id: number | null;
  }>(
    `SELECT id, site_id, area_id, published_revision_id, working_draft_revision_id,
            working_module_draft_revision_id
     FROM phis.site_area_scopes
     WHERE site_id = $1
       AND area_id = $2
     LIMIT 1
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [siteId, areaMask],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    siteId: row.site_id,
    areaMask: row.area_id,
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
    workingModuleDraftRevisionId: row.working_module_draft_revision_id,
  };
}

async function getSitePageScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SitePageScopeAddress,
  options?: { forUpdate?: boolean },
): Promise<SitePageScopeRecord | null> {
  const normalizedPath = address.kind === "path" ? normalizeSiteCmsPath(address.path) : null;
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    path: string | null;
    draft_path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    tombstoned_at: Date | string | null;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(phiPrepared(
    `SELECT id, site_id, area_id, path, draft_path, owner_module_id, preset_key, tombstoned_at,
            published_revision_id, working_draft_revision_id
     FROM phis.site_page_scopes
     WHERE site_id = $1
       AND area_id = $2
       AND ${address.kind === "path"
         ? "path = $3 AND owner_module_id IS NULL AND preset_key IS NULL"
         : "path IS NULL AND owner_module_id = $3 AND preset_key = $4"}
     LIMIT 1
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    address.kind === "path"
      ? [siteId, areaMask, normalizedPath]
      : [siteId, areaMask, address.ownerModuleId, address.presetKey],
  ));

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    siteId: row.site_id,
    areaMask: row.area_id,
    path: row.path,
    draftPath: row.draft_path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    tombstonedAt: row.tombstoned_at == null
      ? null
      : row.tombstoned_at instanceof Date
        ? row.tombstoned_at.toISOString()
        : String(row.tombstoned_at),
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
  };
}

async function getSitePageScopeByIdWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  scopeId: number,
  options?: { forUpdate?: boolean },
): Promise<SitePageScopeRecord | null> {
  if (!Number.isInteger(scopeId) || scopeId <= 0) return null;
  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    path: string | null;
    draft_path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    tombstoned_at: Date | string | null;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT id, site_id, area_id, path, draft_path, owner_module_id, preset_key, tombstoned_at,
            published_revision_id, working_draft_revision_id
     FROM phis.site_page_scopes
     WHERE id = $1 AND site_id = $2 AND area_id = $3
     ${options?.forUpdate ? "FOR UPDATE" : ""}`,
    [scopeId, siteId, areaMask],
  );
  const row = rows[0];
  return row ? {
    id: row.id,
    siteId: row.site_id,
    areaMask: row.area_id,
    path: row.path,
    draftPath: row.draft_path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    tombstonedAt: row.tombstoned_at == null
      ? null
      : row.tombstoned_at instanceof Date
        ? row.tombstoned_at.toISOString()
        : String(row.tombstoned_at),
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
  } : null;
}

/** The Builder's half of the question; the CLI asks the same one against its own pool. */
export function listSiteModuleBlockUsage(siteId: number, areaMask: number, moduleId: string) {
  return listSiteModuleBlockUsageWithDb(getPool(), siteId, areaMask, moduleId);
}

/**
 * Where the named Page scopes of an Area live, for resolving `phis:page/<id>` references.
 *
 * A reference names its scope, so only the named rows are read. Resolving through `listSitePageScopes`
 * loaded the Area's whole catalogue for every render that held one link, and for every Navigation read.
 * A scope that is not in the answer does not exist in this Area.
 */
export async function readSitePageScopeTargets(
  siteId: number,
  areaMask: number,
  scopeIds: readonly number[],
): Promise<Map<number, { path: string | null; tombstoned: boolean }>> {
  const ids = Array.from(new Set(scopeIds.filter((id) => Number.isSafeInteger(id) && id > 0)));
  if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(areaMask) || areaMask <= 0 || ids.length === 0) {
    return new Map();
  }
  const { rows } = await getPool().query<{ id: number; path: string | null; tombstoned_at: Date | string | null }>(phiPrepared(
    `SELECT id, path, tombstoned_at
     FROM phis.site_page_scopes
     WHERE site_id = $1
       AND area_id = $2
       AND id = ANY($3::int[])`,
    [siteId, areaMask, ids],
  ));
  return new Map(rows.map((row) => [row.id, { path: row.path, tombstoned: row.tombstoned_at != null }]));
}

export async function listSitePageScopes(siteId: number, areaMask: number): Promise<SitePageScopeCatalogRecord[]> {
  if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(areaMask) || areaMask <= 0) {
    return [];
  }

  const { rows } = await getPool().query<{
    id: number;
    site_id: number;
    area_id: number;
    path: string | null;
    draft_path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    tombstoned_at: Date | string | null;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT id,
            site_id,
            area_id,
            path,
            draft_path,
            owner_module_id,
            preset_key,
            tombstoned_at,
            published_revision_id,
            working_draft_revision_id,
            created_at,
            updated_at
     FROM phis.site_page_scopes
     WHERE site_id = $1
       AND area_id = $2
     ORDER BY COALESCE(path, owner_module_id || '/' || preset_key) ASC`,
    [siteId, areaMask],
  );

  return rows.map((row) => ({
    id: row.id,
    siteId: row.site_id,
    areaMask: row.area_id,
    path: row.path,
    draftPath: row.draft_path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    tombstonedAt: row.tombstoned_at == null
      ? null
      : row.tombstoned_at instanceof Date
        ? row.tombstoned_at.toISOString()
        : String(row.tombstoned_at),
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

export type SitePublishedPageAddressRecord = {
  path: string | null;
  ownerModuleId: string | null;
  presetKey: string | null;
  /** The live revision. A publish replaces it, which is what tells a Site its sitemap is stale. */
  revisionId: number;
  publishedAt: string;
};

/**
 * Every Page of one Area that visitors can reach, with the time its live revision was written.
 *
 * Only the address and its identity: whether a Page is indexable, visible to a visitor or a redirect is
 * answered by the Site resolving it, which is where those rules already live. A Module Page stored by
 * the Site carries no path of its own -- its address comes from the route table -- so it is named by
 * its preset identity instead.
 */
export async function listSitePublishedPageAddresses(
  siteId: number,
  areaMask: number,
): Promise<SitePublishedPageAddressRecord[]> {
  if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(areaMask) || areaMask <= 0) {
    return [];
  }

  const { rows } = await getPool().query<{
    path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    revision_id: number;
    published_at: Date | string;
  }>(
    `SELECT s.path,
            s.owner_module_id,
            s.preset_key,
            r.id AS revision_id,
            r.created_at AS published_at
     FROM phis.site_page_scopes s
     JOIN phis.site_page_revisions r ON r.id = s.published_revision_id
     WHERE s.site_id = $1
       AND s.area_id = $2
       AND s.tombstoned_at IS NULL
     ORDER BY COALESCE(s.path, s.owner_module_id || '/' || s.preset_key) ASC`,
    [siteId, areaMask],
  );

  return rows.map((row) => ({
    path: row.path,
    ownerModuleId: row.owner_module_id,
    presetKey: row.preset_key,
    revisionId: row.revision_id,
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
  }));
}

async function ensureSiteAreaScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
): Promise<SiteAreaScopeRecord> {
  const existing = await getSiteAreaScopeWithDb(db, siteId, areaMask, { forUpdate: true });
  if (existing) {
    return existing;
  }

  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
    working_module_draft_revision_id: number | null;
  }>(
    `INSERT INTO phis.site_area_scopes (
       site_id,
       area_id,
       published_revision_id,
       working_draft_revision_id,
       working_module_draft_revision_id
     )
     VALUES ($1, $2, NULL, NULL, NULL)
     ON CONFLICT (site_id, area_id)
     DO UPDATE SET updated_at = NOW()
     RETURNING id, site_id, area_id, published_revision_id, working_draft_revision_id,
               working_module_draft_revision_id`,
    [siteId, areaMask],
  );

  return {
    id: rows[0]!.id,
    siteId: rows[0]!.site_id,
    areaMask: rows[0]!.area_id,
    publishedRevisionId: rows[0]!.published_revision_id,
    workingDraftRevisionId: rows[0]!.working_draft_revision_id,
    workingModuleDraftRevisionId: rows[0]!.working_module_draft_revision_id,
  };
}

async function ensureSitePageScopeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SitePageScopeAddress,
): Promise<SitePageScopeRecord> {
  const normalizedPath = address.kind === "path" ? normalizeSiteCmsPath(address.path) : null;
  const existing = await getSitePageScopeWithDb(db, siteId, areaMask, address, { forUpdate: true });
  if (existing) {
    return existing;
  }
  if (normalizedPath != null) {
    // A new address: take the Area's address lock, look again -- another writer may have created it
    // meanwhile, and a save that finds it attaches as before -- and only then check and insert.
    await lockSitePageAddressesWithDb(db, siteId, areaMask);
    const created = await getSitePageScopeWithDb(db, siteId, areaMask, address, { forUpdate: true });
    if (created) {
      return created;
    }
    await assertSitePageAddressFreeWithDb(db, siteId, areaMask, normalizedPath, null);
  }

  const { rows } = await db.query<{
    id: number;
    site_id: number;
    area_id: number;
    path: string | null;
    draft_path: string | null;
    owner_module_id: string | null;
    preset_key: string | null;
    tombstoned_at: Date | string | null;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `INSERT INTO phis.site_page_scopes (
       site_id,
       area_id,
       path,
       owner_module_id,
       preset_key,
       published_revision_id,
       working_draft_revision_id
     )
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     ON CONFLICT (${address.kind === "path"
       ? "site_id, area_id, path) WHERE path IS NOT NULL"
       : "site_id, area_id, owner_module_id, preset_key) WHERE owner_module_id IS NOT NULL"}
     DO UPDATE SET updated_at = NOW()
     RETURNING id, site_id, area_id, path, draft_path, owner_module_id, preset_key, tombstoned_at,
               published_revision_id, working_draft_revision_id`,
    address.kind === "path"
      ? [siteId, areaMask, normalizedPath, null, null]
      : [siteId, areaMask, null, address.ownerModuleId, address.presetKey],
  );

  return {
    id: rows[0]!.id,
    siteId: rows[0]!.site_id,
    areaMask: rows[0]!.area_id,
    path: rows[0]!.path,
    draftPath: rows[0]!.draft_path,
    ownerModuleId: rows[0]!.owner_module_id,
    presetKey: rows[0]!.preset_key,
    tombstonedAt: rows[0]!.tombstoned_at == null
      ? null
      : rows[0]!.tombstoned_at instanceof Date
        ? rows[0]!.tombstoned_at.toISOString()
        : String(rows[0]!.tombstoned_at),
    publishedRevisionId: rows[0]!.published_revision_id,
    workingDraftRevisionId: rows[0]!.working_draft_revision_id,
  };
}

/**
 * Moves an Area scope's pointers.
 *
 * `workingModuleDraftRevisionId` is left alone when it is not named, rather than cleared. The two
 * drafts are independent, and a structure save that silently dropped the Module draft pointer would
 * discard an edit its caller never looked at.
 */
async function setSiteAreaScopePointersWithDb(
  db: DbQueryable,
  scopeId: number,
  input: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
    workingModuleDraftRevisionId?: number | null;
  },
) {
  const setsModuleDraft = input.workingModuleDraftRevisionId !== undefined;
  await db.query(
    `UPDATE phis.site_area_scopes
     SET published_revision_id = $2,
         working_draft_revision_id = $3,
         ${setsModuleDraft ? "working_module_draft_revision_id = $4," : ""}
         updated_at = NOW()
     WHERE id = $1`,
    setsModuleDraft
      ? [scopeId, input.publishedRevisionId, input.workingDraftRevisionId, input.workingModuleDraftRevisionId]
      : [scopeId, input.publishedRevisionId, input.workingDraftRevisionId],
  );
  await pruneSiteRevisionScopeReferencesWithDb(db, AREA, scopeId);
}

function readValidatedPageRevisionTree(
  treeJson: Record<string, unknown>,
): CmsPageWriteInput {
  const validated = validateCmsPageWriteInput(treeJson);
  if (!validated.ok) {
    throw new Error(`Invalid page revision payload. ${validated.error}`);
  }

  return validated.value;
}

function isDeletedPageRevision(input: CmsPageWriteInput, flags?: number | null) {
  return input.page?.status === PhiCmsStatus.Deleted || hasPhiFlag(flags ?? 0, PhiCmsRevisionFlags.Deleted);
}

function buildRevisionFallbackMessage(kind: string, sourceRevisionId: number | null, count?: number) {
  const suffix = sourceRevisionId != null ? ` from revision #${sourceRevisionId}` : "";
  return count != null && count > 0 ? `${kind}: changed ${count} nodes${suffix}` : `${kind}: saved draft${suffix}`;
}

function buildPageRevisionSummary(input: CmsPageWriteInput, source: CmsPageWriteInput | null, sourceRevisionId: number | null) {
  const widgetDiff = diffRevisionNodes(source?.contentWidgets ?? [], input.contentWidgets);
  const layoutDiff = diffRevisionNodes(source?.layoutNodes ?? [], input.layoutNodes);
  const overlayDiff = diffRevisionNodes(source?.overlays ?? [], input.overlays);
  const titleChanged = (source?.page?.titleMsgId ?? null) !== (input.page?.titleMsgId ?? null);
  const descriptionChanged = (source?.page?.descriptionMsgId ?? null) !== (input.page?.descriptionMsgId ?? null);
  /*
   * Indexing is asked in the same dialog as the titles and is counted with them, because it is the same
   * kind of change: a statement about the Page rather than about anything on it. It is read off the
   * flags and not off a field of its own -- that is where it is stored.
   */
  const indexChanged =
    hasPhiFlag(source?.page?.flags ?? 0, PhiCmsFlags.NoIndex) !==
    hasPhiFlag(input.page?.flags ?? 0, PhiCmsFlags.NoIndex);
  const deleted = isDeletedPageRevision(input);
  const messageKey = deleted
    ? "page_deleted"
    : titleChanged || descriptionChanged || indexChanged
      ? "page_meta_changed"
      : widgetDiff.total + layoutDiff.total + overlayDiff.total > 0
        ? "page_nodes_changed"
        : "page_saved";
  const metaLabels = [
    titleChanged ? "title" : "",
    descriptionChanged ? "description" : "",
    indexChanged ? "indexing" : "",
  ].filter(Boolean);

  return {
    message: deleted
      ? `Page: deleted${sourceRevisionId != null ? ` from revision #${sourceRevisionId}` : ""}`
      : messageKey === "page_meta_changed"
        ? `Page: changed ${metaLabels.join(" and ")}${sourceRevisionId != null ? ` from revision #${sourceRevisionId}` : ""}`
        : buildRevisionFallbackMessage("Page", sourceRevisionId, widgetDiff.total + layoutDiff.total + overlayDiff.total),
    metaJson: {
      messageKey,
      sourceRevisionId,
      origin: sourceRevisionId == null ? "new" : "revision",
      changeKinds: [
        ...(titleChanged || descriptionChanged || indexChanged ? ["page_meta"] : []),
        ...(widgetDiff.total > 0 ? ["widgets"] : []),
        ...(layoutDiff.total > 0 ? ["layouts"] : []),
        ...(overlayDiff.total > 0 ? ["overlays"] : []),
        ...(deleted ? ["deleted"] : []),
      ],
      pageMeta: { titleChanged, descriptionChanged, indexChanged },
      nodes: { widgets: widgetDiff, layouts: layoutDiff, overlays: overlayDiff },
    },
  };
}

function buildAreaRevisionSummary(input: CmsAreaPresetWriteInput, source: CmsAreaPresetWriteInput | null, sourceRevisionId: number | null) {
  const widgetDiff = diffRevisionNodes(source?.contentWidgets ?? [], input.contentWidgets);
  const layoutDiff = diffRevisionNodes(source?.layoutNodes ?? [], input.layoutNodes);
  const overlayDiff = diffRevisionNodes(source?.overlays ?? [], input.overlays);
  const regionDiff = diffRevisionNodes(
    (source?.regions ?? []).map((region) => ({ ...region, id: `region:${region.regionType}` })),
    input.regions.map((region) => ({ ...region, id: `region:${region.regionType}` })),
  );
  const changedCount = widgetDiff.total + layoutDiff.total + regionDiff.total + overlayDiff.total;

  return {
    message: buildRevisionFallbackMessage("Area", sourceRevisionId, changedCount),
    metaJson: {
      messageKey: changedCount > 0 ? "area_nodes_changed" : "area_saved",
      sourceRevisionId,
      origin: sourceRevisionId == null ? "new" : "revision",
      changeKinds: [
        ...(regionDiff.total > 0 ? ["regions"] : []),
        ...(widgetDiff.total > 0 ? ["widgets"] : []),
        ...(layoutDiff.total > 0 ? ["layouts"] : []),
        ...(overlayDiff.total > 0 ? ["overlays"] : []),
      ],
      nodes: { regions: regionDiff, widgets: widgetDiff, layouts: layoutDiff, overlays: overlayDiff },
    },
  };
}

function readValidatedAreaRevisionTree(
  treeJson: Record<string, unknown>,
): CmsAreaPresetWriteInput {
  // Read as stored rather than as a write: this tree was written by one of the two drafts and may carry
  // either namespace, and a published one carries both.
  const validated = validateCmsAreaPresetWriteInput(treeJson, { config: "stored" });
  if (!validated.ok) {
    throw new Error(`Invalid area revision payload. ${validated.error}`);
  }

  return validated.value;
}

async function getExactSiteAreaPresetTreeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  locale?: string | null,
  sourcePreset?: SitePresetIdentity | null,
): Promise<SiteResolvedAreaPresetTree | null> {
  const scope = await getSiteAreaScopeWithDb(db, siteId, areaMask);
  if (!scope?.publishedRevisionId) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(db, AREA, scope.publishedRevisionId);
  if (!revision || revision.scopeId !== scope.id) {
    return null;
  }

  const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
  if (sourcePreset && !hasSamePresetIdentity(revisionTree.sourcePreset, sourcePreset)) {
    return null;
  }

  return buildResolvedAreaTreeFromRevisionWithDb(
    db,
    siteId,
    scope,
    revisionTree,
    locale,
  );
}

async function getResolvedSitePageTreeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  address: SitePageScopeAddress,
  locale?: string | null,
): Promise<SiteResolvedWidgetTree | null> {
  const scope = await getSitePageScopeWithDb(db, siteId, areaMask, address);
  if (!scope?.publishedRevisionId) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(db, PAGE, scope.publishedRevisionId);
  if (!revision || revision.scopeId !== scope.id) {
    return null;
  }

  const revisionTree = readValidatedPageRevisionTree(revision.treeJson);
  if (isDeletedPageRevision(revisionTree, revision.flags)) {
    return null;
  }

  return buildResolvedPageTreeFromRevisionWithDb(
    db,
    siteId,
    scope,
    revisionTree,
    locale,
  );
}

async function siteContentVersionBelongsTo(
  db: DbQueryable,
  contentId: number,
  versionId: number,
) {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id
     FROM phis.site_content_versions
     WHERE id = $2
       AND content_id = $1
     LIMIT 1`,
    [contentId, versionId],
  );

  return Boolean(rows[0]);
}

async function siteContentExistsOnSite(
  db: DbQueryable,
  siteId: number,
  contentId: number,
) {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id
     FROM phis.site_content
     WHERE site_id = $1
       AND id = $2
     LIMIT 1`,
    [siteId, contentId],
  );

  return Boolean(rows[0]);
}

async function normalizeRevisionContentWidgetsWithDb(
  db: PoolClient,
  siteId: number,
  widgets: CmsPageWriteInput["contentWidgets"] | CmsAreaPresetWriteInput["contentWidgets"],
  scope: {
    scopeKind: "page" | "area";
    areaMask: number;
    path?: string | null;
    createdByUserId?: number | null;
  },
) {
  const normalizedWidgets: typeof widgets = [];

  for (const widget of widgets) {
    const { contentBinding, ...inputWidget } = widget;
    let stableWidget = inputWidget;
    let contentId = stableWidget.contentId ?? null;
    // Every write below pins the version it appends; a widget that writes nothing keeps the pin it came
    // with, which is what makes discard and restore return the content of the revision they keep.
    let contentVersionId = stableWidget.contentVersionId ?? null;

    // Content is only swept once no revision names it, so an id that is not this Site's is a foreign or
    // forged one: refused, not swapped for a fresh row that silently cuts the widget from its content.
    if (contentId != null && !(await siteContentExistsOnSite(db, siteId, contentId))) {
      throw new Error(`Widget ${stableWidget.id} references unknown content ${contentId}.`);
    }

    if (contentBinding?.storage === "text") {
      const rawText = readWidgetContentBindingSourceValue(stableWidget.config, contentBinding, stableWidget.id);
      const { typeKey } = parseWidgetNamespacedTypeKey(stableWidget.widgetType);
      const contentWrite = await upsertSiteContentTextWithClient(db, {
        siteId,
        contentId,
        slug:
          contentId == null
            ? buildWidgetContentSlug(
                {
                  scopeKind: scope.scopeKind,
                  areaMask: scope.areaMask,
                  path: scope.path ?? null,
                },
                {
                  id: stableWidget.id,
                  label: stableWidget.label ?? null,
                },
                typeKey,
              )
            : null,
        text: rawText,
        status: stableWidget.status ?? 0,
        sortOrder: stableWidget.sortOrder ?? 0,
        meta: {},
        createdByUserId: scope.createdByUserId ?? null,
      });
      contentId = contentWrite.contentId;
      contentVersionId = contentWrite.versionId;
    } else if (contentBinding?.storage === "html") {
      const rawHtml = readWidgetContentBindingSourceValue(stableWidget.config, contentBinding, stableWidget.id);
      const { typeKey } = parseWidgetNamespacedTypeKey(stableWidget.widgetType);
      const contentWrite = await upsertSiteContentHtmlWithClient(db, {
        siteId,
        contentId,
        slug:
          contentId == null
            ? buildWidgetContentSlug(
                {
                  scopeKind: scope.scopeKind,
                  areaMask: scope.areaMask,
                  path: scope.path ?? null,
                },
                {
                  id: stableWidget.id,
                  label: stableWidget.label ?? null,
                },
                typeKey,
              )
            : null,
        html: rawHtml,
        status: stableWidget.status ?? 0,
        sortOrder: stableWidget.sortOrder ?? 0,
        meta: {},
        createdByUserId: scope.createdByUserId ?? null,
      });
      contentId = contentWrite.contentId;
      contentVersionId = contentWrite.versionId;
      await replaceSiteCmsReferencesWithDb(db, {
        siteId,
        sourceKind: PhiCmsReferenceSourceKind.Content,
        sourceScopeId: contentWrite.contentId,
        sourceRevisionId: contentWrite.versionId,
        references: collectSiteCmsContentReferences("html", contentWrite.html, {
          targetAreaId: scope.areaMask,
        }),
      });
      stableWidget = {
        ...stableWidget,
        config: {
          ...(stableWidget.config ?? {}),
          [contentBinding.sourceField]: contentWrite.html,
        },
      };
    } else if (contentBinding?.storage === "markdown") {
      const rawMarkdown = readWidgetContentBindingSourceValue(stableWidget.config, contentBinding, stableWidget.id);
      const { typeKey } = parseWidgetNamespacedTypeKey(stableWidget.widgetType);
      const contentWrite = await upsertSiteContentMarkdownWithClient(db, {
        siteId,
        contentId,
        slug:
          contentId == null
            ? buildWidgetContentSlug(
                {
                  scopeKind: scope.scopeKind,
                  areaMask: scope.areaMask,
                  path: scope.path ?? null,
                },
                {
                  id: stableWidget.id,
                  label: stableWidget.label ?? null,
                },
                typeKey,
              )
            : null,
        markdown: rawMarkdown,
        status: stableWidget.status ?? 0,
        sortOrder: stableWidget.sortOrder ?? 0,
        meta: {},
        createdByUserId: scope.createdByUserId ?? null,
      });
      contentId = contentWrite.contentId;
      contentVersionId = contentWrite.versionId;
      await replaceSiteCmsReferencesWithDb(db, {
        siteId,
        sourceKind: PhiCmsReferenceSourceKind.Content,
        sourceScopeId: contentWrite.contentId,
        sourceRevisionId: contentWrite.versionId,
        references: collectSiteCmsContentReferences("markdown", contentWrite.markdown, {
          targetAreaId: scope.areaMask,
        }),
      });
    } else if (contentBinding?.storage === "asset") {
      const assetId = readWidgetAssetContentBindingSourceValue(stableWidget.config, contentBinding, stableWidget.id);
      const asset = await getMediaAssetBySiteAndId(siteId, assetId);
      if (!asset) {
        throw new Error(`Widget ${stableWidget.id} references unknown media asset ${assetId}.`);
      }
      const { typeKey } = parseWidgetNamespacedTypeKey(stableWidget.widgetType);
      const contentWrite = await upsertSiteContentAssetWithClient(db, {
        siteId,
        contentId,
        assetId,
        title: asset.title,
        altText: asset.altText,
        slug:
          contentId == null
            ? buildWidgetContentSlug(
                {
                  scopeKind: scope.scopeKind,
                  areaMask: scope.areaMask,
                  path: scope.path ?? null,
                },
                {
                  id: stableWidget.id,
                  label: stableWidget.label ?? null,
                },
                typeKey,
              )
            : "",
        status: stableWidget.status ?? 0,
        sortOrder: stableWidget.sortOrder ?? 0,
        meta: {},
        createdByUserId: scope.createdByUserId ?? null,
      });
      contentId = contentWrite.contentId;
      contentVersionId = contentWrite.versionId;
    } else if (
      contentId == null
        ? contentVersionId != null
        : contentVersionId == null || !(await siteContentVersionBelongsTo(db, contentId, contentVersionId))
    ) {
      throw new Error(
        `Widget ${stableWidget.id} pins content version ${contentVersionId} that is not one of content ${contentId}.`,
      );
    }

    normalizedWidgets.push({
      ...stableWidget,
      contentId,
      contentVersionId,
      ...(contentBinding ? { contentBinding } : {}),
    });
  }

  return normalizedWidgets;
}

export async function saveSitePageDraftRevision(
  siteId: number,
  input: CmsPageWriteInput,
  options?: {
    createdByUserId?: number | null;
    message?: string | null;
    /** Create a Site Page: refuse with `SitePageExistsError`, writing nothing, if its path is held. */
    createOnly?: boolean;
  },
): Promise<{
  revisionId: number;
  path: string;
  areaMask: number;
  draft: SiteCmsDraftState;
  sourcePreset: CmsPageWriteInput["sourcePreset"];
}> {
  const { areaMask, draft: requestedDraft, ...revisionInput } = input;

  return withTransaction(async (client) => {
    const requestedScopeId = input.sourcePreset == null && Number.isInteger(input.page?.id) && (input.page?.id ?? 0) > 0
      ? input.page!.id
      : null;
    if (options?.createOnly) {
      if (input.sourcePreset != null || requestedScopeId != null) {
        throw new SitePagePathChangeError("invalid_path", "Only a Site Page addressed by its path can be created.");
      }
      await lockSitePageAddressesWithDb(client, siteId, areaMask);
      const held = await getSitePageScopeWithDb(client, siteId, areaMask, resolveSitePageScopeAddress(input));
      if (held) {
        throw new SitePageExistsError(held.id, held.path ?? normalizeSiteCmsPath(input.path), held.tombstonedAt != null);
      }
    }
    const scope = requestedScopeId == null
      ? await ensureSitePageScopeWithDb(client, siteId, areaMask, resolveSitePageScopeAddress(input))
      : await getSitePageScopeByIdWithDb(client, siteId, areaMask, requestedScopeId, { forUpdate: true });
    if (!scope) {
      throw new SiteCmsDraftConflictError("The requested Site Page Scope does not exist in this Site and Area.");
    }
    const sourceRevisionId = scope.workingDraftRevisionId ?? scope.publishedRevisionId ?? null;
    const sourceRevision = sourceRevisionId == null
      ? null
      : await getSiteRevisionByIdWithDb(client, PAGE, sourceRevisionId);
    if (sourceRevisionId != null && !sourceRevision) {
      throw new SiteCmsDraftConflictError(`CMS page revision #${sourceRevisionId} no longer exists.`);
    }
    const persistedDraft = scope.workingDraftRevisionId == null || !sourceRevision
      ? null
      : readSiteCmsDraftState(sourceRevision);
    if (persistedDraft) {
      assertSiteCmsDraftWriteState(persistedDraft, requestedDraft);
    } else if (requestedDraft) {
      throw new SiteCmsDraftConflictError(
        `Working Draft revision #${requestedDraft.revisionId} is no longer active.`,
      );
    }
    const sourceTree = sourceRevision ? readValidatedPageRevisionTree(sourceRevision.treeJson) : null;
    const normalizedWidgets = await normalizeRevisionContentWidgetsWithDb(client, siteId, input.contentWidgets, {
      scopeKind: "page",
      areaMask,
      path: scope.path ?? input.path,
      createdByUserId: options?.createdByUserId ?? null,
    });
    const nextRevisionInput = {
      ...revisionInput,
      path: scope.path ?? revisionInput.path,
      sourcePreset: resolveSnapshotPresetSource(sourceTree?.sourcePreset, revisionInput.sourcePreset),
      contentWidgets: normalizedWidgets,
    } satisfies Omit<CmsPageWriteInput, "areaMask">;
    const summary = buildPageRevisionSummary(
      {
        areaMask,
        ...nextRevisionInput,
      },
      sourceTree,
      sourceRevisionId,
    );
    const flags =
      PhiCmsRevisionFlags.Draft |
      (isDeletedPageRevision(input) ? PhiCmsRevisionFlags.Deleted : 0);
    const nextDraftMeta = {
      version: persistedDraft ? persistedDraft.version + 1 : 1,
      nextNodeSequence: requestedDraft?.nextNodeSequence ?? 1,
    };
    const revision = persistedDraft
      ? await updateSiteDraftRevisionWithDb(client, PAGE, persistedDraft.revisionId, scope.id, {
          flags,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          savedByUserId: options?.createdByUserId ?? null,
        })
      : await insertSiteRevisionWithDb(client, PAGE, {
          scopeId: scope.id,
          flags,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          sourceRevisionId,
          createdByUserId: options?.createdByUserId ?? null,
        });
    // No tombstone here. A draft that marks the Page deleted says what the next publish will do, and the
    // tombstone is what the live Site reads; writing it on the save took the Page off the Site before
    // anybody published the deletion, and moved the Site read marker while doing it.
    await setSiteRevisionScopePointersWithDb(client, PAGE, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: revision.id,
    });
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Page,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(nextRevisionInput, { targetAreaId: areaMask }),
    });
    // A widget removed by this save may leave its content row orphaned. The candidates are the ids
    // this save dropped; the delete itself re-checks them against every revision of the Site, so
    // anything still restorable survives.
    const nextContentIds = new Set(collectRevisionContentIds(nextRevisionInput));
    await deleteOrphanedSiteContentByIdsWithDb(
      client,
      siteId,
      collectRevisionContentIds(sourceTree).filter((id) => !nextContentIds.has(id)),
    );

    return {
      revisionId: revision.id,
      path: scope.path ?? normalizeSiteCmsPath(input.path),
      areaMask,
      draft: readSiteCmsDraftState(revision),
      sourcePreset: nextRevisionInput.sourcePreset,
    };
  });
}

export async function saveSiteAreaDraftRevision(
  siteId: number,
  input: CmsAreaPresetWriteInput,
  options?: {
    createdByUserId?: number | null;
    message?: string | null;
  },
): Promise<{
  revisionId: number;
  areaMask: number;
  draft: SiteCmsDraftState;
  sourcePreset: CmsAreaPresetWriteInput["sourcePreset"];
}> {
  const { areaMask, draft: requestedDraft, ...revisionInput } = input;

  return withTransaction(async (client) => {
    const scope = await ensureSiteAreaScopeWithDb(client, siteId, areaMask);
    const sourceRevisionId = scope.workingDraftRevisionId ?? scope.publishedRevisionId ?? null;
    const sourceRevision = sourceRevisionId == null
      ? null
      : await getSiteRevisionByIdWithDb(client, AREA, sourceRevisionId);
    if (sourceRevisionId != null && !sourceRevision) {
      throw new SiteCmsDraftConflictError(`CMS area revision #${sourceRevisionId} no longer exists.`);
    }
    const persistedDraft = scope.workingDraftRevisionId == null || !sourceRevision
      ? null
      : readSiteCmsDraftState(sourceRevision);
    if (persistedDraft) {
      assertSiteCmsDraftWriteState(persistedDraft, requestedDraft);
    } else if (requestedDraft) {
      throw new SiteCmsDraftConflictError(
        `Working Draft revision #${requestedDraft.revisionId} is no longer active.`,
      );
    }
    const sourceTree = sourceRevision ? readValidatedAreaRevisionTree(sourceRevision.treeJson) : null;
    const normalizedWidgets = await normalizeRevisionContentWidgetsWithDb(client, siteId, input.contentWidgets, {
      scopeKind: "area",
      areaMask,
      createdByUserId: options?.createdByUserId ?? null,
    });
    const nextRevisionInput = {
      ...revisionInput,
      sourcePreset: resolveSnapshotPresetSource(sourceTree?.sourcePreset, revisionInput.sourcePreset),
      contentWidgets: normalizedWidgets,
    } satisfies Omit<CmsAreaPresetWriteInput, "areaMask">;
    const summary = buildAreaRevisionSummary(
      {
        areaMask,
        ...nextRevisionInput,
      },
      sourceTree,
      sourceRevisionId,
    );
    const nextDraftMeta = {
      version: persistedDraft ? persistedDraft.version + 1 : 1,
      nextNodeSequence: requestedDraft?.nextNodeSequence ?? 1,
    };
    const revision = persistedDraft
      ? await updateSiteDraftRevisionWithDb(client, AREA, persistedDraft.revisionId, scope.id, {
          flags: PhiCmsRevisionFlags.Draft,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          savedByUserId: options?.createdByUserId ?? null,
        })
      : await insertSiteRevisionWithDb(client, AREA, {
          scopeId: scope.id,
          flags: PhiCmsRevisionFlags.Draft,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          sourceRevisionId,
          createdByUserId: options?.createdByUserId ?? null,
        });
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: revision.id,
    });
    // The Area's own tree is a reference source in its own right: a Page or Asset reference sitting in
    // Region or widget config carries no content binding, so the Content source never sees it.
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Area,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(nextRevisionInput, { targetAreaId: areaMask }),
    });
    const nextAreaContentIds = new Set(collectRevisionContentIds(nextRevisionInput));
    await deleteOrphanedSiteContentByIdsWithDb(
      client,
      siteId,
      collectRevisionContentIds(sourceTree).filter((id) => !nextAreaContentIds.has(id)),
    );

    return {
      revisionId: revision.id,
      areaMask,
      draft: readSiteCmsDraftState(revision),
      sourcePreset: nextRevisionInput.sourcePreset,
    };
  });
}

/**
 * Makes a pending path real, in the transaction that publishes the Page.
 *
 * This is the only place a live Site address changes, which is what lets one comparison here answer the
 * redirect question for renamed Pages and moved Module addresses alike. The unique index decides: a
 * pending path that lost its address between the rename and the publish fails here rather than
 * overwriting the Page that took it.
 */
async function promoteSitePageDraftPathWithDb(
  db: DbQueryable,
  scope: SitePageScopeRecord,
): Promise<{ movedFrom: string; movedTo: string } | null> {
  if (scope.draftPath == null) {
    return null;
  }
  if (scope.draftPath === scope.path) {
    await db.query(`UPDATE phis.site_page_scopes SET draft_path = NULL WHERE id = $1`, [scope.id]);
    return null;
  }
  // The pending path was free when it was proposed; a Page created or moved since may have taken it or
  // settled beneath it, and publishing is where the address actually changes.
  await lockSitePageAddressesWithDb(db, scope.siteId, scope.areaMask);
  await assertSitePageAddressFreeWithDb(db, scope.siteId, scope.areaMask, scope.draftPath, scope.id);
  try {
    await db.query(
      `UPDATE phis.site_page_scopes SET path = draft_path, draft_path = NULL, updated_at = NOW() WHERE id = $1`,
      [scope.id],
    );
  } catch (error) {
    throw toSitePagePathCollisionError(error);
  }
  return { movedFrom: scope.path ?? "", movedTo: scope.draftPath };
}

/**
 * Writes the published deletion state, in the transaction that publishes the Page.
 *
 * The tombstone is the Site's copy of "this Page is gone": published listings, Navigation targets, the
 * sitemap and Module usage all read it, and it moves the Site read marker so every Site process notices.
 * That makes it published state, and publishing the only thing allowed to write it -- a Page marked for
 * deletion in a draft keeps answering until the deletion is published, and discarding that draft leaves
 * this column exactly as the last publish left it.
 *
 * The time is kept once. Publishing a deleted Page again republishes the same deletion rather than
 * restating when it happened, and clearing it is the restore: a publish whose revision is not deleted
 * says the Page is back.
 */
async function setSitePageScopeTombstoneWithDb(db: DbQueryable, scopeId: number, deleted: boolean) {
  await db.query(
    `UPDATE phis.site_page_scopes
     SET tombstoned_at = CASE WHEN $2 THEN COALESCE(tombstoned_at, NOW()) ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1`,
    [scopeId, deleted],
  );
}

export async function publishSitePageRevision(
  siteId: number,
  input: {
    areaMask: number;
    address: SitePageScopeAddress;
    revisionId?: number | null;
  },
  options?: {
    createdByUserId?: number | null;
    locale?: string | null;
  },
): Promise<{
  revisionId: number;
  page: SiteResolvedWidgetTree;
  /** The address this publish actually moved, so the audit trail names it where it happened. */
  moved: { movedFrom: string; movedTo: string } | null;
}> {
  return withTransaction(async (client) => {
    const scope = await getSitePageScopeWithDb(client, siteId, input.areaMask, input.address, {
      forUpdate: true,
    });
    if (!scope) {
      throw new Error("No page draft scope found.");
    }

    // Publishing makes a revision live and clears the Working Draft, so it takes that Draft and nothing
    // else: an older revision named here would drop the Draft unsaid. An old revision goes live by being
    // restored into a Draft first.
    assertPublishesWorkingDraft(input.revisionId, scope, "Page");
    const revisionId = input.revisionId ?? scope.workingDraftRevisionId;
    if (!Number.isInteger(revisionId) || (revisionId as number) <= 0) {
      /*
       * A rename on its own writes no revision, so this is a real state and not a mistake: there is a
       * pending address and nothing else to publish. The Page keeps the revision it already had.
       */
      const movedOnly = await promoteSitePageDraftPathWithDb(client, scope);
      if (movedOnly && scope.publishedRevisionId != null) {
        const publishedRevision = await getSiteRevisionByIdWithDb(
          client,
          PAGE,
          scope.publishedRevisionId,
        );
        if (!publishedRevision || publishedRevision.scopeId !== scope.id) {
          throw new Error("Published page revision pointer belongs to a different scope.");
        }
        const movedPage = await buildResolvedPageTreeFromRevisionWithDb(
          client,
          siteId,
          { ...scope, path: movedOnly.movedTo, draftPath: null },
          readValidatedPageRevisionTree(publishedRevision.treeJson),
          options?.locale ?? null,
        );
        return { revisionId: publishedRevision.id, page: movedPage, moved: movedOnly };
      }
      throw new Error("No page draft revision available to publish.");
    }

    const revision = await getSiteRevisionByIdWithDb(client, PAGE, revisionId as number);
    if (!revision || revision.scopeId !== scope.id) {
      throw new Error("Page draft revision not found for the requested scope.");
    }

    const revisionTree = readValidatedPageRevisionTree(revision.treeJson);
    const previousPublishedRevision =
      scope.publishedRevisionId == null
        ? null
        : await getSiteRevisionByIdWithDb(client, PAGE, scope.publishedRevisionId);
    if (previousPublishedRevision && previousPublishedRevision.scopeId !== scope.id) {
      throw new Error("Published page revision pointer belongs to a different scope.");
    }
    const materializedTree = validateCmsPageRevisionForPublish(revisionTree);
    const materializedTreeJson = { ...materializedTree } as Record<string, unknown>;
    delete materializedTreeJson.areaMask;
    const page = await buildResolvedPageTreeFromRevisionWithDb(
      client,
      siteId,
      scope,
      materializedTree,
      options?.locale ?? null,
    );

    const deleted = isDeletedPageRevision(revisionTree, revision.flags);
    const nextFlags =
      PhiCmsRevisionFlags.Published |
      (deleted ? PhiCmsRevisionFlags.Deleted : 0);
    await writePublishedSiteRevisionWithDb(client, PAGE, revision.id, {
      flags: nextFlags,
      treeJson: materializedTreeJson,
    });
    await setSiteRevisionScopePointersWithDb(client, PAGE, scope.id, {
      publishedRevisionId: revision.id,
      workingDraftRevisionId: null,
    });
    await setSitePageScopeTombstoneWithDb(client, scope.id, deleted);
    const moved = await promoteSitePageDraftPathWithDb(client, scope);
    return {
      revisionId: revision.id,
      page,
      moved,
    };
  });
}

/** The Module ids a stored Area preset config carries, in the shape a diff can compare. */
function readAreaConfigModuleIds(config: Record<string, unknown> | undefined) {
  const value = readPhiAreaConfigNamespace(config, PHI_AREA_CONFIG_MODULES_NAMESPACE)?.runtimeModules;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * What changed about an Area's Module selection, written where a reviewer will look.
 *
 * The point of keeping this in the Area's own revision list is that a publisher sees the change without
 * opening anything, so the summary names the Modules rather than counting nodes: an Area revision whose
 * message says two Modules were added is a different kind of change than one that moved a widget.
 */
function buildAreaModulesRevisionSummary(
  nextConfig: Record<string, unknown>,
  sourceConfig: Record<string, unknown> | undefined,
  sourceRevisionId: number | null,
) {
  const before = readAreaConfigModuleIds(sourceConfig);
  const after = readAreaConfigModuleIds(nextConfig);
  const added = after.filter((moduleId) => !before.includes(moduleId));
  const removed = before.filter((moduleId) => !after.includes(moduleId));
  const changedCount = added.length + removed.length;

  return {
    message: changedCount > 0
      ? `Area Modules changed (+${added.length}/-${removed.length})`
      : "Area Modules saved",
    metaJson: {
      messageKey: changedCount > 0 ? "area_modules_changed" : "area_modules_saved",
      sourceRevisionId,
      origin: sourceRevisionId == null ? "new" : "revision",
      changeKinds: changedCount > 0 ? ["modules"] : [],
      modules: { added, removed },
    },
  };
}

/**
 * Replaces an Area revision's preset config, and nothing else.
 *
 * `areaMask` and `draft` are dropped because neither belongs in a stored tree: the mask is derived from
 * `area` when the payload is read back, and the draft state lives in `meta_json`.
 */
function withAreaPresetConfig(tree: CmsAreaPresetWriteInput, config: Record<string, unknown>) {
  const revisionInput: Omit<CmsAreaPresetWriteInput, "areaMask" | "draft"> & {
    areaMask?: number;
    draft?: CmsDraftWriteState;
  } = {
    ...tree,
    preset: { ...(tree.preset ?? {}), config },
  };
  delete revisionInput.areaMask;
  delete revisionInput.draft;
  return revisionInput;
}

/**
 * Saves the Area's Module selection as its own Working Draft.
 *
 * It patches rather than writes: the source revision's tree is carried over untouched and only
 * `preset.config` is replaced. So a Module save cannot move a widget, and the two drafts an Area can
 * have open -- structure and Modules -- never contain each other's unpublished work.
 *
 * The source is the Module draft if one is open, and otherwise the published revision. A Site that has
 * never persisted this Area has neither, and runs on the code-owned Shell preset that lives in
 * `@phis/ui`; this process cannot render that, so the caller sends it as `baseline` and it is used only
 * in that case.
 */
export async function saveSiteAreaModulesDraftRevision(
  siteId: number,
  input: CmsAreaModulesWriteInput,
  options?: {
    createdByUserId?: number | null;
    message?: string | null;
  },
): Promise<{
  revisionId: number;
  areaMask: number;
  draft: SiteCmsDraftState;
  sourcePreset: CmsAreaModulesWriteInput["sourcePreset"];
}> {
  const { areaMask, draft: requestedDraft } = input;

  return withTransaction(async (client) => {
    const scope = await ensureSiteAreaScopeWithDb(client, siteId, areaMask);
    const sourceRevisionId = scope.workingModuleDraftRevisionId ?? scope.publishedRevisionId ?? null;
    const sourceRevision = sourceRevisionId == null
      ? null
      : await getSiteRevisionByIdWithDb(client, AREA, sourceRevisionId);
    if (sourceRevisionId != null && !sourceRevision) {
      throw new SiteCmsDraftConflictError(`CMS area revision #${sourceRevisionId} no longer exists.`);
    }
    const persistedDraft = scope.workingModuleDraftRevisionId == null || !sourceRevision
      ? null
      : readSiteCmsDraftState(sourceRevision);
    if (persistedDraft) {
      assertSiteCmsDraftWriteState(persistedDraft, requestedDraft);
    } else if (requestedDraft) {
      throw new SiteCmsDraftConflictError(
        `Working Draft revision #${requestedDraft.revisionId} is no longer active.`,
      );
    }

    const sourceTree = sourceRevision
      ? readValidatedAreaRevisionTree(sourceRevision.treeJson)
      : input.baseline ?? null;
    if (!sourceTree) {
      throw new SiteCmsAreaBaselineRequiredError();
    }
    if (!hasSamePresetIdentity(sourceTree.sourcePreset, input.sourcePreset)) {
      throw new Error("Area preset identity does not match the requested scope.");
    }

    const nextRevisionInput = withAreaPresetConfig(sourceTree, input.config);
    const summary = buildAreaModulesRevisionSummary(
      input.config,
      sourceTree.preset?.config,
      sourceRevisionId,
    );
    const nextDraftMeta = {
      version: persistedDraft ? persistedDraft.version + 1 : 1,
      // Carried, not counted: a Module save adds no nodes, so the sequence is whatever the structure
      // side has reached.
      nextNodeSequence: requestedDraft?.nextNodeSequence ?? persistedDraft?.nextNodeSequence ?? 1,
    };
    const revision = persistedDraft
      ? await updateSiteDraftRevisionWithDb(client, AREA, persistedDraft.revisionId, scope.id, {
          flags: PhiCmsRevisionFlags.Draft,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          savedByUserId: options?.createdByUserId ?? null,
        })
      : await insertSiteRevisionWithDb(client, AREA, {
          scopeId: scope.id,
          flags: PhiCmsRevisionFlags.Draft,
          treeJson: nextRevisionInput as unknown as Record<string, unknown>,
          message: options?.message ?? summary.message,
          metaJson: withSiteCmsDraftMeta(summary.metaJson, nextDraftMeta),
          sourceRevisionId,
          createdByUserId: options?.createdByUserId ?? null,
        });
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: scope.workingDraftRevisionId,
      workingModuleDraftRevisionId: revision.id,
    });
    // The carried tree carries its references with it: this revision holds the same Page and Asset
    // references as the one it was cloned from, and a revision that registered none would let a delete
    // guard read it as referencing nothing.
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Area,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(nextRevisionInput, { targetAreaId: areaMask }),
    });
    // No orphan sweep: a Module save creates no Content, it carries the source revision's widgets
    // unchanged. What it would collect are rows the published revision still uses.

    return {
      revisionId: revision.id,
      areaMask,
      draft: readSiteCmsDraftState(revision),
      sourcePreset: nextRevisionInput.sourcePreset,
    };
  });
}

export async function publishSiteAreaRevision(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: SitePresetIdentity;
    revisionId?: number | null;
  },
  options?: {
    createdByUserId?: number | null;
    locale?: string | null;
  },
): Promise<{ revisionId: number; preset: SiteResolvedAreaPresetTree }> {

  return withTransaction(async (client) => {
    const scope = await getSiteAreaScopeWithDb(client, siteId, input.areaMask, {
      forUpdate: true,
    });
    if (!scope) {
      throw new Error("No area draft scope found.");
    }

    assertPublishesWorkingDraft(input.revisionId, scope, "Area");
    const revisionId = input.revisionId ?? scope.workingDraftRevisionId;
    if (!Number.isInteger(revisionId) || (revisionId as number) <= 0) {
      throw new Error("No area draft revision available to publish.");
    }

    const revision = await getSiteRevisionByIdWithDb(client, AREA, revisionId as number);
    if (!revision || revision.scopeId !== scope.id) {
      throw new Error("Area draft revision not found for the requested scope.");
    }

    const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
    if (!hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
      throw new Error("Area draft preset identity does not match the requested scope.");
    }
    const previousPublishedRevision =
      scope.publishedRevisionId == null
        ? null
        : await getSiteRevisionByIdWithDb(client, AREA, scope.publishedRevisionId);
    if (previousPublishedRevision && previousPublishedRevision.scopeId !== scope.id) {
      throw new Error("Published area revision pointer belongs to a different scope.");
    }
    const mergedTree = mergePhiAreaTreeForPublish(
      previousPublishedRevision
        ? readValidatedAreaRevisionTree(previousPublishedRevision.treeJson)
        : null,
      revisionTree,
      "structure",
    );
    const materializedTree = validateCmsAreaRevisionForPublish(mergedTree);
    const materializedTreeJson = { ...materializedTree } as Record<string, unknown>;
    delete materializedTreeJson.areaMask;
    const preset = await buildResolvedAreaTreeFromRevisionWithDb(
      client,
      siteId,
      scope,
      materializedTree,
      options?.locale ?? null,
    );

    await writePublishedSiteRevisionWithDb(client, AREA, revision.id, {
      flags: PhiCmsRevisionFlags.Published,
      treeJson: materializedTreeJson,
    });
    // The same reason the Module publish rewrites them: the merge replaced this revision's tree, so
    // what it references changed with it. A structure draft is cloned from what was published and
    // then keeps its own copy of `config.modules` while a Module publish moves that config on; the
    // merge takes the published one back, and the rows written for the draft's copy name whatever
    // picture the Module had at clone time. Left alone, the picture now published is in no index and
    // the one nobody uses any more is what the guard protects.
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Area,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(materializedTree, { targetAreaId: input.areaMask }),
    });
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: revision.id,
      workingDraftRevisionId: null,
    });
    // Ordinarily this publish no longer decides which Modules the Site runs -- it took that config from
    // the published revision. The exception is the first publish of an Area, where there is nothing to
    // take it from and the draft's own config is what becomes real. So the availability is settled here
    // too, inside the same transaction: the pointer and what it implies must never be observable apart.
    await materializeSiteMediaAvailabilityWithDb(client, siteId);
    await materializeSiteThreadKindsWithDb(client, siteId);
    await materializeSiteModuleSeedsWithDb(client, siteId);

    return {
      revisionId: revision.id,
      preset,
    };
  });
}

/**
 * Publishes the Area's Module selection without publishing its structure.
 *
 * The mirror image of the rule in `publishSiteAreaRevision`: the tree comes from the published revision
 * and only `preset.config` comes from this draft. Two drafts left open therefore cannot overtake each
 * other -- whichever is published second is merged onto what the first left behind, in either order.
 */
export async function publishSiteAreaModulesRevision(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: SitePresetIdentity;
    revisionId?: number | null;
  },
  options?: {
    createdByUserId?: number | null;
    locale?: string | null;
  },
): Promise<{ revisionId: number; preset: SiteResolvedAreaPresetTree }> {

  return withTransaction(async (client) => {
    const scope = await getSiteAreaScopeWithDb(client, siteId, input.areaMask, { forUpdate: true });
    if (!scope) {
      throw new Error("No area draft scope found.");
    }

    assertPublishesWorkingDraft(
      input.revisionId,
      {
        workingDraftRevisionId: scope.workingModuleDraftRevisionId,
        publishedRevisionId: scope.publishedRevisionId,
      },
      "Area Module",
    );
    const revisionId = input.revisionId ?? scope.workingModuleDraftRevisionId;
    if (!Number.isInteger(revisionId) || (revisionId as number) <= 0) {
      throw new Error("No Area Module draft revision available to publish.");
    }

    const revision = await getSiteRevisionByIdWithDb(client, AREA, revisionId as number);
    if (!revision || revision.scopeId !== scope.id) {
      throw new Error("Area Module draft revision not found for the requested scope.");
    }

    const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
    if (!hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
      throw new Error("Area draft preset identity does not match the requested scope.");
    }
    const previousPublishedRevision =
      scope.publishedRevisionId == null
        ? null
        : await getSiteRevisionByIdWithDb(client, AREA, scope.publishedRevisionId);
    if (previousPublishedRevision && previousPublishedRevision.scopeId !== scope.id) {
      throw new Error("Published area revision pointer belongs to a different scope.");
    }

    const mergedTree = mergePhiAreaTreeForPublish(
      previousPublishedRevision
        ? readValidatedAreaRevisionTree(previousPublishedRevision.treeJson)
        : null,
      revisionTree,
      "modules",
    );
    const materializedTree = validateCmsAreaRevisionForPublish(mergedTree);
    const materializedTreeJson = { ...materializedTree } as Record<string, unknown>;
    delete materializedTreeJson.areaMask;
    const preset = await buildResolvedAreaTreeFromRevisionWithDb(
      client,
      siteId,
      scope,
      materializedTree,
      options?.locale ?? null,
    );

    await writePublishedSiteRevisionWithDb(client, AREA, revision.id, {
      flags: PhiCmsRevisionFlags.Published,
      treeJson: materializedTreeJson,
    });
    // The merge replaced this revision's tree with the published one, so what it references changed
    // with it. The structure draft keeps its pointer: publishing Modules must not discard it.
    await replaceSiteCmsReferencesWithDb(client, {
      siteId,
      sourceKind: PhiCmsReferenceSourceKind.Area,
      sourceScopeId: scope.id,
      sourceRevisionId: revision.id,
      references: collectSiteCmsReferences(materializedTree, { targetAreaId: input.areaMask }),
    });
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: revision.id,
      workingDraftRevisionId: scope.workingDraftRevisionId,
      workingModuleDraftRevisionId: null,
    });
    // Which Modules a Site runs is what settles which Media Space kinds it offers, and this is now the
    // publish that changes it. Inside the same transaction: the pointer and the availability it implies
    // must never be observable apart.
    await materializeSiteMediaAvailabilityWithDb(client, siteId);
    await materializeSiteThreadKindsWithDb(client, siteId);
    await materializeSiteModuleSeedsWithDb(client, siteId);

    return {
      revisionId: revision.id,
      preset,
    };
  });
}

export async function getSitePageDraftRevisionPreview(
  siteId: number,
  revisionId: number,
  input: {
    areaMask: number;
    address: SitePageScopeAddress;
    locale?: string | null;
  },
): Promise<{ revisionId: number; tree: SiteResolvedWidgetTree } | null> {
  const revision = await getSiteRevisionByIdWithDb(getPool(), PAGE, revisionId);
  if (!revision || !hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Draft)) {
    return null;
  }

  const scope = await getSitePageScopeWithDb(getPool(), siteId, input.areaMask, input.address);
  if (!scope || scope.id !== revision.scopeId) {
    return null;
  }

  return {
    revisionId,
    tree: await buildResolvedPageTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      readValidatedPageRevisionTree(revision.treeJson),
      input.locale ?? null,
    ),
  };
}

export async function getSitePageRevisionReview(
  siteId: number,
  revisionId: number,
  input: {
    areaMask: number;
    address: SitePageScopeAddress;
    locale?: string | null;
  },
): Promise<{ revisionId: number; tree: SiteResolvedWidgetTree } | null> {
  const revision = await getSiteRevisionByIdWithDb(getPool(), PAGE, revisionId);
  if (!revision) {
    return null;
  }

  const scope = await getSitePageScopeWithDb(getPool(), siteId, input.areaMask, input.address);
  if (!scope || scope.id !== revision.scopeId) {
    return null;
  }

  return {
    revisionId,
    tree: await buildResolvedPageTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      readValidatedPageRevisionTree(revision.treeJson),
      input.locale ?? null,
    ),
  };
}

export async function getSiteCurrentPageDraft(
  siteId: number,
  input: {
    areaMask: number;
    address: SitePageScopeAddress;
    locale?: string | null;
  },
): Promise<{ revisionId: number; draft: SiteCmsDraftState; tree: SiteResolvedWidgetTree } | null> {
  const scope = await getSitePageScopeWithDb(getPool(), siteId, input.areaMask, input.address);
  if (!scope || scope.workingDraftRevisionId == null) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(getPool(), PAGE, scope.workingDraftRevisionId);
  if (
    !revision ||
    !hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Draft) ||
    revision.scopeId !== scope.id
  ) {
    return null;
  }

  return {
    revisionId: revision.id,
    draft: readSiteCmsDraftState(revision),
    tree: await buildResolvedPageTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      readValidatedPageRevisionTree(revision.treeJson),
      input.locale ?? null,
    ),
  };
}

export async function getSiteAreaDraftRevisionPreview(
  siteId: number,
  revisionId: number,
  input: {
    areaMask: number;
    sourcePreset?: SitePresetIdentity | null;
  },
): Promise<{ revisionId: number; preset: SiteResolvedAreaPresetTree } | null> {
  const revision = await getSiteRevisionByIdWithDb(getPool(), AREA, revisionId);
  if (!revision || !hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Draft)) {
    return null;
  }

  const scope = await getSiteAreaScopeWithDb(getPool(), siteId, input.areaMask);
  if (!scope || scope.id !== revision.scopeId) {
    return null;
  }

  const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
  if (input.sourcePreset && !hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
    return null;
  }

  return {
    revisionId,
    preset: await buildResolvedAreaTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      revisionTree,
      null,
    ),
  };
}

export async function getSiteAreaRevisionReview(
  siteId: number,
  revisionId: number,
  input: {
    areaMask: number;
    sourcePreset?: SitePresetIdentity | null;
  },
): Promise<{ revisionId: number; preset: SiteResolvedAreaPresetTree } | null> {
  const revision = await getSiteRevisionByIdWithDb(getPool(), AREA, revisionId);
  if (!revision) {
    return null;
  }

  const scope = await getSiteAreaScopeWithDb(getPool(), siteId, input.areaMask);
  if (!scope || scope.id !== revision.scopeId) {
    return null;
  }

  const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
  if (input.sourcePreset && !hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
    return null;
  }

  return {
    revisionId,
    preset: await buildResolvedAreaTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      revisionTree,
      null,
    ),
  };
}

export async function getSiteCurrentAreaDraft(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset?: SitePresetIdentity | null;
  },
): Promise<{ revisionId: number; draft: SiteCmsDraftState; preset: SiteResolvedAreaPresetTree } | null> {
  const scope = await getSiteAreaScopeWithDb(getPool(), siteId, input.areaMask);
  if (!scope || scope.workingDraftRevisionId == null) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(getPool(), AREA, scope.workingDraftRevisionId);
  if (
    !revision ||
    !hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Draft) ||
    revision.scopeId !== scope.id
  ) {
    return null;
  }

  const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
  if (input.sourcePreset && !hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
    return null;
  }

  return {
    revisionId: revision.id,
    draft: readSiteCmsDraftState(revision),
    preset: await buildResolvedAreaTreeFromRevisionWithDb(
      getPool(),
      siteId,
      scope,
      revisionTree,
      null,
    ),
  };
}

/** The Area's open Module draft, if it has one. Its structure draft is a separate question. */
export async function getSiteCurrentAreaModulesDraft(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset?: SitePresetIdentity | null;
  },
): Promise<{ revisionId: number; draft: SiteCmsDraftState; preset: SiteResolvedAreaPresetTree } | null> {
  const scope = await getSiteAreaScopeWithDb(getPool(), siteId, input.areaMask);
  if (!scope || scope.workingModuleDraftRevisionId == null) {
    return null;
  }

  const revision = await getSiteRevisionByIdWithDb(getPool(), AREA, scope.workingModuleDraftRevisionId);
  if (
    !revision ||
    !hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Draft) ||
    revision.scopeId !== scope.id
  ) {
    return null;
  }

  const revisionTree = readValidatedAreaRevisionTree(revision.treeJson);
  if (input.sourcePreset && !hasSamePresetIdentity(revisionTree.sourcePreset, input.sourcePreset)) {
    return null;
  }

  return {
    revisionId: revision.id,
    draft: readSiteCmsDraftState(revision),
    preset: await buildResolvedAreaTreeFromRevisionWithDb(getPool(), siteId, scope, revisionTree, null),
  };
}

/**
 * Discards the Area's Module draft.
 *
 * No orphan sweep, unlike the structure draft: this revision only ever carried a copy of another
 * revision's widgets, so collecting its Content ids would collect rows the published revision uses.
 */
export async function deleteSiteAreaModulesDraftRevision(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: SitePresetIdentity;
  },
): Promise<{ deleted: boolean }> {
  return withTransaction(async (client) => {
    const scope = await getSiteAreaScopeWithDb(client, siteId, input.areaMask);
    if (!scope || scope.workingModuleDraftRevisionId == null) {
      return { deleted: false };
    }

    const revision = await getSiteRevisionByIdWithDb(client, AREA, scope.workingModuleDraftRevisionId);
    if (!revision || !hasSamePresetIdentity(
      readValidatedAreaRevisionTree(revision.treeJson).sourcePreset,
      input.sourcePreset,
    )) {
      throw new Error("Area draft preset identity does not match the requested scope.");
    }
    await deleteSiteRevisionsWithDb(client, AREA, scope.id, [scope.workingModuleDraftRevisionId]);
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: scope.workingDraftRevisionId,
      workingModuleDraftRevisionId: null,
    });
    return { deleted: true };
  });
}

export async function deleteSitePageDraftRevision(
  siteId: number,
  input: {
    areaMask: number;
    address: SitePageScopeAddress;
  },
): Promise<{ deleted: boolean }> {
  return withTransaction(async (client) => {
    const scope = await getSitePageScopeWithDb(client, siteId, input.areaMask, input.address);
    if (!scope) {
      return { deleted: false };
    }
    /*
     * A pending path is part of the draft and goes with it. A rename on its own writes no revision, so
     * this is also the only thing there is to discard in that case.
     */
    const discardedPendingPath = scope.draftPath != null;
    if (discardedPendingPath) {
      await client.query(`UPDATE phis.site_page_scopes SET draft_path = NULL WHERE id = $1`, [scope.id]);
    }
    if (scope.workingDraftRevisionId == null) {
      return { deleted: discardedPendingPath };
    }

    /*
     * The draft goes and the published row stays as it was, tombstone included: a discarded deletion was
     * never published, and a discarded restore does not undo the deletion that was. Nothing is cleared
     * here -- `setSitePageScopeTombstoneWithDb` runs on publish and nowhere else.
     */
    const removedDraft = await deleteSiteRevisionsWithDb(client, PAGE, scope.id, [
      scope.workingDraftRevisionId,
    ]);
    await deleteOrphanedSiteContentByIdsWithDb(
      client,
      siteId,
      collectRevisionContentIds(removedDraft.trees[0] ?? null),
    );
    await setSiteRevisionScopePointersWithDb(client, PAGE, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: null,
    });
    return { deleted: true };
  });
}

export async function deleteSiteAreaDraftRevision(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: SitePresetIdentity;
  },
): Promise<{ deleted: boolean }> {
  return withTransaction(async (client) => {
    const scope = await getSiteAreaScopeWithDb(client, siteId, input.areaMask);
    if (!scope || scope.workingDraftRevisionId == null) {
      return { deleted: false };
    }

    const revision = await getSiteRevisionByIdWithDb(client, AREA, scope.workingDraftRevisionId);
    if (!revision || !hasSamePresetIdentity(
      readValidatedAreaRevisionTree(revision.treeJson).sourcePreset,
      input.sourcePreset,
    )) {
      throw new Error("Area draft preset identity does not match the requested scope.");
    }
    const removedAreaDraft = await deleteSiteRevisionsWithDb(client, AREA, scope.id, [
      scope.workingDraftRevisionId,
    ]);
    await deleteOrphanedSiteContentByIdsWithDb(
      client,
      siteId,
      collectRevisionContentIds(removedAreaDraft.trees[0] ?? null),
    );
    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: null,
    });
    return { deleted: true };
  });
}

/**
 * Removes the Site's own Area shell entirely, so the Module preset is what the Area resolves to again.
 *
 * The draft delete beside this one only ever discarded the working copy, which left the published
 * revision standing: once an Area had been published, nothing could take the Site back to the preset it
 * started from. That is what made a preset improvement invisible to any Site that had saved its shell
 * once -- and, worse, unnoticeable, because the Area still rendered.
 *
 * Absence is the answer here rather than an empty tree. A Scope with no revisions reads as "this Site
 * states no shell of its own", which is what the resolver already treats as a fall through to the
 * preset; a published revision holding empty lists is the different, deliberate answer "this Site has a
 * shell and it is empty", and that one is reached by publishing an empty draft, not by this call.
 */
export async function deleteSiteAreaOverride(
  siteId: number,
  input: {
    areaMask: number;
    sourcePreset: SitePresetIdentity;
  },
): Promise<{ deleted: boolean }> {
  return withTransaction(async (client) => {
    const scope = await getSiteAreaScopeWithDb(client, siteId, input.areaMask, { forUpdate: true });
    if (!scope) {
      return { deleted: false };
    }

    /*
     * The identity is checked against what the Area actually stands on -- its published revision, or its
     * draft where nothing is published yet. A caller naming a different preset is asking about an Area
     * this is not, and deleting on that request would remove a shell nobody asked about.
     */
    const identityRevisionId = scope.publishedRevisionId ?? scope.workingDraftRevisionId;
    if (identityRevisionId != null) {
      const revision = await getSiteRevisionByIdWithDb(client, AREA, identityRevisionId);
      if (!revision || !hasSamePresetIdentity(
        readValidatedAreaRevisionTree(revision.treeJson).sourcePreset,
        input.sourcePreset,
      )) {
        throw new Error("Area preset identity does not match the requested scope.");
      }
    }

    await setSiteAreaScopePointersWithDb(client, scope.id, {
      publishedRevisionId: null,
      workingDraftRevisionId: null,
      workingModuleDraftRevisionId: null,
    });
    const removed = await client.query<{ tree_json: Record<string, unknown> }>(
      `DELETE FROM phis.site_area_revisions WHERE area_scope_id = $1 RETURNING tree_json`,
      [scope.id],
    );
    for (const row of removed.rows) {
      await deleteOrphanedSiteContentByIdsWithDb(
        client,
        siteId,
        collectRevisionContentIds(row.tree_json ?? null),
      );
    }
    await client.query(
      `DELETE FROM phis.site_area_scopes
       WHERE id = $1
         AND published_revision_id IS NULL
         AND working_draft_revision_id IS NULL
         AND working_module_draft_revision_id IS NULL`,
      [scope.id],
    );
    return { deleted: removed.rowCount != null && removed.rowCount > 0 };
  });
}

export async function getExactSiteAreaPresetTree(
  siteId: number,
  areaMask: number,
  pageId = 0,
  locale?: string | null,
  sourcePreset?: SitePresetIdentity | null,
): Promise<SiteResolvedAreaPresetTree | null> {
  void pageId;
  return getExactSiteAreaPresetTreeWithDb(
    getPool(),
    siteId,
    areaMask,
    locale ?? null,
    sourcePreset,
  );
}

export async function getResolvedSitePageTree(
  siteId: number,
  areaMask: number,
  address: SitePageScopeAddress,
  locale?: string | null,
): Promise<SiteResolvedWidgetTree | null> {
  return getResolvedSitePageTreeWithDb(getPool(), siteId, areaMask, address, locale ?? null);
}

/**
 * Turns a unique-index violation on a Page address into the error the caller can act on.
 *
 * The two partial unique indexes are the real guard against two Pages arriving at one address: the
 * collision query alone lets both writers through when neither reads after the other commits.
 */
/**
 * Serialises every change to the Site Page addresses of one Area.
 *
 * The collision check reads other rows, and a read cannot see a row another writer has not committed.
 * The unique indexes guard equality on their own, but "a Page is never a folder" is a prefix relation no
 * index can express -- so the writers that create, move or promote an address take this lock first and
 * the check becomes the guarantee rather than advice.
 */
async function lockSitePageAddressesWithDb(db: DbQueryable, siteId: number, areaMask: number) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `phis.site_page_addresses:${siteId}:${areaMask}`,
  ]);
}

/**
 * Refuses an address another Site Page holds, and one that would put a Page beneath another Page or
 * another Page beneath it: a Page is never a folder. Both the live and the pending address of every
 * other Scope count, and a tombstoned Scope counts as well, because deletion reserves its path. `/` is
 * the Area root slot, not a folder, so nothing lies beneath it in this sense.
 *
 * Callers hold `lockSitePageAddressesWithDb` for the transaction.
 */
async function assertSitePageAddressFreeWithDb(
  db: DbQueryable,
  siteId: number,
  areaMask: number,
  path: string,
  exceptScopeId: number | null,
) {
  const { rows } = await db.query<{ id: number; path: string | null; draft_path: string | null; nested: boolean }>(
    `SELECT id, path, draft_path, (path IS DISTINCT FROM $3 AND draft_path IS DISTINCT FROM $3) AS nested
     FROM phis.site_page_scopes
     WHERE site_id = $1 AND area_id = $2 AND ($4::integer IS NULL OR id <> $4)
       AND (
         path = $3 OR draft_path = $3
         OR ($3 <> '/' AND (starts_with(path, $3 || '/') OR starts_with(draft_path, $3 || '/')))
         OR (path <> '/' AND starts_with($3, path || '/'))
         OR (draft_path <> '/' AND starts_with($3, draft_path || '/'))
       )
     ORDER BY nested, id
     LIMIT 1 FOR UPDATE`,
    [siteId, areaMask, path, exceptScopeId],
  );
  const conflict = rows[0];
  if (!conflict) return;
  if (!conflict.nested) {
    throw new SitePagePathChangeError("path_collision", "Another Page already owns this canonical path.");
  }
  const other = conflict.path ?? conflict.draft_path ?? "";
  throw new SitePagePathChangeError(
    "path_nested",
    `A Page is never a folder: this path and the Page at "${other}" would lie one beneath the other.`,
  );
}

function toSitePagePathCollisionError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
    ? new SitePagePathChangeError("path_collision", "Another Page already owns this canonical path.")
    : error;
}

/**
 * Moves a Site Page to another address, as a pending change that a publish makes real.
 *
 * The rename used to change the live Site the moment it was made: it wrote the Scope column, kept the
 * revision pointers and recorded nothing, so it was the one content-shaped change that skipped the
 * draft and could not be taken back. It writes `draft_path` now, and `publishSitePageRevision` promotes
 * it -- which also makes publishing the one place a live address changes.
 *
 * Asking for the path a Page already answers on cancels a pending change rather than storing a move to
 * where it already is.
 */
export async function changeSitePagePath(
  siteId: number,
  areaMask: number,
  pageScopeId: number,
  requestedPath: string,
) {
  if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(areaMask) || areaMask <= 0) {
    throw new SitePagePathChangeError("page_not_found", "The requested Site or Area is invalid.");
  }
  const nextPath = normalizeMutableSitePagePath(requestedPath);
  return withTransaction(async (client) => {
    const scope = await getSitePageScopeByIdWithDb(client, siteId, areaMask, pageScopeId, { forUpdate: true });
    if (!scope) {
      throw new SitePagePathChangeError("page_not_found", "The requested Page Scope was not found.");
    }
    if (scope.ownerModuleId || scope.presetKey || scope.path == null) {
      throw new SitePagePathChangeError("module_owned", "Module-owned Page paths cannot be changed by the Site.");
    }
    const pendingPath = nextPath === scope.path ? null : nextPath;
    if (pendingPath) {
      // Under the Area's address lock, so the answer holds until this transaction commits; the unique
      // index below stays as the last word on equality.
      await lockSitePageAddressesWithDb(client, siteId, areaMask);
      await assertSitePageAddressFreeWithDb(client, siteId, areaMask, pendingPath, pageScopeId);
    }
    const references = await countSiteCmsReferencesToPageWithDb(client, siteId, pageScopeId);
    try {
      await client.query(
        `UPDATE phis.site_page_scopes SET draft_path = $2, updated_at = NOW() WHERE id = $1`,
        [pageScopeId, pendingPath],
      );
    } catch (error) {
      throw toSitePagePathCollisionError(error);
    }
    return {
      pageScopeId,
      areaMask,
      path: scope.path,
      pendingPath,
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: scope.workingDraftRevisionId,
      references,
    };
  });
}
