import { NextResponse } from "next/server";

import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  getPublishedFormDefinitionBySiteIdAndFormId,
  listPublishedFormDefinitionsBySiteId,
} from "@/db/form-definitions";

export async function GET(request: Request) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const form = searchParams.get("form")?.trim().toLowerCase() ?? "";

  if (form) {
    const definition = await getPublishedFormDefinitionBySiteIdAndFormId(site.id, form);
    if (!definition) {
      return NextResponse.json({ error: "Form not found." }, { status: 404 });
    }

    return createJsonResponse(request, {
      form: definition,
    });
  }

  const forms = await listPublishedFormDefinitionsBySiteId(site.id);
  return createJsonResponse(request, {
    forms,
  });
}
