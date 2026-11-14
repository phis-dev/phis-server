import { NextRequest, NextResponse } from "next/server";

import { getMediaUploadSessionByToken, renewMediaUploadSessionHeartbeat } from "@/db/media";
import { requireMediaSpaceWriteContext } from "@/lib/guards/site-media-api";
import { nextMediaError } from "../../_helpers";

/**
 * Where a page delivering an upload in parts says it still is.
 *
 * Renewed every `PHI_MEDIA_UPLOAD_HEARTBEAT_INTERVAL_MS` while parts are being sent, and nothing else: no
 * body, no state change, one conditional update. What it buys is the difference between a session with a
 * page writing into it and one whose page crashed without a word -- the second may be continued by the next
 * attempt at the same file (`isPhiMediaUploadResumable`), the first must not be.
 *
 * Only for the session's own actor, and answered 404 for every session that is not being delivered in parts
 * right now, so the page can stop beating instead of renewing nothing for the rest of the upload.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } },
) {
  const token = (await Promise.resolve(params)).token?.trim() || "";
  if (!token) {
    return nextMediaError("missing_upload_token", "Missing upload token.", 400);
  }
  const staged = await getMediaUploadSessionByToken(token);
  const context = await requireMediaSpaceWriteContext(request, async () => staged?.spaceId ?? null);
  if (context.error || !context.site || !context.session || !staged || staged.siteId !== context.site.id) {
    return nextMediaError("upload_session_not_found", "Upload session not found.", 404);
  }
  const renewed = await renewMediaUploadSessionHeartbeat(token, context.site.id, context.session.userId);
  return renewed
    ? new NextResponse(null, { status: 204 })
    : nextMediaError("upload_session_not_found", "Upload session not found.", 404);
}
