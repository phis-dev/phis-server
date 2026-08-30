import { NextRequest, NextResponse } from "next/server";

import {
  addSupportTicketMessage,
  SUPPORT_TICKET_CHANNEL_INTERNAL,
  SUPPORT_TICKET_MESSAGE_AUTHOR_SUPPORTER,
  SUPPORT_TICKET_MESSAGE_VISIBILITY_INTERNAL,
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
  const bodyText = normalizeString(body.bodyText);
  if (!bodyText) {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 });
  }

  const ticket = await addSupportTicketMessage({
    siteId: site.id,
    ticketId,
    channel: normalizeInteger(body.channel) ?? SUPPORT_TICKET_CHANNEL_INTERNAL,
    visibility: normalizeInteger(body.visibility) ?? SUPPORT_TICKET_MESSAGE_VISIBILITY_INTERNAL,
    authorType: normalizeInteger(body.authorType) ?? SUPPORT_TICKET_MESSAGE_AUTHOR_SUPPORTER,
    authorUserId: context.session?.userId ?? null,
    externalMessageRef: normalizeNullableString(body.externalMessageRef),
    bodyText,
    bodyMarkdown: normalizeNullableString(body.bodyMarkdown),
    meta: normalizeJsonRecord(body.meta),
  });

  if (!ticket) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.message.created", {
    area: "support",
    message: "Support ticket message created.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId },
  });

  return NextResponse.json({ ticket }, { status: 201 });
}
