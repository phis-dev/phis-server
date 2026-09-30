import { NextRequest, NextResponse } from "next/server";

import { addThreadParticipants, PhisThreadError } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { parseStrictPositiveInt, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeIdArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isInteger(entry) && entry > 0)
    : [];
}

/** Adds people or groups. It never removes: leaving is the participant's own flag, not somebody's edit. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const threadId = parseStrictPositiveInt((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  let thread;
  try {
    thread = await addThreadParticipants({
      siteId: site.id,
      threadId,
      reader: { kind: "user", userId },
      participantUserIds: normalizeIdArray(body.participantUserIds),
      participantGroupIds: normalizeIdArray(body.participantGroupIds),
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

  return NextResponse.json({ thread });
}
