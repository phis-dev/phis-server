import { NextRequest, NextResponse } from "next/server";

import { addSupportThreadMessage } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeNullableString(value: unknown) {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
}

function normalizeJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
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
  const bodyText = normalizeString(body.bodyText);
  if (!bodyText) {
    return NextResponse.json({ error: "bodyText is required." }, { status: 400 });
  }

  const thread = await addSupportThreadMessage({
    siteId: site.id,
    threadId,
    bodyText,
    bodyMarkdown: normalizeNullableString(body.bodyMarkdown),
    meta: normalizeJsonRecord(body.meta),
    authorUserId: userId,
  });

  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.thread.message.created", {
    area: "support",
    message: "Support thread message created.",
    siteKey: site.key,
    userId,
    meta: { threadId },
  });

  return NextResponse.json({ thread }, { status: 201 });
}
