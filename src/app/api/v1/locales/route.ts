import { NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { createJsonResponse } from "@/lib/api-response";
import { getApiV1TokenMode, guardApiV1 } from "@/lib/api-v1-guard";
import { getPhisConfig } from "@/lib/config";
import { PHI_CANONICAL_SOURCE_LOCALE } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";

export async function GET(request: Request) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }

  const tokenMode = getApiV1TokenMode(request);
  if (tokenMode === "public") {
    const config = await getPhisConfig();
    if (config.translation?.allowPublicReads !== true) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const supportedLocales = getConfiguredTranslationSupportedLocalesSync();
    const labels = supportedLocales.reduce<Record<string, string>>((acc, code) => {
      try {
        const display = new Intl.DisplayNames([code], { type: "language" }).of(code);
        acc[code] = display ?? code.toUpperCase();
      } catch {
        acc[code] = code.toUpperCase();
      }
      return acc;
    }, {});

    const options = supportedLocales.map((code) => ({
      code,
      label: labels[code] ?? code.toUpperCase(),
    }));

    return createJsonResponse(
      request,
      {
        defaultLocale: PHI_CANONICAL_SOURCE_LOCALE,
        locales: supportedLocales,
        labels,
        options,
      },
      { cacheControl: CACHE_CONTROL },
    );
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const labels = config.availableLocales.reduce<Record<string, string>>((acc, option) => {
    acc[option.code] = option.label;
    return acc;
  }, {});

  const locales = config.availableLocales.map((option) => option.code);

  return createJsonResponse(
    request,
    {
      defaultLocale: config.defaultLocale,
      locales,
      labels,
      options: config.availableLocales,
    },
    { cacheControl: CACHE_CONTROL },
  );
}
