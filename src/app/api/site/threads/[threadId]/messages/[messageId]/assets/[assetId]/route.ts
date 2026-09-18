import { NextRequest, NextResponse } from "next/server";

import { getMediaAssetBySiteAndId } from "@/db/media";
import { getMediaStorageProfile } from "@/db/media-spaces";
import { readThreadMessageAsset } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";

export const dynamic = "force-dynamic";

function readId(value: string) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The bytes of one attachment, reached through the message that names it.
 *
 * One route for all of it. A customer's upload in their own User Space, a Supporter's in theirs, a file
 * an Add-on imported into its own Space -- the reader is decided the same way each time, because none of
 * the questions this route asks is about where the bytes sit. Who may read an attachment is who may read
 * the message it hangs on, and that answer is the thread's own predicate, asked once
 * ([design/THREADS.md](../../../../../../../../design/THREADS.md) section 5).
 *
 * Such an Asset's delivery policy is `Internal`, set when it was attached. No address reaches it by its
 * own id, whichever Space holds it, so this is the only way to its bytes -- and every part of the
 * address is checked against the others, which is why guessing an id gets nowhere the thread has not
 * already admitted the reader to.
 *
 * Streamed rather than read: delivery only moves bytes, and holding the object would make the largest
 * one a Site accepts the memory a single download costs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string; messageId: string; assetId: string }> },
) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || userId == null) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { threadId, messageId, assetId } = await params;
  const ids = {
    threadId: readId(threadId),
    messageId: readId(messageId),
    assetId: readId(assetId),
  };
  if (ids.threadId == null || ids.messageId == null || ids.assetId == null) {
    return new NextResponse(null, { status: 404 });
  }

  const link = await readThreadMessageAsset({
    siteId: site.id,
    reader: { kind: "user", userId },
    threadId: ids.threadId,
    messageId: ids.messageId,
    assetId: ids.assetId,
  });
  // Out of reach and absent answer alike. Anything else would say that a conversation exists.
  if (!link) {
    return new NextResponse(null, { status: 404 });
  }

  const asset = await getMediaAssetBySiteAndId(site.id, link.assetId);
  if (!asset) {
    return new NextResponse(null, { status: 404 });
  }
  const profile = await getMediaStorageProfile(site.id, asset.storageProfileId);
  if (!profile) {
    return new NextResponse(null, { status: 404 });
  }
  const storage = await createPhisMediaStorageServiceForProfile(profile, site.key);
  const head = await storage.headObject(asset.storageKey);
  const body = head ? await storage.getObjectStream(asset.storageKey) : null;
  if (!head || !body) {
    return new NextResponse(null, { status: 404 });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": head.contentType || asset.contentType,
      "content-length": String(head.byteSize),
      // Never cached by anything in front of the Site: what may be read here is a per-reader answer.
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${encodeURIComponent(asset.originalName)}"`,
    },
  });
}
