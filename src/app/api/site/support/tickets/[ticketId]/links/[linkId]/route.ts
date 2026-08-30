import { NextRequest, NextResponse } from "next/server";

import { deleteSupportTicketLink, updateSupportTicketLink } from "@/db/support";
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
  { params }: { params: Promise<{ ticketId: string; linkId: string }> },
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
  const linkId = parsePositiveId(resolved.linkId);
  if (!ticketId || !linkId) {
    return NextResponse.json({ error: "Invalid link id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const ticket = await updateSupportTicketLink({
    siteId: site.id,
    ticketId,
    linkId,
    system: Object.hasOwn(body, "system") ? (normalizeInteger(body.system) ?? undefined) : undefined,
    type: Object.hasOwn(body, "type") ? (normalizeInteger(body.type) ?? undefined) : undefined,
    state: Object.hasOwn(body, "state") ? normalizeInteger(body.state) : undefined,
    flags: Object.hasOwn(body, "flags") ? (normalizeInteger(body.flags) ?? undefined) : undefined,
    externalId: Object.hasOwn(body, "externalId") ? normalizeString(body.externalId) : undefined,
    externalKey: Object.hasOwn(body, "externalKey") ? normalizeNullableString(body.externalKey) : undefined,
    externalUrl: Object.hasOwn(body, "externalUrl") ? normalizeNullableString(body.externalUrl) : undefined,
    meta: Object.hasOwn(body, "meta") ? normalizeJsonRecord(body.meta) : undefined,
    updatedByUserId: context.session?.userId ?? null,
  });

  if (!ticket) {
    return NextResponse.json({ error: "Link not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.link.updated", {
    area: "support",
    message: "Support ticket link updated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId, linkId },
  });

  return NextResponse.json({ ticket });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ ticketId: string; linkId: string }> },
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
  const linkId = parsePositiveId(resolved.linkId);
  if (!ticketId || !linkId) {
    return NextResponse.json({ error: "Invalid link id." }, { status: 400 });
  }

  const ticket = await deleteSupportTicketLink(site.id, ticketId, linkId, context.session?.userId ?? null);
  if (!ticket) {
    return NextResponse.json({ error: "Link not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.support.ticket.link.deleted", {
    area: "support",
    message: "Support ticket link deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { ticketId, linkId },
  });

  return NextResponse.json({ ticket });
}
