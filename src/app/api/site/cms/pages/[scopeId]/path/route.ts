import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { changeSitePagePath, SitePagePathChangeError } from "@/db/site-pages";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import { requireSiteBuilderApiContext } from "@/lib/guards/site-admin-api";
import { logSiteCmsAuditEvent } from "@/lib/site-cms-audit";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ scopeId: string }> },
) {
  const guarded = await requireSiteBuilderApiContext(request);
  if (guarded.error) return guarded.error;
  const { scopeId: rawScopeId } = await context.params;
  const scopeId = Number.parseInt(rawScopeId, 10);
  const body = await request.json().catch(() => null) as { area?: unknown; path?: unknown } | null;
  const area = typeof body?.area === "string" ? body.area.trim().toLowerCase() : "";
  if (!Number.isSafeInteger(scopeId) || scopeId <= 0 || !isPhisCmsAreaKey(area) || typeof body?.path !== "string") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    const result = await changeSitePagePath(
      guarded.context!.site!.id,
      resolvePhisCmsAreaMask(area),
      scopeId,
      body.path,
    );
    logSiteCmsAuditEvent(PhiCmsAuditEvent.PagePathChanged, {
      request,
      siteKey: guarded.context!.site!.key,
      area,
      userId: guarded.context!.session!.userId,
      targetType: "page_scope",
      targetId: scopeId,
      meta: {
        oldPath: result.oldPath,
        newPath: result.path,
        references: result.references,
      },
    });
    return NextResponse.json({ ...result });
  } catch (error) {
    if (error instanceof SitePagePathChangeError) {
      const status = error.code === "page_not_found" ? 404 : error.code === "path_collision" ? 409 : 400;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    throw error;
  }
}
