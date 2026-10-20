import { NextRequest, NextResponse } from "next/server";

import {
  deleteSupportTicketTask,
  SupportAdministrationError,
  supportTicketWithinReach,
  updateSupportTicketTask,
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

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string; taskId: string }> },
) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const resolved = await params;
  const ticketId = parseStrictPositiveInt(resolved.ticketId);
  const taskId = parseStrictPositiveInt(resolved.taskId);
  if (!ticketId || !taskId) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  let ticket;
  try {
    ticket = await updateSupportTicketTask({
      siteId: site.id,
      ticketId,
      taskId,
      type: Object.hasOwn(body, "type") ? (normalizeNullableInteger(body.type) ?? undefined) : undefined,
      status: Object.hasOwn(body, "status")
        ? (normalizeNullableInteger(body.status) ?? undefined)
        : undefined,
      flags: Object.hasOwn(body, "flags")
        ? (normalizeNullableInteger(body.flags) ?? undefined)
        : undefined,
      sortOrder: Object.hasOwn(body, "sortOrder")
        ? (normalizeNullableInteger(body.sortOrder) ?? undefined)
        : undefined,
      assigneeUserId: Object.hasOwn(body, "assigneeUserId")
        ? normalizeNullableInteger(body.assigneeUserId)
        : undefined,
      title: Object.hasOwn(body, "title") ? normalizeString(body.title) : undefined,
      description: Object.hasOwn(body, "description") ? normalizeNullableString(body.description) : undefined,
      meta: Object.hasOwn(body, "meta") ? toPhiRecord(body.meta) : undefined,
      dueAt: Object.hasOwn(body, "dueAt") ? normalizeNullableString(body.dueAt) : undefined,
      completedAt: Object.hasOwn(body, "completedAt") ? normalizeNullableString(body.completedAt) : undefined,
      updatedByUserId: context.session?.userId ?? null,
    });
  } catch (cause) {
    if (cause instanceof SupportAdministrationError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

  if (!ticket) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.task.updated", {
    area: "support",
    message: "Support ticket task updated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId, taskId },
  });

  return NextResponse.json({ ticket });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string; taskId: string }> },
) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const resolved = await params;
  const ticketId = parseStrictPositiveInt(resolved.ticketId);
  const taskId = parseStrictPositiveInt(resolved.taskId);
  if (!ticketId || !taskId) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
  }
  // A ticket outside the reader's queues answers as one that is not there (`lib/support-reach.ts`).
  if (!(await supportTicketWithinReach(site.id, ticketId, readSupportTicketReach(context)))) {
    return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
  }

  const ticket = await deleteSupportTicketTask(site.id, ticketId, taskId, context.session?.userId ?? null);
  if (!ticket) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.task.deleted", {
    area: "support",
    message: "Support ticket task deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId, taskId },
  });

  return NextResponse.json({ ticket });
}
