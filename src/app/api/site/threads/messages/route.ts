import { NextRequest } from "next/server";

import { parseStrictPositiveInt } from "@/lib/helpers/request";
import {
  readPhisSiteThreadMessageBody,
  writePhisSiteThreadMessage,
} from "@/lib/site-thread-message-route";

export const dynamic = "force-dynamic";

/**
 * The same write as `/api/site/threads/{threadId}/messages`, with the conversation in the body.
 *
 * This is the address a declared Form submits to. A Form handler Provider relays to one static path and
 * sends the Form's values, and which conversation the message belongs to is one of them -- a hidden field
 * the Page fills from whatever the listing beside it selected. The REST address stays where it is for the
 * packages that hold a client and a thread id.
 *
 * Nothing is trusted more here than there: the id arrives from a browser either way, and the write reads
 * the row through the caller's own visibility predicate.
 */
export async function POST(request: NextRequest) {
  const body = await readPhisSiteThreadMessageBody(request);
  return writePhisSiteThreadMessage(request, {
    threadId: parseStrictPositiveInt(body.threadId),
    body,
  });
}
