import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { ensureSiteMessageId, upsertSiteTranslationForSite } from "@/db/translations";
import {
  deleteSiteAreaDraftRevision,
  deleteSiteAreaModulesDraftRevision,
  deleteSitePageDraftRevision,
  getSiteCurrentAreaDraft,
  getSiteCurrentAreaModulesDraft,
  getSiteCurrentPageDraft,
  getResolvedSitePageTree,
  publishSiteAreaModulesRevision,
  publishSiteAreaRevision,
  publishSitePageRevision,
  saveSiteAreaDraftRevision,
  saveSiteAreaModulesDraftRevision,
  saveSitePageDraftRevision,
  SiteCmsDraftConflictError,
  type SitePageScopeAddress,
} from "@/db/site-pages";
import { resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import {
  type CmsAreaModulesWriteInput,
  type CmsAreaPresetWriteInput,
  type CmsPageWriteInput,
  validateCmsAreaModulesWriteInput,
  validateCmsAreaPresetWriteInput,
  validateCmsPageWriteInput,
} from "@/lib/cms/write-validation";
import {
  requireSiteAuthorApiContext,
  requireSiteBuilderApiContext,
  requireSitePublisherApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  readSiteCmsErrorDetail,
  readSiteCmsErrorMessage,
  readSiteCmsRequestJson,
  readSiteCmsRequestSearchParam,
} from "@/lib/helpers/site-cms-route";
import { normalizeSiteCmsPath } from "@/lib/helpers/cms-path";
import { normalizeLocale } from "@/lib/locale";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

function resolveRequestLocale(request: Request) {
  const url = new URL(request.url);
  const rawLocale =
    url.searchParams.get("locale") ??
    request.headers.get("x-locale") ??
    request.headers.get("accept-language");

  if (!rawLocale?.trim()) {
    return null;
  }

  return normalizeLocale(rawLocale);
}

function resolveAreaMask(area: unknown) {
  return resolvePhisCmsAreaMask(typeof area === "string" ? area.trim().toLowerCase() : "");
}

function normalizeCmsPath(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim() ? normalizeSiteCmsPath(value) : "";
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwnProperty(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function resolveCmsPageScopeAddress(input: {
  path?: string | null;
  ownerModuleId?: string | null;
  presetKey?: string | null;
}): SitePageScopeAddress | null {
  const ownerModuleId = input.ownerModuleId?.trim() ?? "";
  const presetKey = input.presetKey?.trim() ?? "";
  if (ownerModuleId || presetKey) {
    return ownerModuleId && presetKey ? { kind: "preset", ownerModuleId, presetKey } : null;
  }
  const path = normalizeCmsPath(input.path);
  return path ? { kind: "path", path } : null;
}

function resolveCmsPageWriteScopeAddress(input: CmsPageWriteInput): SitePageScopeAddress {
  return input.sourcePreset
    ? {
        kind: "preset",
        ownerModuleId: input.sourcePreset.ownerModuleId,
        presetKey: input.sourcePreset.presetKey,
      }
    : { kind: "path", path: input.path };
}

function resolveCmsPresetIdentity(input: {
  ownerModuleId?: string | null;
  presetKey?: string | null;
}) {
  const ownerModuleId = input.ownerModuleId?.trim() ?? "";
  const presetKey = input.presetKey?.trim() ?? "";
  return ownerModuleId && presetKey ? { ownerModuleId, presetKey } : null;
}

type CmsPageMetaPatch = NonNullable<CmsPageWriteInput["pageMeta"]>;
type SiteResolvedPageTree = NonNullable<Awaited<ReturnType<typeof getResolvedSitePageTree>>>;

async function resolveSourceMessageId(input: {
  siteId: number;
  locale: string;
  value: string;
  context: string;
}) {
  const msgId = await ensureSiteMessageId(input.siteId, input.value, input.context);
  const updated = await upsertSiteTranslationForSite({
    siteId: input.siteId,
    msgId,
    locale: input.locale,
    translation: input.value,
  });
  if (!updated) {
    throw new Error("Translation source not found.");
  }

  return msgId;
}

async function applySitePageMetaPatch(input: {
  siteId: number;
  sourceLocale: string;
  pageInput: CmsPageWriteInput;
  pageMeta?: CmsPageMetaPatch | null;
  basePageTree?: SiteResolvedPageTree | null;
}) {
  const sourceLocale = input.sourceLocale;
  const basePageTree = input.basePageTree ??
    (
      (await getSiteCurrentPageDraft(input.siteId, {
        areaMask: input.pageInput.areaMask,
        address: resolveCmsPageWriteScopeAddress(input.pageInput),
        locale: sourceLocale,
      }))?.tree ??
      (await getResolvedSitePageTree(
        input.siteId,
        input.pageInput.areaMask,
        resolveCmsPageWriteScopeAddress(input.pageInput),
        sourceLocale,
      ))
    );
  const metaPatch = input.pageMeta ?? input.pageInput.pageMeta ?? null;
  const currentPage = basePageTree?.page ?? null;
  let titleMsgId = input.pageInput.page?.titleMsgId ?? currentPage?.titleMsgId ?? null;
  let descriptionMsgId =
    input.pageInput.page?.descriptionMsgId ?? currentPage?.descriptionMsgId ?? null;
  let changed = false;

  if (metaPatch && hasOwnProperty(metaPatch, "title")) {
    const title = normalizeString(metaPatch.title);
    const currentTitle = basePageTree?.pageMeta?.title?.value?.trim() ?? "";
    const nextTitleMsgId = title
      ? await resolveSourceMessageId({
          siteId: input.siteId,
          locale: sourceLocale,
          value: title,
          context: "page.title",
        })
      : null;
    changed = changed || title !== currentTitle || titleMsgId !== nextTitleMsgId;
    titleMsgId = nextTitleMsgId;
  }

  if (metaPatch && hasOwnProperty(metaPatch, "description")) {
    const description = normalizeString(metaPatch.description);
    const currentDescription = basePageTree?.pageMeta?.description?.value?.trim() ?? "";
    const nextDescriptionMsgId = description
      ? await resolveSourceMessageId({
          siteId: input.siteId,
          locale: sourceLocale,
          value: description,
          context: "page.description",
        })
      : null;
    changed = changed || description !== currentDescription || descriptionMsgId !== nextDescriptionMsgId;
    descriptionMsgId = nextDescriptionMsgId;
  }

  const { pageMeta: _pageMeta, ...stableInput } = input.pageInput;
  void _pageMeta;

  return {
    changed,
    value: {
      ...stableInput,
      page: {
        ...(input.pageInput.page ?? {}),
        titleMsgId,
        descriptionMsgId,
      },
    } satisfies CmsPageWriteInput,
  };
}

export async function handleSiteCmsPageWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = await readSiteCmsRequestJson(request);
  if (payload == null) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validated = validateCmsPageWriteInput(payload);
  if (!validated.ok) {
    return NextResponse.json(
      {
        error: validated.error,
        details: validated.details ?? [],
      },
      { status: 400 },
    );
  }

  try {
    const pageWriteInput = await applySitePageMetaPatch({
      siteId: context!.site!.id,
      sourceLocale: context!.site!.sourceLocale,
      pageInput: validated.value satisfies CmsPageWriteInput,
    });
    const draft = await saveSitePageDraftRevision(context!.site!.id, pageWriteInput.value, {
      createdByUserId: context!.session?.userId ?? null,
    });

    logSiteCmsAuditEvent(PhiCmsAuditEvent.PageDraftSaved, {
      request,
      siteKey: context!.site!.key,
      area: pageWriteInput.value.area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-page-draft",
      targetId: pageWriteInput.value.path,
      meta: {
        areaMask: pageWriteInput.value.areaMask,
        cmsPath: pageWriteInput.value.path,
        revisionId: draft.revisionId,
        version: draft.draft.version,
      },
    });

    return NextResponse.json({
      area: pageWriteInput.value.area,
      path: pageWriteInput.value.path,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.sourcePreset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS page save failed.");
    logRuntimeEvent("error", "cms.page_write.failed", {
      message: "CMS page write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-page-draft",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask: validated.value.areaMask,
        cmsPath: validated.value.path,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: error instanceof SiteCmsDraftConflictError ? 409 : 500 },
    );
  }
}

export async function handleSiteEditorPageMetaWrite(request: NextRequest) {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const payload = await readSiteCmsRequestJson(request);
  if (payload == null) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const area = normalizeString(payload.area);
  const path = normalizeCmsPath(payload.path);
  const hasTitle = Object.hasOwn(payload, "title");
  const hasDescription = Object.hasOwn(payload, "description");
  const title = normalizeString(payload.title);
  const description = normalizeString(payload.description);
  if (!area || !path) {
    return NextResponse.json({ error: "area and path must be provided." }, { status: 400 });
  }
  if (!hasTitle && !hasDescription) {
    return NextResponse.json({ error: "title or description must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);
  if (!areaMask) {
    return NextResponse.json({ error: "Invalid area." }, { status: 400 });
  }

  try {
    const locale = context!.site!.sourceLocale;
    const currentDraft = await getSiteCurrentPageDraft(context!.site!.id, {
      areaMask,
      address: { kind: "path", path },
      locale,
    });
    const resolvedPage = currentDraft?.tree ?? (await getResolvedSitePageTree(
      context!.site!.id,
      areaMask,
      { kind: "path", path },
      locale,
    ));
    if (!resolvedPage) {
      return NextResponse.json({ error: "CMS page not found." }, { status: 404 });
    }

    const pageWriteInput = await applySitePageMetaPatch({
      siteId: context!.site!.id,
      sourceLocale: context!.site!.sourceLocale,
      basePageTree: resolvedPage,
      pageInput: {
        area,
        areaMask,
        path,
        sourcePreset: resolvedPage.sourcePreset,
        page: resolvedPage.page,
        overlays: resolvedPage.overlays,
        layoutNodes: resolvedPage.layoutNodes,
        contentWidgets: resolvedPage.contentWidgets.map(({ resolvedContent, ...stableWidget }) => {
          void resolvedContent;
          return stableWidget;
        }),
      },
      pageMeta: {
        ...(hasTitle ? { title } : {}),
        ...(hasDescription ? { description } : {}),
      },
    });

    if (!pageWriteInput.changed) {
      return NextResponse.json({
        changed: false,
        revisionId: currentDraft?.revisionId ?? null,
        version: currentDraft?.draft.version ?? null,
        nextNodeSequence: currentDraft?.draft.nextNodeSequence ?? null,
        titleMsgId: pageWriteInput.value.page?.titleMsgId ?? null,
        descriptionMsgId: pageWriteInput.value.page?.descriptionMsgId ?? null,
      });
    }

    const saved = await saveSitePageDraftRevision(
      context!.site!.id,
      {
        ...pageWriteInput.value,
        ...(currentDraft ? { draft: currentDraft.draft } : {}),
      },
      {
        createdByUserId: context!.session?.userId ?? null,
      },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.PageMetaUpserted, {
      request,
      siteKey: context!.site!.key,
      area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-page-meta",
      targetId: path,
      meta: {
        areaMask,
        cmsPath: path,
      },
    });

    return NextResponse.json({
      changed: true,
      area,
      path,
      revisionId: saved.revisionId,
      version: saved.draft.version,
      nextNodeSequence: saved.draft.nextNodeSequence,
      titleMsgId: pageWriteInput.value.page?.titleMsgId ?? null,
      descriptionMsgId: pageWriteInput.value.page?.descriptionMsgId ?? null,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS page meta save failed.");
    logRuntimeEvent("error", "cms.page_meta_write.failed", {
      message: "CMS page meta write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-page-meta",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        cmsPath: path,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: error instanceof SiteCmsDraftConflictError ? 409 : 500 },
    );
  }
}

export async function handleSiteCmsAreaWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = await readSiteCmsRequestJson(request);
  if (payload == null) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validated = validateCmsAreaPresetWriteInput(payload);
  if (!validated.ok) {
    return NextResponse.json(
      {
        error: validated.error,
        details: validated.details ?? [],
      },
      { status: 400 },
    );
  }

  try {
    const draft = await saveSiteAreaDraftRevision(context!.site!.id, validated.value satisfies CmsAreaPresetWriteInput, {
      createdByUserId: context!.session?.userId ?? null,
    });

    logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaDraftSaved, {
      request,
      siteKey: context!.site!.key,
      area: validated.value.area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-area-draft",
      targetId: validated.value.area,
      meta: {
        areaMask: validated.value.areaMask,
        revisionId: draft.revisionId,
        version: draft.draft.version,
      },
    });

    return NextResponse.json({
      area: validated.value.area,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.sourcePreset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area save failed.");
    logRuntimeEvent("error", "cms.area_write.failed", {
      message: "CMS area write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-draft",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask: validated.value.areaMask,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: error instanceof SiteCmsDraftConflictError ? 409 : 500 },
    );
  }
}

/**
 * Saves an Area's Module selection.
 *
 * A separate route from the Area write, and deliberately not a mode of it: what arrives here can only
 * be a preset config, so this cannot be used to move structure past the checks a structure write runs.
 * It lands in the same revision family, where a reviewer sees it beside everything else about the Area.
 */
export async function handleSiteCmsAreaModulesWrite(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = await readSiteCmsRequestJson(request);
  if (payload == null) {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const validated = validateCmsAreaModulesWriteInput(payload);
  if (!validated.ok) {
    return NextResponse.json(
      {
        error: validated.error,
        details: validated.details ?? [],
      },
      { status: 400 },
    );
  }

  try {
    const draft = await saveSiteAreaModulesDraftRevision(
      context!.site!.id,
      validated.value satisfies CmsAreaModulesWriteInput,
      { createdByUserId: context!.session?.userId ?? null },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaModulesDraftSaved, {
      request,
      siteKey: context!.site!.key,
      area: validated.value.area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-area-modules-draft",
      targetId: validated.value.area,
      meta: {
        areaMask: validated.value.areaMask,
        revisionId: draft.revisionId,
        version: draft.draft.version,
      },
    });

    return NextResponse.json({
      area: validated.value.area,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.sourcePreset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area Module save failed.");
    logRuntimeEvent("error", "cms.area_modules_write.failed", {
      message: "CMS area Module write failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-modules-draft",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask: validated.value.areaMask,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: error instanceof SiteCmsDraftConflictError ? 409 : 500 },
    );
  }
}

/** Discards the Area's Module draft, leaving its structure draft where it is. */
export async function handleSiteCmsAreaModulesDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
      (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey") ??
      (typeof payload?.presetKey === "string" ? payload.presetKey : null),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);

  try {
    const result = await deleteSiteAreaModulesDraftRevision(context!.site!.id, {
      areaMask,
      sourcePreset,
    });

    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaModulesDraftDeleted, {
        request,
        siteKey: context!.site!.key,
        area,
        userId: context!.session?.userId ?? null,
        targetType: "cms-area-modules-draft",
        targetId: area,
        meta: { areaMask },
      });
    }

    return NextResponse.json({
      areaMask,
      deleted: result.deleted,
    });
  } catch (error) {
    logRuntimeEvent("error", "cms.area_modules_delete.failed", {
      message: "CMS area Module draft delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-modules-draft",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
      },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(error, "CMS area Module draft delete failed."),
      },
      { status: 500 },
    );
  }
}

/** Reads the Area's open Module draft. Absence is a 404: it is a question with an answer either way. */
export async function handleSiteCmsAreaModulesDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const area = readSiteCmsRequestSearchParam(request, "area");
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId"),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey"),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);

  try {
    const draft = await getSiteCurrentAreaModulesDraft(context!.site!.id, {
      areaMask,
      sourcePreset,
    });

    if (!draft) {
      return NextResponse.json({ error: "CMS area Module draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      areaMask,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.preset.sourcePreset,
      preset: draft.preset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area Module draft read failed.");
    logRuntimeEvent("error", "cms.area_modules_draft_read.failed", {
      message: "CMS area Module draft read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-modules-draft-read",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}

/** Publishes the Area's Module selection. Its structure draft, if one is open, stays open. */
export async function handleSiteCmsAreaModulesPublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
    revisionId?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const revisionIdValue =
    readSiteCmsRequestSearchParam(request, "revisionId") ??
    (typeof payload?.revisionId === "number" || typeof payload?.revisionId === "string"
      ? String(payload.revisionId)
      : null);
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
      (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey") ??
      (typeof payload?.presetKey === "string" ? payload.presetKey : null),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const revisionId =
    revisionIdValue && Number.isInteger(Number(revisionIdValue)) ? Number(revisionIdValue) : null;
  const areaMask = resolveAreaMask(area);
  const locale = resolveRequestLocale(request);

  try {
    const result = await publishSiteAreaModulesRevision(
      context!.site!.id,
      {
        areaMask,
        sourcePreset,
        revisionId,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
        locale,
      },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaModulesPublished, {
      request,
      siteKey: context!.site!.key,
      area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-area-modules",
      targetId: area,
      meta: {
        areaMask,
        locale,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      areaMask,
      revisionId: result.revisionId,
      preset: result.preset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area Module publish failed.");
    logRuntimeEvent("error", "cms.area_modules_publish.failed", {
      message: "CMS area Module publish failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-modules-publish",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        locale,
        revisionId,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsPageDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    path?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const path = readSiteCmsRequestSearchParam(request, "path") ?? (typeof payload?.path === "string" ? payload.path : null);
  const ownerModuleId = readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
    (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null);
  const presetKey = readSiteCmsRequestSearchParam(request, "presetKey") ??
    (typeof payload?.presetKey === "string" ? payload.presetKey : null);
  const address = resolveCmsPageScopeAddress({ path, ownerModuleId, presetKey });
  if (!area || !address) {
    return NextResponse.json({ error: "area and either path or ownerModuleId plus presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);
  try {
    const result = await deleteSitePageDraftRevision(context!.site!.id, {
      areaMask,
      address,
    });

    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.PageDraftDeleted, {
        request,
        siteKey: context!.site!.key,
        area,
        userId: context!.session?.userId ?? null,
        targetType: "cms-page-draft",
        targetId: address.kind === "path" ? address.path : `${address.ownerModuleId}/${address.presetKey}`,
        meta: {
          areaMask,
          cmsPath: address.kind === "path" ? address.path : null,
        },
      });
    }

    return NextResponse.json({
      areaMask,
      path,
      deleted: result.deleted,
    });
  } catch (error) {
    logRuntimeEvent("error", "cms.page_delete.failed", {
      message: "CMS page delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-page",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        cmsPath: path,
      },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(error, "CMS page delete failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsPageDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const area = readSiteCmsRequestSearchParam(request, "area");
  const path = readSiteCmsRequestSearchParam(request, "path");
  const ownerModuleId = readSiteCmsRequestSearchParam(request, "ownerModuleId");
  const presetKey = readSiteCmsRequestSearchParam(request, "presetKey");
  const address = resolveCmsPageScopeAddress({ path, ownerModuleId, presetKey });
  if (!area || !address) {
    return NextResponse.json({ error: "area and either path or ownerModuleId plus presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);

  try {
    const draft = await getSiteCurrentPageDraft(context!.site!.id, {
      areaMask,
      address,
    });

    if (!draft) {
      return NextResponse.json({ error: "CMS page draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      areaMask,
      path: draft.tree.page.path,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.tree.sourcePreset,
      page: draft.tree,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS page draft read failed.");
    logRuntimeEvent("error", "cms.page_draft_read.failed", {
      message: "CMS page draft read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-page-draft-read",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        cmsPath: path,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsAreaDelete(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
      (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey") ??
      (typeof payload?.presetKey === "string" ? payload.presetKey : null),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);

  try {
    const result = await deleteSiteAreaDraftRevision(context!.site!.id, {
      areaMask,
      sourcePreset,
    });

    if (result.deleted) {
      logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaDraftDeleted, {
        request,
        siteKey: context!.site!.key,
        area,
        userId: context!.session?.userId ?? null,
        targetType: "cms-area-draft",
        targetId: area,
        meta: { areaMask },
      });
    }

    return NextResponse.json({
      areaMask,
      deleted: result.deleted,
    });
  } catch (error) {
    logRuntimeEvent("error", "cms.area_delete.failed", {
      message: "CMS area delete failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
      },
    });
    return NextResponse.json(
      {
        error: readSiteCmsErrorMessage(error, "CMS area delete failed."),
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsAreaDraftRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const area = readSiteCmsRequestSearchParam(request, "area");
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId"),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey"),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const areaMask = resolveAreaMask(area);

  try {
    const draft = await getSiteCurrentAreaDraft(context!.site!.id, {
      areaMask,
      sourcePreset,
    });

    if (!draft) {
      return NextResponse.json({ error: "CMS area draft not found." }, { status: 404 });
    }

    return NextResponse.json({
      areaMask,
      revisionId: draft.revisionId,
      version: draft.draft.version,
      nextNodeSequence: draft.draft.nextNodeSequence,
      sourcePreset: draft.preset.sourcePreset,
      preset: draft.preset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area draft read failed.");
    logRuntimeEvent("error", "cms.area_draft_read.failed", {
      message: "CMS area draft read failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-draft-read",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsPagePublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    path?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
    revisionId?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const path = readSiteCmsRequestSearchParam(request, "path") ?? (typeof payload?.path === "string" ? payload.path : null);
  const ownerModuleId = readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
    (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null);
  const presetKey = readSiteCmsRequestSearchParam(request, "presetKey") ??
    (typeof payload?.presetKey === "string" ? payload.presetKey : null);
  const address = resolveCmsPageScopeAddress({ path, ownerModuleId, presetKey });
  const revisionIdValue =
    readSiteCmsRequestSearchParam(request, "revisionId") ??
    (typeof payload?.revisionId === "number" || typeof payload?.revisionId === "string"
      ? String(payload.revisionId)
      : null);
  if (!area || !address) {
    return NextResponse.json({ error: "area and either path or ownerModuleId plus presetKey must be provided." }, { status: 400 });
  }

  const revisionId =
    revisionIdValue && Number.isInteger(Number(revisionIdValue)) ? Number(revisionIdValue) : null;
  const areaMask = resolveAreaMask(area);
  const locale = resolveRequestLocale(request);

  try {
    const result = await publishSitePageRevision(
      context!.site!.id,
      {
        areaMask,
        address,
        revisionId,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
        locale,
      },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.PagePublished, {
      request,
      siteKey: context!.site!.key,
      area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-page",
      targetId: path,
      meta: {
        areaMask,
        cmsPath: path,
        locale,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      areaMask,
      path,
      revisionId: result.revisionId,
      page: result.page,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS page publish failed.");
    logRuntimeEvent("error", "cms.page_publish.failed", {
      message: "CMS page publish failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-page-publish",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        cmsPath: path,
        locale,
        revisionId,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}

export async function handleSiteCmsAreaPublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const payload = (await readSiteCmsRequestJson(request)) as {
    area?: unknown;
    ownerModuleId?: unknown;
    presetKey?: unknown;
    revisionId?: unknown;
  } | null;
  const area = readSiteCmsRequestSearchParam(request, "area") ?? (typeof payload?.area === "string" ? payload.area : null);
  const revisionIdValue =
    readSiteCmsRequestSearchParam(request, "revisionId") ??
    (typeof payload?.revisionId === "number" || typeof payload?.revisionId === "string"
      ? String(payload.revisionId)
      : null);
  const sourcePreset = resolveCmsPresetIdentity({
    ownerModuleId: readSiteCmsRequestSearchParam(request, "ownerModuleId") ??
      (typeof payload?.ownerModuleId === "string" ? payload.ownerModuleId : null),
    presetKey: readSiteCmsRequestSearchParam(request, "presetKey") ??
      (typeof payload?.presetKey === "string" ? payload.presetKey : null),
  });
  if (!area || !sourcePreset) {
    return NextResponse.json({ error: "area, ownerModuleId, and presetKey must be provided." }, { status: 400 });
  }

  const revisionId =
    revisionIdValue && Number.isInteger(Number(revisionIdValue)) ? Number(revisionIdValue) : null;
  const areaMask = resolveAreaMask(area);
  const locale = resolveRequestLocale(request);

  try {
    const result = await publishSiteAreaRevision(
      context!.site!.id,
      {
        areaMask,
        sourcePreset,
        revisionId,
      },
      {
        createdByUserId: context!.session?.userId ?? null,
        locale,
      },
    );

    logSiteCmsAuditEvent(PhiCmsAuditEvent.AreaPublished, {
      request,
      siteKey: context!.site!.key,
      area,
      userId: context!.session?.userId ?? null,
      targetType: "cms-area",
      targetId: area,
      meta: {
        areaMask,
        locale,
        revisionId: result.revisionId,
      },
    });

    return NextResponse.json({
      areaMask,
      revisionId: result.revisionId,
      preset: result.preset,
    });
  } catch (error) {
    const detail = readSiteCmsErrorDetail(error);
    const message = readSiteCmsErrorMessage(error, "CMS area publish failed.");
    logRuntimeEvent("error", "cms.area_publish.failed", {
      message: "CMS area publish failed.",
      siteKey: context!.site!.key,
      userId: context!.session?.userId ?? null,
      method: request.method,
      path: request.nextUrl.pathname,
      targetType: "cms-area-publish",
      error: normalizeLogThrowable(error),
      meta: {
        areaMask,
        locale,
        revisionId,
      },
    });
    return NextResponse.json(
      {
        error: message,
        details: detail ? [detail] : [],
      },
      { status: 500 },
    );
  }
}
