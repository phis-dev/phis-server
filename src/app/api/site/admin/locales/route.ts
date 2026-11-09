import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig, updateSiteLocales } from "@/db/sites";
import {
  deleteSiteTranslation,
  deleteSiteTranslations,
  deleteSiteTranslatedVariantsForLocale,
  listSiteTranslationRows,
  updateSiteTranslation,
} from "@/db/translations";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import {
  filterSiteTranslationTargetLocales,
  resolvePhiLocaleCapability,
  resolveSiteLocale,
} from "@/lib/locale";
import { logRuntimeEvent } from "@/lib/log";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";
import {
  normalizeString,
  parsePhiPagination,
  parsePositiveIntWithFallback,
  parseStrictPositiveInt,
  readRequestBody,
} from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeLocaleArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }

  return [];
}

function buildLocaleLabel(code: string) {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

function buildConfiguredLocales() {
  return getConfiguredTranslationSupportedLocalesSync().map((code) => ({
    code,
    label: buildLocaleLabel(code),
  }));
}

function resolveTranslationTargetLocales(
  sourceLocale: string,
  availableLocales: readonly { code: string; label: string }[],
) {
  const supportedLocales = new Set(getConfiguredTranslationSupportedLocalesSync());
  return filterSiteTranslationTargetLocales(
    sourceLocale,
    availableLocales.filter((option) => supportedLocales.has(option.code)),
  );
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const requestedLocale = searchParams.get("locale");
  const { page, pageSize } = parsePhiPagination(searchParams);
  const search = searchParams.get("search")?.trim() ?? "";
  const targetLocales = resolveTranslationTargetLocales(site.sourceLocale, config.availableLocales);
  const resolvedLocale = targetLocales.length > 0
    ? resolveSiteLocale({
        requestedLocale,
        defaultLocale: config.defaultLocale,
        availableLocales: targetLocales.map((option) => option.code),
      })
    : null;
  const translations = resolvedLocale
    ? await listSiteTranslationRows({
        siteId: site.id,
        locale: resolvedLocale.locale,
        page,
        pageSize,
        search,
      })
    : { rows: [], total: 0, localeTotal: 0, page, pageSize };

  return NextResponse.json({
    site: {
      sourceLocale: site.sourceLocale,
      defaultLocale: config.defaultLocale,
      availableLocales: config.availableLocales,
      targetLocales,
    },
    platformLocales: buildConfiguredLocales(),
    selectedLocale: resolvedLocale?.locale ?? null,
    translations,
  });
}

export async function PATCH(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  const action = normalizeString(body.action);

  if (action === "site-locales") {
    const requestedDefaultLocale = normalizeString(body.defaultLocale);
    const defaultLocale = resolvePhiLocaleCapability(requestedDefaultLocale)?.locale ?? "";
    const availableLocales = normalizeLocaleArray(body.availableLocales);
    const updated = await updateSiteLocales({
      siteId: site.id,
      defaultLocale: defaultLocale || config.defaultLocale,
      availableLocales,
    });

    logRuntimeEvent("info", "site.locales.updated", {
      area: "admin",
      message: "Site locale selection updated.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: {
        defaultLocale: updated.defaultLocale,
        availableLocales: updated.availableLocales.map((option) => option.code),
      },
    });

    return NextResponse.json({ site: updated });
  }

  if (action === "translation") {
    const msgId = parseStrictPositiveInt(body.msgId);
    if (msgId == null) {
      return NextResponse.json({ error: "msgId must be a positive integer." }, { status: 400 });
    }
    const requestedLocale = normalizeString(body.locale);
    const locale = resolvePhiLocaleCapability(requestedLocale)?.locale ?? "";
    const translation = normalizeString(body.translation);
    const availableCodes = new Set(
      resolveTranslationTargetLocales(site.sourceLocale, config.availableLocales)
        .map((option) => option.code),
    );

    if (!locale || !availableCodes.has(locale)) {
      return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
    }

    const updated = await updateSiteTranslation({
      siteId: site.id,
      msgId,
      locale,
      translation,
    });
    if (!updated) {
      return NextResponse.json({ error: "Translation not found." }, { status: 404 });
    }

    logRuntimeEvent("info", "site.translation.updated", {
      area: "admin",
      message: "Site translation updated.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { msgId, locale },
    });

    return NextResponse.json({
      translation: updated.translation,
      updatedAt: updated.updatedAt,
    });
  }

  return NextResponse.json({ error: "Unsupported locale admin action." }, { status: 400 });
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope")?.trim().toLowerCase() ?? "";

  const selectedIdentities = searchParams.getAll("id");
  if (selectedIdentities.length > 0) {
    const availableCodes = new Set(
      resolveTranslationTargetLocales(site.sourceLocale, config.availableLocales)
        .map((option) => option.code),
    );
    const selectedRows = selectedIdentities.map((identity) => {
      const [msgIdValue = "", requestedLocale = ""] = identity.split(":", 2);
      // 0 for an id that is none, which the check below refuses with the row.
      const msgId = parseStrictPositiveInt(msgIdValue) ?? 0;
      const locale = resolvePhiLocaleCapability(requestedLocale)?.locale ?? "";
      return { msgId, locale };
    });
    if (selectedRows.some((row) => !row.msgId || !row.locale || !availableCodes.has(row.locale))) {
      return NextResponse.json({ error: "Invalid translation selection." }, { status: 400 });
    }

    const deletedCount = await deleteSiteTranslations({
      siteId: site.id,
      rows: selectedRows,
    });

    logRuntimeEvent("info", "site.translations.selected.deleted", {
      area: "admin",
      message: "Selected site translations deleted.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { deletedCount, selectedCount: selectedRows.length },
    });

    return NextResponse.json({ deletedCount });
  }

  if (scope === "site") {
    const requestedLocale = searchParams.get("locale") ?? "";
    const locale = resolvePhiLocaleCapability(requestedLocale)?.locale ?? "";
    const availableCodes = new Set(
      resolveTranslationTargetLocales(site.sourceLocale, config.availableLocales)
        .map((option) => option.code),
    );

    if (!locale || !availableCodes.has(locale)) {
      return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
    }

    const deletedCount = await deleteSiteTranslatedVariantsForLocale(site.id, locale);

    logRuntimeEvent("warn", "site.translation.variants.deleted", {
      area: "admin",
      message: "Site translation variants deleted for locale.",
      siteKey: site.key,
      userId: context.session?.userId ?? null,
      meta: { deletedCount, locale },
    });

    return NextResponse.json({ deletedCount });
  }

  const msgId = parsePositiveIntWithFallback(searchParams.get("msgId"), 0);
  const requestedLocale = searchParams.get("locale") ?? "";
  const locale = resolvePhiLocaleCapability(requestedLocale)?.locale ?? "";
  const availableCodes = new Set(
    resolveTranslationTargetLocales(site.sourceLocale, config.availableLocales)
      .map((option) => option.code),
  );

  if (!locale || !availableCodes.has(locale)) {
    return NextResponse.json({ error: "Unsupported locale." }, { status: 400 });
  }

  const deleted = await deleteSiteTranslation({
    siteId: site.id,
    msgId,
    locale,
  });
  if (!deleted) {
    return NextResponse.json({ error: "Translation not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.translation.deleted", {
    area: "admin",
    message: "Site translation deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { msgId, locale },
  });

  return NextResponse.json({});
}
