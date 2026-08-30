import { NextRequest, NextResponse } from "next/server";

import {
  createSupportThread,
  listSupportThreadsForUser,
  SUPPORT_THREAD_STATUS_OPEN,
} from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, parsePositiveIntWithFallback, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function normalizeNullableString(value: unknown) {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
}

function normalizeInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeIdArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) => normalizeInteger(entry))
        .filter((entry): entry is number => Number.isInteger(entry) && (entry ?? 0) > 0)
    : [];
}

function parseOptionalInt(value: string | null) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseBoolean(value: string | null) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parsePositiveIntWithFallback(searchParams.get("page"), 1);
  const pageSize = Math.min(parsePositiveIntWithFallback(searchParams.get("pageSize"), 25), 100);
  const result = await listSupportThreadsForUser(site.id, userId, {
    ticketId: parseOptionalInt(searchParams.get("ticketId")),
    type: parseOptionalInt(searchParams.get("type")),
    unreadOnly: parseBoolean(searchParams.get("unreadOnly")),
    page,
    pageSize,
  });

  return NextResponse.json({
    rows: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const message = normalizeString(body.message);
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  let thread;
  try {
    thread = await createSupportThread({
      siteId: site.id,
      ticketId: normalizeInteger(body.ticketId),
      type: normalizeInteger(body.type) ?? undefined,
      status: normalizeInteger(body.status) ?? SUPPORT_THREAD_STATUS_OPEN,
      subject: normalizeNullableString(body.subject),
      flags: normalizeInteger(body.flags) ?? 0,
      recipientUserIds: normalizeIdArray(body.recipientUserIds),
      recipientTeamIds: normalizeIdArray(body.recipientTeamIds),
      message,
      messageMarkdown: normalizeNullableString(body.messageMarkdown),
      messageMeta: normalizeJsonRecord(body.messageMeta),
      createdByUserId: userId,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid support thread request." },
      { status: 400 },
    );
  }
  if (!thread) {
    return NextResponse.json({ error: "Thread or ticket context not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.thread.created", {
    area: "support",
    message: "Support thread created.",
    siteKey: site.key,
    userId,
    meta: {
      threadId: thread?.thread.id ?? null,
      ticketId: thread?.thread.ticketId ?? null,
    },
  });

  return NextResponse.json({ thread }, { status: 201 });
}
