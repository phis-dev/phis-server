import { NextRequest, NextResponse } from "next/server";

import { requireSiteBuilderApiContext } from "@/lib/guards/site-admin-api";
import {
  buildExternalDocumentLanguageSample,
  loadExternalDocument,
} from "@/lib/external-document";
import { detectTranslationSourceLocale } from "@/lib/translations";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as {
    sourceUrl?: unknown;
    format?: unknown;
  } | null;
  const sourceUrl = typeof body?.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  const format = body?.format === "html" ? "html" : body?.format === "markdown" ? "markdown" : null;
  if (!sourceUrl || !format) {
    return NextResponse.json({ error: "sourceUrl and format are required." }, { status: 400 });
  }

  try {
    const document = await loadExternalDocument(sourceUrl);
    const sample = buildExternalDocumentLanguageSample(document, format);
    const sourceLocale = await detectTranslationSourceLocale({
      text: sample,
      targetLocale: site.sourceLocale,
    });
    return NextResponse.json({ sourceLocale, supported: sourceLocale != null });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Language detection failed.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
