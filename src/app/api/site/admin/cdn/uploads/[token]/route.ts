import { NextRequest, NextResponse } from "next/server";

import { requireOwnPhisCdnUpload, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PhisCdnUploadStatusCode } from "@/lib/cdn-core";
import { abortPhisCdnUpload } from "@/lib/cdn-publish.mts";
import { nextCdnError, presentPhisCdnUploadState } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

/** Where an upload stands (`PhisCdnUploadStateV1`); the page asks until `published` or `failed`. */
export async function GET(request: NextRequest, { params }: Params) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const own = await requireOwnPhisCdnUpload(admin.value, (await params).token);
  if (!own.ok) return own.response;
  return NextResponse.json(await presentPhisCdnUploadState(admin.value.target, own.upload));
}

/** Aborts an upload that is not hashing or published yet: its parts are given up, its reservation back. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const own = await requireOwnPhisCdnUpload(admin.value, (await params).token);
  if (!own.ok) return own.response;
  const open = own.upload.status === PhisCdnUploadStatusCode.Pending || own.upload.status === PhisCdnUploadStatusCode.Uploading;
  if (!open || !await abortPhisCdnUpload(getPool(), admin.value.target, own.upload, PhisCdnUploadStatusCode.Aborted, {
    code: "aborted", message: "Aborted on the CDN page.",
  })) {
    return nextCdnError("upload_state", "This upload is hashing or ended and can no longer be aborted.", 409);
  }
  return new NextResponse(null, { status: 204 });
}
