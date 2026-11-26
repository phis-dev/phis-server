import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent, normalizeLogThrowable } from "@/lib/log";
import { PhisMediaImportQuery } from "@/lib/media-import";
import { PhiMediaUploadAbort, watchPhiMediaUploadBody } from "@/lib/media-upload-stream";
import { importSiteMediaFile } from "@/lib/site-media-import";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

/**
 * One local file of `phis media import` into the Site Space, as an ordinary Asset.
 *
 * The body is the file itself, `content-length` its size; it is streamed, never parsed as a form, so a
 * file of the Site's object limit is not held. The query carries `name` (the file name, required),
 * `folder` (a Folder id from `/api/v1/media/import/folder`, or absent for the root), `alt` and `title`.
 * Never a path -- Core reads nothing from a disk it was named. Internal token only, the Site named by
 * `x-phis-site-key`.
 *
 * Answers `{ result: { status: "created" | "existing", assetId, name, contentType, bytes, folderId } }` or
 * `{ result: { status: "refused", reason, detail } }`, with 200 either way; 408 when the body stopped
 * arriving. A refusal that can be made before the body is read -- the Site's limit, the Folder, the
 * Profile, a full quota -- is made without reading it.
 */
export async function POST(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) return guardError;
  const site = await requireSiteFromRequest(request);
  if (!site) return NextResponse.json({ error: "site_not_found" }, { status: 404 });

  const query = new URL(request.url).searchParams;
  const text = (name: string) => query.get(name)?.trim() || null;
  const name = text(PhisMediaImportQuery.name);
  const folderRaw = text(PhisMediaImportQuery.folder);
  const lengthRaw = request.headers.get("content-length")?.trim() ?? "";
  const byteLength = /^\d+$/u.test(lengthRaw) ? Number(lengthRaw) : Number.NaN;
  const folderId = folderRaw === null ? null : /^\d+$/u.test(folderRaw) ? Number(folderRaw) : Number.NaN;
  if (
    !name || !request.body || !Number.isSafeInteger(byteLength)
    || (folderId !== null && (!Number.isSafeInteger(folderId) || folderId <= 0))
  ) {
    return NextResponse.json(
      { error: "The body is the file with its content-length; name is required, folder is a Folder id or absent." },
      { status: 400 },
    );
  }

  const watch = watchPhiMediaUploadBody(request.body, { clientSignal: request.signal });
  try {
    const result = await importSiteMediaFile(site, {
      body: watch.body,
      byteLength,
      signal: watch.signal,
      folderId,
      originalName: name,
      alt: text(PhisMediaImportQuery.alt),
      title: text(PhisMediaImportQuery.title),
    });
    logRuntimeEvent(result.status === "refused" ? "warn" : "info", "media.import.file", {
      siteKey: site.key,
      meta: result.status === "refused"
        ? { status: result.status, reason: result.reason, bytes: byteLength }
        : { status: result.status, assetId: result.assetId, bytes: result.bytes },
    });
    return NextResponse.json({ result });
  } catch (error) {
    const abortedBy = watch.abortedBy();
    if (abortedBy) {
      logRuntimeEvent("warn", "media.import.aborted", {
        siteKey: site.key,
        message: abortedBy === PhiMediaUploadAbort.Stalled ? "The import body stalled." : "The client went away mid-body.",
        meta: { bytes: byteLength, receivedBytes: watch.receivedBytes() },
      });
      return NextResponse.json({ error: abortedBy === PhiMediaUploadAbort.Stalled ? "upload_stalled" : "upload_abandoned" }, { status: 408 });
    }
    logRuntimeEvent("error", "media.import.failed", {
      siteKey: site.key,
      error: normalizeLogThrowable(error),
      meta: { bytes: byteLength, receivedBytes: watch.receivedBytes() },
    });
    return NextResponse.json({ error: "import_failed", message: error instanceof Error ? error.message : "Import failed." }, { status: 500 });
  } finally {
    watch.release();
  }
}
