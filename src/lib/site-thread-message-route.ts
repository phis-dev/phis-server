import { NextRequest, NextResponse } from "next/server";

import { addThreadMessage, PhisThreadError } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeNullableInteger,
  normalizePositiveIdArray,
  normalizeString,
  readRequestBody,
} from "@/lib/helpers/request";

/**
 * Writing one message into one conversation, for the two addresses that offer it.
 *
 * The conversation arrives in the path for a caller holding a REST client, and in the body for a Form:
 * a declared Form handler relays to one static path and submits values, and which record it acts on is
 * one of them. Both are the same write, so both are this function -- the id is where they differ and
 * nothing else may.
 *
 * Nothing here decides who may write. `addThreadMessage` reads the row through the caller's own
 * visibility predicate, so a conversation this reader cannot see is not found rather than refused, and an
 * archived one answers with the reason. That is the only place the rule exists, which is why an id from a
 * browser is safe to take at face value here.
 */
export async function writePhisSiteThreadMessage(
  request: NextRequest,
  { threadId, body }: { threadId: number | null; body: Record<string, unknown> },
) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const message = normalizeString(body.message);
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  let thread;
  try {
    thread = await addThreadMessage({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId },
      message,
      messageMarkdown: normalizeString(body.messageMarkdown) || null,
      // Normalized against who is writing: `Internal` needs Staff, and the flags Core owns are ignored. A
      // number from a REST caller, a string from a Form's choice: the same flags either way.
      messageFlags: normalizeNullableInteger(body.messageFlags) ?? 0,
      // Dropped rather than refused where an entry is no id: one that does not exist is caught where
      // every other one is -- in the write itself.
      assetIds: normalizePositiveIdArray(body.assetIds),
    });
  } catch (cause) {
    if (cause instanceof PhisThreadError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.thread.message.created", {
    area: "threads",
    message: "Thread message written.",
    siteKey: site.key,
    userId,
    meta: { threadId },
  });

  return NextResponse.json({ thread }, { status: 201 });
}

export async function readPhisSiteThreadMessageBody(request: NextRequest) {
  return readRequestBody(request);
}
