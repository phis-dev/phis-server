import { NextRequest, NextResponse } from "next/server";

import { getSupportTicketDetail, updateSupportTicket } from "@/db/support";
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
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

  const ticketId = parseTicketId((await params).ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const updated = await updateSupportTicket({
    siteId: site.id,
    ticketId,
    type: normalizeInteger(body.type) ?? undefined,
    status: normalizeInteger(body.status) ?? undefined,
    channel: normalizeInteger(body.channel) ?? undefined,
    priority: normalizeInteger(body.priority) ?? undefined,
    severity: Object.prototype.hasOwnProperty.call(body, "severity") ? normalizeInteger(body.severity) : undefined,
    requesterUserId: Object.prototype.hasOwnProperty.call(body, "requesterUserId")
      ? normalizeInteger(body.requesterUserId)
      : undefined,
    requesterEmail: Object.prototype.hasOwnProperty.call(body, "requesterEmail")
      ? normalizeNullableString(body.requesterEmail)
      : undefined,
    assigneeUserId: Object.prototype.hasOwnProperty.call(body, "assigneeUserId")
      ? normalizeInteger(body.assigneeUserId)
      : undefined,
    teamId: Object.prototype.hasOwnProperty.call(body, "teamId") ? normalizeInteger(body.teamId) : undefined,
    subject: Object.prototype.hasOwnProperty.call(body, "subject") ? normalizeString(body.subject) : undefined,
    summary: Object.prototype.hasOwnProperty.call(body, "summary") ? normalizeNullableString(body.summary) : undefined,
    meta: Object.prototype.hasOwnProperty.call(body, "meta") ? normalizeJsonRecord(body.meta) : undefined,
    firstResponseDueAt: Object.prototype.hasOwnProperty.call(body, "firstResponseDueAt")
      ? normalizeNullableString(body.firstResponseDueAt)
      : undefined,
    resolutionDueAt: Object.prototype.hasOwnProperty.call(body, "resolutionDueAt")
      ? normalizeNullableString(body.resolutionDueAt)
      : undefined,
    resolvedAt: Object.prototype.hasOwnProperty.call(body, "resolvedAt")
      ? normalizeNullableString(body.resolvedAt)
      : undefined,
    closedAt: Object.prototype.hasOwnProperty.call(body, "closedAt")
      ? normalizeNullableString(body.closedAt)
      : undefined,
    updatedByUserId: context.session?.userId ?? null,
  });

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
