import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { readPhisMediaImportFolderRequest } from "@/lib/media-import";
import { ensureSiteMediaImportFolder } from "@/lib/site-media-import";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * The Folder of the Site Space a `phis media import` puts its files into, resolved once before the first.
 *
 * JSON, exactly one of `{ "path": ["Products", "PhiVoice"] }` -- every missing Folder along it made, under
 * the lock the Module media import makes its Folders under -- or `{ "id": 42 }`. Answers
 * `{ result: { status: "ready", folderId, path, created } }`, or `{ result: { status: "refused", reason,
 * detail } }`: a refusal is an answer, not an HTTP error. Internal token only, the Site named by
 * `x-phis-site-key`.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const folder = readPhisMediaImportFolderRequest(await request.json().catch(() => null));
  if (!folder) {
    return NextResponse.json(
      { error: "Exactly one of path (Folder names from the root) or id (a Folder id) is required." },
      { status: 400 },
    );
  }
  const result = await ensureSiteMediaImportFolder(site, folder);
  logRuntimeEvent(result.status === "refused" ? "warn" : "info", "media.import.folder", {
    siteKey: site.key,
    meta: result.status === "refused"
      ? { status: result.status, reason: result.reason }
      : { status: result.status, folderId: result.folderId, created: result.created.length },
  });
  return NextResponse.json({ result });
}
