import { NextRequest, NextResponse } from "next/server";

import {
  createSupportTicket,
  listSupportTicketsForSite,
  SUPPORT_TICKET_CHANNEL_INTERNAL,
  SUPPORT_TICKET_PRIORITY_NORMAL,
  SupportAdministrationError,
} from "@/db/support";
import { PhisThreadError } from "@/db/threads";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { forwardSupportTicket, SupportForwardError } from "@/lib/support-forwarding";
import { readSupportTicketReach } from "@/lib/support-reach";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeNullableInteger,
  normalizeNullableString,
  normalizePositiveIdArray,
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

  const site = context.site;

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
    // The tickets of the reader's queues, or every one for an Admin or a Developer.
    reach: readSupportTicketReach(context),
  });

  return NextResponse.json({
    rows: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    // The Site's tickets by state, beside the filtered slice: what an inbox's footer says.
    counts: result.counts,
  });
}

/**
 * A Supporter opening a ticket, on somebody's behalf or for work Staff found themselves.
 *
 * Beside the ticket's own fields it takes two things a person opening one in the App reaches for in the
 * same moment: `assetIds`, the opener's own uploads hung on the first message, and `forwardTarget`, a
 * target as `GET /api/site/support/forward` names it, to hand the work on at once.
 *
 * The forward runs after the ticket is committed, because it calls another system and cannot be part
 * of the transaction. A forward that fails therefore leaves the ticket opened, and says so in the answer
 * (`forward.error`) rather than as the status: refusing the request would invite opening it a second
 * time, and the ticket is in the inbox, where Forward can run again.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

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

  const forwardTarget = normalizeString(body.forwardTarget);
  const actorUserId = context.session?.userId ?? null;
  if (forwardTarget && actorUserId == null) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let ticket: Awaited<ReturnType<typeof createSupportTicket>>;
  try {
    ticket = await createSupportTicket({
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
      createdByUserId: actorUserId,
      assetIds: normalizePositiveIdArray(body.assetIds),
    });
  } catch (cause) {
    // A queue this Site does not have, or a file that is not the opener's: the body's fault, and said so.
    if (cause instanceof SupportAdministrationError || cause instanceof PhisThreadError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

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

  if (!forwardTarget || !ticket || actorUserId == null) {
    return NextResponse.json({ ticket }, { status: 201 });
  }

  try {
    const forwarded = await forwardSupportTicket({
      site: { id: site.id, key: site.key },
      ticketId: ticket.ticket.id,
      target: forwardTarget,
      title: null,
      actorUserId,
    });
    return NextResponse.json({ ticket: forwarded ?? ticket, forward: { ok: true } }, { status: 201 });
  } catch (cause) {
    if (!(cause instanceof SupportForwardError)) {
      throw cause;
    }
    logRuntimeEvent("warn", "site.support.ticket.forward_failed", {
      area: "support",
      message: "Support ticket created, forwarding it failed.",
      siteKey: site.key,
      userId: actorUserId,
      meta: { ticketId: ticket.ticket.id, code: cause.code },
    });
    return NextResponse.json(
      { ticket, forward: { ok: false, code: cause.code, error: cause.message } },
      { status: 201 },
    );
  }
}
