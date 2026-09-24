import { NextRequest, NextResponse } from "next/server";

import { addThreadMessage, PhisThreadError } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeIdArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "number" && Number.isInteger(entry) ? entry : null))
        .filter((entry): entry is number => entry != null && entry > 0)
    : [];
}

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

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

  const threadId = parsePositiveId((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
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
      messageSourceLang: normalizeString(body.messageSourceLang) || null,
      // Normalized against who is writing: `Internal` needs Staff, and the flags Core owns are ignored.
      messageFlags: typeof body.messageFlags === "number" ? body.messageFlags : 0,
      assetIds: normalizeIdArray(body.assetIds),
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
