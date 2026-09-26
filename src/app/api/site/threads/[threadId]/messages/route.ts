import { NextRequest } from "next/server";

import {
  readPhisSiteThreadId,
  readPhisSiteThreadMessageBody,
  writePhisSiteThreadMessage,
} from "@/lib/site-thread-message-route";

export const dynamic = "force-dynamic";

/**
 * Writing into one conversation, addressed by path.
 *
 * The write itself is shared with `/api/site/threads/messages`, which is the same operation with the
 * conversation in the body -- that is the shape a declared Form submits in. Two addresses, one write: the
 * id is the only difference and everything after it is the same code.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const body = await readPhisSiteThreadMessageBody(request);
  return writePhisSiteThreadMessage(request, {
    threadId: readPhisSiteThreadId((await params).threadId),
    body,
  });
}
