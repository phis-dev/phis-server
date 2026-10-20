import { NextRequest, NextResponse } from "next/server";

import {
  addSupportTicketTask,
  SUPPORT_TICKET_TASK_STATUS_OPEN,
  SUPPORT_TICKET_TASK_TYPE_INTERNAL,
  SupportAdministrationError,
  supportTicketWithinReach,
} from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeNullableInteger,
  normalizeNullableString,
  normalizeString,
  parseStrictPositiveInt,
  readRequestBody,
} from "@/lib/helpers/request";
import { toPhiRecord } from "@/lib/helpers/record";
import { readSupportTicketReach } from "@/lib/support-reach";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const ticketId = parseStrictPositiveInt((await params).ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  const title = normalizeString(body.title);
  if (!title) {
    return NextResponse.json({ error: "Task title is required." }, { status: 400 });
  }

  let ticket;
  try {
    ticket = await addSupportTicketTask({
      siteId: site.id,
      ticketId,
      type: normalizeNullableInteger(body.type) ?? SUPPORT_TICKET_TASK_TYPE_INTERNAL,
      status: normalizeNullableInteger(body.status) ?? SUPPORT_TICKET_TASK_STATUS_OPEN,
      flags: normalizeNullableInteger(body.flags) ?? 0,
      sortOrder: normalizeNullableInteger(body.sortOrder) ?? undefined,
      assigneeUserId: normalizeNullableInteger(body.assigneeUserId),
      title,
      description: normalizeNullableString(body.description),
      meta: toPhiRecord(body.meta),
      dueAt: normalizeNullableString(body.dueAt),
      completedAt: normalizeNullableString(body.completedAt),
      createdByUserId: context.session?.userId ?? null,
    });
  } catch (cause) {
    if (cause instanceof SupportAdministrationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

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
