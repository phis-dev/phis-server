import { NextRequest, NextResponse } from "next/server";

import { requireOwnPhisCdnUpload, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PHIS_CDN_UPLOAD_TTL_MS } from "@/lib/cdn-publish.mts";
import { nextCdnError } from "@/lib/cdn-server";
import { renewSiteCdnUpload } from "@/db/site-cdn.mts";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Says the page is still sending: the upload's expiry moves a day ahead. `409` once it is no longer open. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const own = await requireOwnPhisCdnUpload(admin.value, (await params).token);
  if (!own.ok) return own.response;
  if (!await renewSiteCdnUpload(getPool(), own.upload.token, PHIS_CDN_UPLOAD_TTL_MS)) {
    return nextCdnError("upload_state", "This upload is not open for parts any more.", 409);
  }
  return new NextResponse(null, { status: 204 });
}
