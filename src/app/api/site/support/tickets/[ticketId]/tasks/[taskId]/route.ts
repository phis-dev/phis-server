import { NextRequest, NextResponse } from "next/server";

import { deleteSupportTicketTask, updateSupportTicketTask } from "@/db/support";
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

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

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
  const ticketId = parsePositiveId(resolved.ticketId);
  const taskId = parsePositiveId(resolved.taskId);
  if (!ticketId || !taskId) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const ticket = await updateSupportTicketTask({
    siteId: site.id,
    ticketId,
    taskId,
    type: Object.hasOwn(body, "type") ? (normalizeInteger(body.type) ?? undefined) : undefined,
    status: Object.hasOwn(body, "status") ? (normalizeInteger(body.status) ?? undefined) : undefined,
    flags: Object.hasOwn(body, "flags") ? (normalizeInteger(body.flags) ?? undefined) : undefined,
    sortOrder: Object.hasOwn(body, "sortOrder") ? (normalizeInteger(body.sortOrder) ?? undefined) : undefined,
    assigneeUserId: Object.hasOwn(body, "assigneeUserId") ? normalizeInteger(body.assigneeUserId) : undefined,
    title: Object.hasOwn(body, "title") ? normalizeString(body.title) : undefined,
    description: Object.hasOwn(body, "description") ? normalizeNullableString(body.description) : undefined,
    meta: Object.hasOwn(body, "meta") ? normalizeJsonRecord(body.meta) : undefined,
    dueAt: Object.hasOwn(body, "dueAt") ? normalizeNullableString(body.dueAt) : undefined,
    completedAt: Object.hasOwn(body, "completedAt") ? normalizeNullableString(body.completedAt) : undefined,
    updatedByUserId: context.session?.userId ?? null,
  });

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
  const ticketId = parsePositiveId(resolved.ticketId);
  const taskId = parsePositiveId(resolved.taskId);
  if (!ticketId || !taskId) {
    return NextResponse.json({ error: "Invalid task id." }, { status: 400 });
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
