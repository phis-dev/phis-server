import { NextRequest, NextResponse } from "next/server";

import { applySupportTicketAssignmentAction } from "@/db/support";
import { requireSiteSupportApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, parseStrictPositiveInt, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

type AssignmentAction = "assign_to_me" | "assign_to_user" | "unassign" | "move_to_queue";

function normalizeAction(value: unknown): AssignmentAction | null {
  const normalized = normalizeString(value).toLowerCase();
  if (
    normalized === "assign_to_me" ||
    normalized === "assign_to_user" ||
    normalized === "unassign" ||
    normalized === "move_to_queue"
  ) {
    return normalized;
  }
  return null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ ticketId: string }> }) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const ticketId = parseStrictPositiveInt((await params).ticketId);
  if (!ticketId) {
    return NextResponse.json({ error: "Invalid ticket id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const action = normalizeAction(body.action);
  if (!action) {
    return NextResponse.json({ error: "Unsupported assignment action." }, { status: 400 });
  }
  // Read strictly, like the ticket id: "12abc" names no queue and no person, and must not become 12.
  const queueId = action === "move_to_queue" ? parseStrictPositiveInt(body.queueId) : null;
  if (action === "move_to_queue" && !queueId) {
    return NextResponse.json({ error: "Invalid queue id." }, { status: 400 });
  }
  const targetUserId = action === "assign_to_user" ? parseStrictPositiveInt(body.targetUserId) : null;
  if (action === "assign_to_user" && !targetUserId) {
    return NextResponse.json({ error: "Invalid target user id." }, { status: 400 });
  }

  try {
    const ticket =
      action === "move_to_queue"
        ? await applySupportTicketAssignmentAction({
            siteId: site.id,
            ticketId,
            action,
            userId,
            queueId: queueId!,
          })
        : action === "assign_to_user"
          ? await applySupportTicketAssignmentAction({
              siteId: site.id,
              ticketId,
              action,
              userId,
              targetUserId: targetUserId!,
            })
        : await applySupportTicketAssignmentAction({
            siteId: site.id,
            ticketId,
            action,
            userId,
          });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found." }, { status: 404 });
    }

    logRuntimeEvent("info", "site.support.ticket.assignment_action", {
      area: "support",
      message: "Support ticket assignment action applied.",
      siteKey: site.key,
      userId,
      meta: { ticketId, action },
    });

    return NextResponse.json({ ticket });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Assignment action failed." },
      { status: 400 },
    );
  }
}
