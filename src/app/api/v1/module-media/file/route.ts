import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { isPhisModuleMediaKey, isPhisModuleMediaPackageName } from "@/lib/module-media";
import { importModuleMediaFile } from "@/lib/module-media-import";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * Importing one declared file of a Module package into the Site Space, as an ordinary Asset.
 *
 * Multipart: the bytes in `file`, the rest as fields (`package`, `key`, `folder`, `alt`, `title`,
 * `originalName`). Never a path -- Core reads nothing from a disk it was named. Internal token only, the
 * Site named by `x-phis-site-key`. The Storage Provider, the content checks and the quota are the ones an
 * upload meets (`importModuleMediaFile`); a refusal is an answer in the body, not an HTTP error.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : null;
  };
  const file = form?.get("file");
  const packageName = field("package");
  const key = field("key");
  const folder = field("folder") || null;
  const alt = field("alt");
  const originalName = field("originalName");
  if (
    !(file instanceof Blob) || !isPhisModuleMediaPackageName(packageName) || !isPhisModuleMediaKey(key)
    || (folder !== null && !isPhisModuleMediaKey(folder)) || !alt?.trim() || !originalName?.trim()
  ) {
    return NextResponse.json(
      { error: "file, package, key, alt and originalName are required; folder is a key or absent." },
      { status: 400 },
    );
  }

  const result = await importModuleMediaFile(site, {
    packageName,
    key,
    folderKey: folder,
    alt,
    title: field("title")?.trim() || null,
    originalName: originalName.replace(/^.*[\\/]/, ""),
    body: Buffer.from(await file.arrayBuffer()),
  });
  logRuntimeEvent(result.status === "refused" ? "warn" : "info", "module.media.file", {
    siteKey: site.key,
    meta: { package: result.packageName, key: result.key, status: result.status, reason: result.reason },
  });
  return NextResponse.json({ result });
}
