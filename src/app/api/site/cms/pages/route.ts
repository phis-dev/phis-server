import { NextRequest, NextResponse } from "next/server";

import { listSitePageScopes } from "@/db/site-pages";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { requireSiteReviewApiContext } from "@/lib/guards/site-admin-api";
import { createPhiPageReference } from "@/lib/internal-references";

function normalizeArea(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "public";
}

/*
 * Read by everybody who writes for the Site, not only by those who build it: an Author linking a News
 * entry to a Page picks it from this list (REFERENCES.md, stable internal targets). Moving a Page stays
 * structure authoring.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }

  const url = new URL(request.url);
  const area = normalizeArea(url.searchParams.get("area"));
  if (!isPhisCmsAreaKey(area)) {
    return NextResponse.json({ error: "Invalid CMS area." }, { status: 400 });
  }

  const areaMask = resolvePhisCmsAreaMask(area);
  const pages = await listSitePageScopes(context!.site!.id, areaMask);

  return NextResponse.json({
    area,
    areaId: areaMask,
    pages: pages.map((page) => ({
      id: page.id,
      reference: createPhiPageReference(page.ownerModuleId && page.presetKey
        ? { kind: "module", ownerModuleId: page.ownerModuleId, presetKey: page.presetKey }
        : { kind: "site", pageScopeId: page.id }),
      area,
      areaId: page.areaMask,
      path: page.path,
      /* The address a publish would move this Page to. Null while nothing stands. */
      pendingPath: page.draftPath,
      ownerModuleId: page.ownerModuleId,
      presetKey: page.presetKey,
      tombstoned: page.tombstonedAt != null,
      publishedRevisionId: page.publishedRevisionId,
      workingDraftRevisionId: page.workingDraftRevisionId,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    })),
  });
}
