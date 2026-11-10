import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { getFormGuardSecret, getFormTimingWindow } from "@/lib/form-config";
import { issueFormGuard } from "@/lib/form-guard";
import {
  FORM_DEFINITION_FLAG_REQUIRES_GUARD,
  getPublishedFormDefinitionBySiteIdAndFormId,
} from "@/db/form-definitions";
import { requireSiteFromRequest } from "@/lib/site-context";

export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const form = searchParams.get("form")?.trim().toLowerCase() ?? "";

  if (!form) {
    return NextResponse.json({ error: "Unsupported form." }, { status: 400 });
  }

  const definition = await getPublishedFormDefinitionBySiteIdAndFormId(site.id, form);
  const isPublishedRegistryForm = Boolean(
    definition &&
    (definition.flags & FORM_DEFINITION_FLAG_REQUIRES_GUARD) !== 0,
  );
  const isCoreGuardedForm =
    form === "@phis/ui/modules/public/forms/contact" ||
    form === "@phis/ui/modules/auth/forms/registration";
  if (!isPublishedRegistryForm && !isCoreGuardedForm) {
    return NextResponse.json({ error: "Unsupported form." }, { status: 400 });
  }

  const formGuard = issueFormGuard({
    form,
    siteKey: site.key,
    secret: await getFormGuardSecret(site.id),
  });

  /*
   * The window the token is good for, as durations rather than instants: the browser measures them from
   * its own clock, which need not agree with this one. Without them it could only learn of expiry by
   * having a submit refused.
   */
  const { minAgeMs, maxAgeMs } = getFormTimingWindow(form);
  return NextResponse.json({
    form,
    siteKey: site.key,
    issuedAt: formGuard.issuedAt,
    formToken: formGuard.formToken,
    minSubmitMs: minAgeMs,
    maxSubmitMs: maxAgeMs,
  });
}
