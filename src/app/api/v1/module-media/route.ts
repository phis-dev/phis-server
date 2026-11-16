import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { listSiteModuleMediaFiles, listSiteModuleMediaFolders, isSiteModuleMediaBound } from "@/db/site-module-media";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";
import type { PhisModuleMediaMapping } from "@/lib/module-media";

export const dynamic = "force-dynamic";

/**
 * Every Module media row of the Site, with the digest each file was written from.
 *
 * What `phis module media sync` reads to post only the files that are missing or changed, and what `list`
 * reads to say what each declared name stands for. Internal token only: it is an operator's view, with
 * digests and hand bindings, where `/api/v1/site/module-media` gives the Site's runtime ids alone.
 */
export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const [files, folders] = await Promise.all([
    listSiteModuleMediaFiles(getPool(), site.id),
    listSiteModuleMediaFolders(getPool(), site.id),
  ]);
  const mapping: PhisModuleMediaMapping = {
    files: files.map((row) => ({
      packageName: row.packageName, key: row.key, assetId: row.assetId,
      sourceChecksum: row.sourceChecksum, bound: isSiteModuleMediaBound(row),
    })),
    folders: folders.map((row) => ({
      packageName: row.packageName, key: row.key, folderId: row.folderId, bound: isSiteModuleMediaBound(row),
    })),
  };
  return NextResponse.json(mapping, { headers: { "cache-control": "private, no-store" } });
}
