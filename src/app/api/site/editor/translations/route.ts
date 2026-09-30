import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import {
  deleteSiteExternalTranslationUnit,
  deleteSiteTranslation,
  listSiteTranslationContexts,
  listSiteTranslationEditorRows,
  type SiteTranslationEditorStatus,
  upsertSiteTranslationForSite,
} from "@/db/translations";
import {
  requireSiteAuthorApiContext,
  requireSiteReviewApiContext,
} from "@/lib/guards/site-admin-api";
import {
  filterSiteTranslationTargetLocales,
  resolvePhiLocaleCapability,
  resolveSiteLocale,
} from "@/lib/locale";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeString,
  parsePhiPagination,
  parsePositiveIntWithFallback,
  readRequestBody,
} from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

const TRANSLATION_EDITOR_STATUSES = new Set<SiteTranslationEditorStatus>([
  "all",
  "missing",
  "translated",
]);

function normalizePositiveInt(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  return Number.parseInt(normalizeString(value), 10);
}

function normalizeStatus(value: string | null): SiteTranslationEditorStatus {
  const normalized = value?.trim().toLowerCase() ?? "";
  return TRANSLATION_EDITOR_STATUSES.has(normalized as SiteTranslationEditorStatus)
    ? (normalized as SiteTranslationEditorStatus)
    : "all";
}

function resolveWritableLocale(input: unknown, availableCodes: Set<string>) {
  const requestedLocale = normalizeString(input);
  const locale = resolvePhiLocaleCapability(requestedLocale)?.locale ?? "";
  return locale && availableCodes.has(locale) ? locale : "";
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLocale = searchParams.get("locale");
  const targetLocales = filterSiteTranslationTargetLocales(site.sourceLocale, config.availableLocales);
  const resolvedLocale = targetLocales.length > 0
    ? resolveSiteLocale({
        requestedLocale,
        defaultLocale: config.defaultLocale,
        availableLocales: targetLocales.map((option) => option.code),
      })
    : null;
  const { page, pageSize } = parsePhiPagination(searchParams);
  const contextFilter = searchParams.get("ctx")?.trim() ?? searchParams.get("context")?.trim() ?? "";
  const search = searchParams.get("search")?.trim() ?? "";
  const status = normalizeStatus(searchParams.get("status"));

  const [contexts, translations] = await Promise.all([
    listSiteTranslationContexts(site.id),
    resolvedLocale
      ? listSiteTranslationEditorRows({
          siteId: site.id,
          locale: resolvedLocale.locale,
          page,
          pageSize,
          context: contextFilter,
          search,
          status,
        })
      : Promise.resolve({ rows: [], total: 0, page, pageSize }),
  ]);

  return NextResponse.json({
    site: {
      availableLocales: targetLocales,
    },
    sourceLocale: site.sourceLocale,
    selectedLocale: resolvedLocale?.locale ?? null,
    contexts,
    translations,
  });
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  const action = normalizeString(body.action);
  const availableCodes = new Set(
    filterSiteTranslationTargetLocales(site.sourceLocale, config.availableLocales)
      .map((option) => option.code),
  );

  if (action === "translation") {
    const msgId = normalizePositiveInt(body.msgId);
    const locale = resolveWritableLocale(body.locale, availableCodes);
    const translation = normalizeString(body.translation);

    if (!locale) {
      return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
    }
    if (!Number.isInteger(msgId) || msgId <= 0 || !translation) {
      return NextResponse.json({ error: "A valid message id and translation are required." }, { status: 400 });
    }

    const updated = await upsertSiteTranslationForSite({
      siteId: site.id,
      msgId,
      locale,
      translation,
    });
    if (!updated) {
      return NextResponse.json({ error: "Translation source not found." }, { status: 404 });
    }

    logRuntimeEvent("info", "site.editor.translation.upserted", {
      area: "editor",
      message: "Site translation upserted.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { msgId, locale },
    });

    return NextResponse.json({ updatedCount: 1 });
  }

  if (action === "translations") {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    let updatedCount = 0;

    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }

      const record = row as Record<string, unknown>;
      const msgId = normalizePositiveInt(record.msgId);
      const locale = resolveWritableLocale(record.locale, availableCodes);
      const translation = normalizeString(record.translation);
      if (!Number.isInteger(msgId) || msgId <= 0 || !locale || !translation) {
        continue;
      }

      const updated = await upsertSiteTranslationForSite({
        siteId: site.id,
        msgId,
        locale,
        translation,
      });
      if (updated) {
        updatedCount += 1;
      }
    }

    logRuntimeEvent("info", "site.editor.translations.upserted", {
      area: "editor",
      message: "Site translations upserted.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { updatedCount },
    });

    return NextResponse.json({ updatedCount });
  }

  return NextResponse.json({ error: "Unsupported translation editor action." }, { status: 400 });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope")?.trim().toLowerCase() ?? "";
  const { context, error } = scope === "external-unit"
    ? await requireSiteReviewApiContext(request)
    : await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const msgId = parsePositiveIntWithFallback(searchParams.get("msgId"), 0);

  if (scope === "external-unit") {
    const result = await deleteSiteExternalTranslationUnit({ siteId: site.id, msgId });
    if (!result.deleted) {
      const status = result.reason === "content_reference" ? 409 : 404;
      return NextResponse.json({ error: result.reason }, { status });
    }

    logRuntimeEvent("warn", "site.editor.translation.external_unit.deleted", {
      area: "editor",
      message: "External Site translation unit deleted.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { msgId },
    });
    return NextResponse.json({ deletedCount: 1 });
  }

  const availableCodes = new Set(
    filterSiteTranslationTargetLocales(site.sourceLocale, config.availableLocales)
      .map((option) => option.code),
  );
  const locale = resolveWritableLocale(searchParams.get("locale"), availableCodes);

  if (!locale) {
    return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
  }
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return NextResponse.json({ error: "A valid message id is required." }, { status: 400 });
  }

  const deleted = await deleteSiteTranslation({
    siteId: site.id,
    msgId,
    locale,
  });
  if (!deleted) {
    return NextResponse.json({ error: "Translation not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.editor.translation.deleted", {
    area: "editor",
    message: "Site translation deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { msgId, locale },
  });

  return NextResponse.json({ deletedCount: 1 });
}
