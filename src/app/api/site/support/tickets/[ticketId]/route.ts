import { NextRequest, NextResponse } from "next/server";

import { getSupportTicketDetail, SupportAdministrationError, updateSupportTicket } from "@/db/support";
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
import { readSupportTicketReach, supportTicketWithinReach } from "@/lib/support-reach";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
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

  const detail = await getSupportTicketDetail(site.id, ticketId);
  if (!detail) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  return NextResponse.json({ ticket: detail });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
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
  let updated;
  try {
    updated = await updateSupportTicket({
    siteId: site.id,
    ticketId,
    typeId: normalizeNullableInteger(body.typeId) ?? undefined,
    status: normalizeNullableInteger(body.status) ?? undefined,
    channel: normalizeNullableInteger(body.channel) ?? undefined,
    priority: normalizeNullableInteger(body.priority) ?? undefined,
    severity: Object.prototype.hasOwnProperty.call(body, "severity")
      ? normalizeNullableInteger(body.severity)
      : undefined,
    requesterUserId: Object.prototype.hasOwnProperty.call(body, "requesterUserId")
      ? normalizeNullableInteger(body.requesterUserId)
      : undefined,
    requesterEmail: Object.prototype.hasOwnProperty.call(body, "requesterEmail")
      ? normalizeNullableString(body.requesterEmail)
      : undefined,
    assigneeUserId: Object.prototype.hasOwnProperty.call(body, "assigneeUserId")
      ? normalizeNullableInteger(body.assigneeUserId)
      : undefined,
    queueId: Object.prototype.hasOwnProperty.call(body, "queueId")
      ? normalizeNullableInteger(body.queueId)
      : undefined,
    subject: Object.prototype.hasOwnProperty.call(body, "subject") ? normalizeString(body.subject) : undefined,
    summary: Object.prototype.hasOwnProperty.call(body, "summary") ? normalizeNullableString(body.summary) : undefined,
    meta: Object.prototype.hasOwnProperty.call(body, "meta") ? toPhiRecord(body.meta) : undefined,
    firstResponseDueAt: Object.prototype.hasOwnProperty.call(body, "firstResponseDueAt")
      ? normalizeNullableString(body.firstResponseDueAt)
      : undefined,
    resolutionDueAt: Object.prototype.hasOwnProperty.call(body, "resolutionDueAt")
      ? normalizeNullableString(body.resolutionDueAt)
      : undefined,
    updatedByUserId: context.session?.userId ?? null,
    });
  } catch (cause) {
    // A queue, type or person this Site does not have: the body's fault, and said so.
    if (cause instanceof SupportAdministrationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

  if (!updated) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.updated", {
    area: "support",
    message: "Support ticket updated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId },
  });

  return NextResponse.json({ ticket: updated });
}
