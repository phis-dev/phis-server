import { NextResponse } from "next/server";

import { readSiteReadMarker } from "@/db/site-read-marker";
import { getSiteRuntimeConfig } from "@/db/sites";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { resolveSiteLocaleCapabilities } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import { getTranslationChangeMarkers } from "@/lib/translations";

export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const [config, translationMarkers, readMarker] = await Promise.all([
    getSiteRuntimeConfig(site.id),
    getTranslationChangeMarkers(site.id),
    readSiteReadMarker(site.id),
  ]);
  if (!config) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  return createJsonResponse(request, {
    site: {
      id: site.id,
      ...config,
      /*
       * The language the Site's own words are written in -- what a Builder types, what an entry is written
       * in when nobody says otherwise, what every translation starts from. Operator configuration, not the
       * default a visitor is shown, which is `defaultLocale` and may differ.
       */
      sourceLocale: site.sourceLocale,
      // What each served locale means, so a Site process resolves a request that names one itself.
      localeCapabilities: resolveSiteLocaleCapabilities(config.availableLocales.map((option) => option.code)),
      translationMarkers,
      readMarker: readMarker ?? "0",
    },
  });
}
