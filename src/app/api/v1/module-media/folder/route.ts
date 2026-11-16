import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { isPhisModuleMediaKey, isPhisModuleMediaPackageName } from "@/lib/module-media";
import { importModuleMediaFolder } from "@/lib/module-media-import";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Importing one declared Media Folder of a Module package into the Site Space.
 *
 * The running Core does the import and the CLI only starts it (design/MODULE_MEDIA.md, section 5). Internal
 * token only, and the Site is named by `x-phis-site-key`. The answer says what happened to the name; a
 * refusal is an answer, not an HTTP error, so a run can go on and report every item.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parent = body?.parent ?? null;
  if (
    !isPhisModuleMediaPackageName(body?.package) || !isPhisModuleMediaKey(body?.key)
    || typeof body?.name !== "string" || (parent !== null && !isPhisModuleMediaKey(parent))
  ) {
    return NextResponse.json({ error: "package, key and name are required; parent is a key or absent." }, { status: 400 });
  }

  const result = await importModuleMediaFolder(site, {
    packageName: body.package, key: body.key, name: body.name, parentKey: parent,
  });
  logRuntimeEvent(result.status === "refused" ? "warn" : "info", "module.media.folder", {
    siteKey: site.key,
    meta: { package: result.packageName, key: result.key, status: result.status, reason: result.reason },
  });
  return NextResponse.json({ result });
}
