import { NextRequest, NextResponse } from "next/server";

import { listSitePageScopes } from "@/db/site-pages";
import { isPhiServerCmsAreaKey, resolvePhiServerCmsAreaMask } from "@/lib/constants/cms-areas";
import { requireSiteBuilderApiContext } from "@/lib/guards/site-admin-api";
import { createPhiPageReference } from "@/lib/internal-references";

function normalizeArea(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "public";
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const url = new URL(request.url);
  const area = normalizeArea(url.searchParams.get("area"));
  if (!isPhiServerCmsAreaKey(area)) {
    return NextResponse.json({ error: "Invalid CMS area." }, { status: 400 });
  }

  const areaMask = resolvePhiServerCmsAreaMask(area);
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
