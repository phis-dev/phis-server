import { NextResponse, type NextRequest } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { getResolvedSiteContentByVersionIds, type SiteResolvedContentRecord } from "@/db/site-content";
import {
  isSiteWidgetContentStorage,
  publishSiteWidgetContent,
  readSiteWidgetContentRowsWithDb,
  saveSiteWidgetContent,
  SiteContentConflictError,
  submitSiteWidgetContent,
  withdrawSiteWidgetContent,
  withdrawSiteWidgetContentSubmission,
  type SiteWidgetContentPlace,
  type SiteWidgetContentPublishOutcome,
  type SiteWidgetContentRow,
  type SiteWidgetContentStage,
} from "@/db/site-widget-content";
import { isPhiCmsInstanceId } from "@/lib/cms/instance-id";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { getPool } from "@/lib/db";
import {
  requireSitePublisherApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  normalizeNullableInteger,
  normalizeString,
  parsePositiveIntWithFallback,
  readRequestBody,
} from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

/*
 * Widget content through the Editor (CONTENT.md).
 *
 * Saving and submitting is everybody's who may read drafts -- Developer, Builder, Author, Publisher --
 * because nothing they write is live. Publishing and withdrawing is the Publisher's. Every write names the
 * version it builds on, and a write that does not build on the current one answers `409` and writes
 * nothing.
 */

/** The most instances one read answers; a Page with more bound Widgets than this asks twice. */
const SITE_CONTENT_READ_LIMIT = 200;

function readInstanceIds(url: URL) {
  const raw = url.searchParams.get("instanceIds") ?? "";
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length > SITE_CONTENT_READ_LIMIT || !ids.every((id) => isPhiCmsInstanceId(id))) {
    return null;
  }
  return ids;
}

export type SiteWidgetContentState = {
  instanceId: string;
  contentId: number;
  type: number;
  currentVersionId: number | null;
  publishedVersionId: number | null;
  submittedVersionId: number | null;
  /** The bound value in the stage asked for: a text, or an asset id. `null` where the stage has none. */
  value: string | number | null;
  /** The stage's version, resolved -- translated where a locale was asked for. */
  content: SiteResolvedContentRecord | null;
};

async function readSiteWidgetContentStates(
  siteId: number,
  instanceIds: readonly string[],
  stage: SiteWidgetContentStage,
  locale: string | null,
): Promise<SiteWidgetContentState[]> {
  const rows = await readSiteWidgetContentRowsWithDb(getPool(), siteId, instanceIds);
  const versionOf = (row: SiteWidgetContentRow) =>
    stage === "published" ? row.publishedVersionId : row.currentVersionId;
  const resolved = await getResolvedSiteContentByVersionIds(
    siteId,
    [...rows.values()].flatMap((row) => versionOf(row) ?? []),
    locale,
  );
  return [...rows.values()].map((row) => {
    const versionId = versionOf(row);
    const content = versionId == null ? null : resolved.get(versionId) ?? null;
    const field = content ? Object.values(content.textFields)[0] ?? null : null;
    return {
      instanceId: row.instanceId,
      contentId: row.id,
      type: row.type,
      currentVersionId: row.currentVersionId,
      publishedVersionId: row.publishedVersionId,
      submittedVersionId: row.submittedVersionId,
      value: content?.assetId ?? field?.source ?? null,
      content,
    };
  });
}

/**
 * The bound content of Widgets, for a Site process rendering a preset tree: the tree is the Module's and
 * never reached phi-server, so its Widgets' content is asked for by instance. The published stage is
 * public; the current stage is a draft and needs a reviewer.
 */
export async function handleSiteWidgetContentRead(
  request: NextRequest,
  site: { id: number },
  locale: string | null,
) {
  const url = new URL(request.url);
  const instanceIds = readInstanceIds(url);
  if (!instanceIds) {
    return NextResponse.json(
      { error: `instanceIds must be up to ${SITE_CONTENT_READ_LIMIT} CMS instance ids.` },
      { status: 400 },
    );
  }
  const stage = url.searchParams.get("stage") === "current" ? "current" : "published";
  if (stage === "current") {
    const { error } = await requireSiteReviewApiContext(request);
    if (error) return error;
  }
  return NextResponse.json({
    stage,
    contents: await readSiteWidgetContentStates(site.id, instanceIds, stage, locale),
  });
}

/** The Editor's read: every bound instance asked for, in its current stage and in the Site's own language. */
export async function handleSiteEditorContentRead(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) return error;
  const instanceIds = readInstanceIds(new URL(request.url));
  if (!instanceIds) {
    return NextResponse.json(
      { error: `instanceIds must be up to ${SITE_CONTENT_READ_LIMIT} CMS instance ids.` },
      { status: 400 },
    );
  }
  return NextResponse.json({
    contents: await readSiteWidgetContentStates(context!.site!.id, instanceIds, "current", null),
  });
}

/**
 * Saves one Widget's content as a new draft version. A preset node gets its row here, and only here: a
 * structure save never binds one (CONTENT.md, Binding a Widget to its content).
 */
