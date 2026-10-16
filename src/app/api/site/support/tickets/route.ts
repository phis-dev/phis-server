import { NextRequest, NextResponse } from "next/server";

import {
  createSupportTicket,
  listSupportTicketsForSite,
  SUPPORT_TICKET_CHANNEL_INTERNAL,
  SUPPORT_TICKET_PRIORITY_NORMAL,
} from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeNullableInteger,
  normalizeNullableString,
  normalizeString,
  parsePhiPagination,
  readRequestBody,
} from "@/lib/helpers/request";
import { toPhiRecord } from "@/lib/helpers/record";

export const dynamic = "force-dynamic";

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
  const { page, pageSize } = parsePhiPagination(searchParams);
  const result = await listSupportTicketsForSite(site.id, {
    search: searchParams.get("search")?.trim() ?? searchParams.get("q")?.trim() ?? "",
    // `open` is every ticket still to be worked on; a number is one status.
    status: searchParams.get("status") === "open" ? "open" : normalizeNullableInteger(searchParams.get("status")),
    channel: normalizeNullableInteger(searchParams.get("channel")),
    assigneeUserId: normalizeNullableInteger(searchParams.get("assigneeUserId")),
    queueId: normalizeNullableInteger(searchParams.get("queueId")),
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

  const typeId = normalizeNullableInteger(body.typeId);
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
    status: normalizeNullableInteger(body.status) ?? undefined,
    channel: normalizeNullableInteger(body.channel) ?? SUPPORT_TICKET_CHANNEL_INTERNAL,
    priority: normalizeNullableInteger(body.priority) ?? SUPPORT_TICKET_PRIORITY_NORMAL,
    severity: normalizeNullableInteger(body.severity),
    requesterUserId: normalizeNullableInteger(body.requesterUserId),
    requesterEmail: normalizeNullableString(body.requesterEmail),
    assigneeUserId: normalizeNullableInteger(body.assigneeUserId),
    queueId: normalizeNullableInteger(body.queueId),
    subject,
    summary: normalizeNullableString(body.summary),
    meta: toPhiRecord(body.meta),
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
