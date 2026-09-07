import { NextRequest, NextResponse } from "next/server";

import { listSiteModuleBlockUsage } from "@/db/site-pages";
import { isPhisCmsAreaKey, resolvePhisCmsAreaMask } from "@/lib/constants/cms-areas";
import { requireSiteBuilderApiContext } from "@/lib/guards/site-admin-api";

/**
 * What a Module currently draws on this Site's published pages.
 *
 * Asked before a Module is switched off, because that is the moment the answer changes something: the
 * blocks stay in their pages and stop being drawn, and nobody would see that happen. The question is
 * answered from the stored trees alone -- a node carries its owner inside its type -- so the control
 * plane needs no Module knowledge to answer it.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteBuilderApiContext(request);
  if (error) {
    return error;
  }

  const url = new URL(request.url);
  const area = (url.searchParams.get("area") ?? "public").trim().toLowerCase();
  const moduleId = (url.searchParams.get("moduleId") ?? "").trim();
  if (!isPhisCmsAreaKey(area)) {
    return NextResponse.json({ error: "Invalid CMS area." }, { status: 400 });
  }
  if (!moduleId) {
    return NextResponse.json({ error: "moduleId is required." }, { status: 400 });
  }

  const usage = await listSiteModuleBlockUsage(
    context!.site!.id,
    resolvePhisCmsAreaMask(area),
    moduleId,
  );

  return NextResponse.json({
    area,
    moduleId,
    usage,
    blocks: usage.reduce((total, entry) => total + entry.blocks, 0),
  });
}