export async function handleSiteEditorContentWrite(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) return error;
  const site = context!.site!;
  const body = await readRequestBody(request);

  const instanceId = normalizeString(body.instanceId);
  if (!instanceId || !isPhiCmsInstanceId(instanceId)) {
    return NextResponse.json({ error: "instanceId must be a CMS instance id." }, { status: 400 });
  }
  if (!isSiteWidgetContentStorage(body.storage)) {
    return NextResponse.json({ error: "storage must be text, html, markdown or asset." }, { status: 400 });
  }
  const area = normalizeString(body.area) || "public";
  if (!isPhisCmsAreaKey(area)) {
    return NextResponse.json({ error: "area must be a CMS area key." }, { status: 400 });
  }
  const baseVersionId = normalizeNullableInteger(body.baseVersionId);
  if (body.baseVersionId != null && (baseVersionId == null || baseVersionId <= 0)) {
    return NextResponse.json({ error: "baseVersionId must be a positive integer or null." }, { status: 400 });
  }

  const storage = body.storage;
  let value: string | number;
  let asset: { title: string | null; altText: string | null } | null = null;
  if (storage === "asset") {
    const assetId = normalizeNullableInteger(body.value);
    const record = assetId != null && assetId > 0 ? await getMediaAssetBySiteAndId(site.id, assetId) : null;
    if (!record || assetId == null) {
      return NextResponse.json({ error: "value must be a media asset of this Site." }, { status: 400 });
    }
    value = assetId;
    asset = { title: record.title, altText: record.altText };
  } else if (typeof body.value === "string") {
    value = body.value;
  } else {
    return NextResponse.json({ error: "value must be a string." }, { status: 400 });
  }

  try {
    const result = await saveSiteWidgetContent({
      siteId: site.id,
      instanceId,
      storage,
      value,
      baseVersionId: baseVersionId ?? null,
      slug: `cms-widget-${instanceId}`,
      referenceAreaId: resolvePhisCmsAreaMask(area),
      asset,
      place: readSiteWidgetContentPlace(body.place, area),
      createdByUserId: context!.session?.userId ?? null,
    });
    return NextResponse.json(result);
  } catch (writeError) {
    if (writeError instanceof SiteContentConflictError) {
      return NextResponse.json(
        {
          error: "The content changed since it was read.",
          contentId: writeError.contentId,
          currentVersionId: writeError.currentVersionId,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: writeError instanceof Error ? writeError.message : "Content save failed." },
      { status: 400 },
    );
  }
}

/**
 * Where the Editor wrote the content, as it says: the Page it had open, or the Area. Only kept for the
 * Publisher's queue, so a place that is not one is dropped rather than refused.
 */
function readSiteWidgetContentPlace(value: unknown, area: string): SiteWidgetContentPlace | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.scope === "area") return { scope: "area", area };
  if (record.scope !== "page") return null;
  const path = normalizeString(record.path) || null;
  const ownerModuleId = normalizeString(record.ownerModuleId) || null;
  const presetKey = normalizeString(record.presetKey) || null;
  if (!path && !(ownerModuleId && presetKey)) return null;
  return { scope: "page", area, path, ownerModuleId, presetKey };
}

function readContentAndVersion(body: Record<string, unknown>) {
  const contentId = normalizeNullableInteger(body.contentId);
  const versionId = normalizeNullableInteger(body.versionId);
  return contentId != null && contentId > 0 && versionId != null && versionId > 0
    ? { contentId, versionId }
    : null;
}

function toOutcomeResponse(outcome: SiteWidgetContentPublishOutcome) {
  if (outcome.ok) return NextResponse.json(outcome);
  return outcome.reason === "missing"
    ? NextResponse.json({ error: "No such content." }, { status: 404 })
    : NextResponse.json({ error: "That version is not the one this act applies to." }, { status: 409 });
}

/** Puts the current version forward for publication (`POST`), or takes the submission back (`DELETE`). */
export async function handleSiteEditorContentSubmit(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) return error;
  const site = context!.site!;
  if (request.method === "DELETE") {
    const contentId = parsePositiveIntWithFallback(new URL(request.url).searchParams.get("contentId"), 0);
    if (contentId <= 0) {
      return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
    }
    return (await withdrawSiteWidgetContentSubmission({ siteId: site.id, contentId }))
      ? NextResponse.json({ withdrawn: true })
      : NextResponse.json({ error: "No such content." }, { status: 404 });
  }
  const target = readContentAndVersion(await readRequestBody(request));
  if (!target) {
    return NextResponse.json({ error: "contentId and versionId are required." }, { status: 400 });
  }
  return toOutcomeResponse(await submitSiteWidgetContent({ siteId: site.id, ...target }));
}

/** Puts a named version live (`POST`), or takes the content off the live Site (`DELETE`). */
export async function handleSiteEditorContentPublish(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) return error;
  const site = context!.site!;
  const userId = context!.session?.userId ?? null;
  if (request.method === "DELETE") {
    const contentId = parsePositiveIntWithFallback(new URL(request.url).searchParams.get("contentId"), 0);
    if (contentId <= 0) {
      return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
    }
    if (!(await withdrawSiteWidgetContent({ siteId: site.id, contentId }))) {
      return NextResponse.json({ error: "No such content." }, { status: 404 });
    }
    logRuntimeEvent("info", "site.editor.content.withdrawn", {
      area: "editor",
      message: "Widget content withdrawn.",
      siteKey: site.key,
      userId,
      meta: { contentId },
    });
    return NextResponse.json({ withdrawn: true });
  }
  const target = readContentAndVersion(await readRequestBody(request));
  if (!target) {
    return NextResponse.json({ error: "contentId and versionId are required." }, { status: 400 });
  }
  const outcome = await publishSiteWidgetContent({ siteId: site.id, ...target });
  if (outcome.ok) {
    logRuntimeEvent("info", "site.editor.content.published", {
      area: "editor",
      message: "Widget content published.",
      siteKey: site.key,
      userId,
      meta: target,
    });
  }
  return toOutcomeResponse(outcome);
}
