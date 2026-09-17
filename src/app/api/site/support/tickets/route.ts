import { NextRequest, NextResponse } from "next/server";

import {
  createSupportTicket,
  listSupportTicketsForSite,
  SUPPORT_TICKET_CHANNEL_INTERNAL,
  SUPPORT_TICKET_PRIORITY_NORMAL,
  SUPPORT_TICKET_STATUS_NEW,
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

function parseOptionalInt(value: string | null) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
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
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = parsePositiveIntWithFallback(searchParams.get("page"), 1);
  const pageSize = Math.min(parsePositiveIntWithFallback(searchParams.get("pageSize"), 25), 100);
  const result = await listSupportTicketsForSite(site.id, {
    search: searchParams.get("search")?.trim() ?? searchParams.get("q")?.trim() ?? "",
    status: parseOptionalInt(searchParams.get("status")),
    channel: parseOptionalInt(searchParams.get("channel")),
    assigneeUserId: parseOptionalInt(searchParams.get("assigneeUserId")),
    queueId: parseOptionalInt(searchParams.get("queueId")),
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
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const subject = normalizeString(body.subject);
  if (!subject) {
    return NextResponse.json({ error: "Subject is required." }, { status: 400 });
  }

  const typeId = normalizeInteger(body.typeId);
  if (!typeId) {
    return NextResponse.json({ error: "typeId is required." }, { status: 400 });
  }

  // The ticket and its thread are written together, so the first thing said is part of opening one.
  const message = normalizeString(body.message);
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }

  const ticket = await createSupportTicket({
    siteId: site.id,
    typeId,
    message,
    messageMarkdown: normalizeNullableString(body.messageMarkdown),
    status: normalizeInteger(body.status) ?? SUPPORT_TICKET_STATUS_NEW,
    channel: normalizeInteger(body.channel) ?? SUPPORT_TICKET_CHANNEL_INTERNAL,
    priority: normalizeInteger(body.priority) ?? SUPPORT_TICKET_PRIORITY_NORMAL,
    severity: normalizeInteger(body.severity),
    requesterUserId: normalizeInteger(body.requesterUserId),
    requesterEmail: normalizeNullableString(body.requesterEmail),
    assigneeUserId: normalizeInteger(body.assigneeUserId),
    queueId: normalizeInteger(body.queueId),
    subject,
    summary: normalizeNullableString(body.summary),
    meta: normalizeJsonRecord(body.meta),
    firstResponseDueAt: normalizeNullableString(body.firstResponseDueAt),
    resolutionDueAt: normalizeNullableString(body.resolutionDueAt),
    createdByUserId: context.session?.userId ?? null,
  });

  logRuntimeEvent("info", "site.support.ticket.created", {
    area: "support",
    message: "Support ticket created.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: {
      ticketId: ticket?.ticket.id ?? null,
      typeId: ticket?.ticket.typeId ?? null,
    },
  });

  return NextResponse.json({ ticket }, { status: 201 });
}
