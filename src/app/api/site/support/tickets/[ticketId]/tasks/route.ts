import { NextRequest, NextResponse } from "next/server";

import {
  addSupportTicketTask,
  SUPPORT_TICKET_TASK_STATUS_OPEN,
  SUPPORT_TICKET_TASK_TYPE_INTERNAL,
} from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, readRequestBody } from "@/lib/helpers/request";

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

function normalizeJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseTicketId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const ticketId = parseTicketId((await params).ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const title = normalizeString(body.title);
  if (!title) {
    return NextResponse.json({ error: "Task title is required." }, { status: 400 });
  }

  const ticket = await addSupportTicketTask({
    siteId: site.id,
    ticketId,
    type: normalizeInteger(body.type) ?? SUPPORT_TICKET_TASK_TYPE_INTERNAL,
    status: normalizeInteger(body.status) ?? SUPPORT_TICKET_TASK_STATUS_OPEN,
    flags: normalizeInteger(body.flags) ?? 0,
    sortOrder: normalizeInteger(body.sortOrder) ?? undefined,
    assigneeUserId: normalizeInteger(body.assigneeUserId),
    title,
    description: normalizeNullableString(body.description),
    meta: normalizeJsonRecord(body.meta),
    dueAt: normalizeNullableString(body.dueAt),
    completedAt: normalizeNullableString(body.completedAt),
    createdByUserId: context.session?.userId ?? null,
  });

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.task.created", {
    area: "support",
    message: "Support ticket task created.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId },
  });

  return NextResponse.json({ ticket }, { status: 201 });
}
