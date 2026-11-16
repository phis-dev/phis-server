import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { listSiteModuleMediaFiles, listSiteModuleMediaFolders } from "@/db/site-module-media";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";
import type { PhisModuleMediaSiteMapping } from "@/lib/module-media";

export const dynamic = "force-dynamic";

/**
 * Which Asset or Media Folder stands for each name a Module package declares, for the Site's runtime.
 *
 * Ids only (package, key -> id), and only names whose target exists; a name that is gone is absent, which
 * the preset builder reads as `null`. It changes on `phis module media sync` and on a rebind, so the Site
 * reads it again after a restart and after a short time. Same access rule as the precedent `@phis/ui` calls
 * the same way, `/api/v1/site/capabilities`: the internal token and the Site named by `x-phis-site-key`.
 */
export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const [files, folders] = await Promise.all([
    listSiteModuleMediaFiles(getPool(), site.id),
    listSiteModuleMediaFolders(getPool(), site.id),
  ]);
  const mapping: PhisModuleMediaSiteMapping = { assets: {}, folders: {} };
  for (const row of files) {
    if (row.assetId !== null) (mapping.assets[row.packageName] ??= {})[row.key] = row.assetId;
  }
  for (const row of folders) {
    if (row.folderId !== null) (mapping.folders[row.packageName] ??= {})[row.key] = row.folderId;
  }
  return createJsonResponse(request, mapping, { cacheControl: "private, no-store" });
}
