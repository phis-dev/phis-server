import { after, NextRequest, NextResponse } from "next/server";

import { logPhisCdnAdminEvent, requireOwnPhisCdnUpload, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PhisCdnUploadStatusCode } from "@/lib/cdn-core";
import { completePhisCdnBrowserUpload, finishPhisCdnUpload } from "@/lib/cdn-publish.mts";
import { nextCdnError, presentPhisCdnUploadState, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Ends the sending: answered `202` with `state: "hashing"` once every part is in. After the response the
 * assembly is completed, its size compared, its SHA-256 computed from the bucket -- each part against the
 * digest the page sent -- and the file recorded with origin `upload`; the page asks `GET uploads/{token}`
 * until it reads `published` or `failed`. `409 parts_missing` with `uploaded` where parts are missing.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const own = await requireOwnPhisCdnUpload(admin.value, (await params).token);
  if (!own.ok) return own.response;
  if (own.upload.status !== PhisCdnUploadStatusCode.Pending && own.upload.status !== PhisCdnUploadStatusCode.Uploading) {
    return nextCdnError("upload_state", "This upload is not open for completion.", 409);
  }
  try {
    const completed = await completePhisCdnBrowserUpload(getPool(), admin.value.target, own.upload);
    if (!completed.ok) {
      return nextCdnError("parts_missing", "Some parts are not in the storage yet.", 409, { uploaded: completed.uploaded });
    }
  } catch (error) {
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  }
  const hashing = { ...own.upload, status: PhisCdnUploadStatusCode.Hashing };
  after(async () => {
    const outcome = await finishPhisCdnUpload(getPool(), admin.value.target, hashing);
    logPhisCdnAdminEvent(outcome.ok ? "cdn.published" : "cdn.upload.failed", admin.value, request, outcome.ok
      ? { key: hashing.key, token: hashing.token, sizeBytes: hashing.sizeBytes, sha256: outcome.row.sha256 }
      : { key: hashing.key, token: hashing.token, code: outcome.code, reason: outcome.message });
  });
  return NextResponse.json(await presentPhisCdnUploadState(admin.value.target, hashing), { status: 202 });
}
