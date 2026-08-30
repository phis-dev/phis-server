import { NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { createJsonResponse } from "@/lib/api-response";
import { getApiV1TokenMode, guardApiV1 } from "@/lib/api-v1-guard";
import { getPhiServerConfig } from "@/lib/config";
import { DEFAULT_LOCALE } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { getConfiguredTranslationSupportedLocalesSync } from "@/lib/translation-locale-options";

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "x-phi-token",
};

export async function GET(request: Request) {
  const guardError = guardApiV1(request);
  if (guardError) {
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      guardError.headers.set(key, value);
    });
    return guardError;
  }

  const tokenMode = getApiV1TokenMode(request);
  if (tokenMode === "public") {
    const config = await getPhiServerConfig();
    if (config.translation?.allowPublicReads !== true) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: CORS_HEADERS });
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

    const response = createJsonResponse(
      request,
      {
        defaultLocale: DEFAULT_LOCALE,
        locales: supportedLocales,
        labels,
        options,
      },
      { cacheControl: CACHE_CONTROL },
    );
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    return response;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404, headers: CORS_HEADERS });
  }

  const config = await getSiteRuntimeConfig(site.id);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404, headers: CORS_HEADERS });
  }

  const labels = config.availableLocales.reduce<Record<string, string>>((acc, option) => {
    acc[option.code] = option.label;
    return acc;
  }, {});

  const locales = config.availableLocales.map((option) => option.code);

  const response = createJsonResponse(
    request,
    {
      defaultLocale: config.defaultLocale,
      locales,
      labels,
      options: config.availableLocales,
    },
    { cacheControl: CACHE_CONTROL },
  );
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
