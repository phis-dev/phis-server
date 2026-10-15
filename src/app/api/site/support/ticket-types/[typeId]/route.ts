import { NextRequest, NextResponse } from "next/server";

import {
  SupportAdministrationError,
  listSupportTicketTypes,
  updateSupportTicketType,
} from "@/db/support";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import {
  readSupportAdministrationName,
  readSupportAllowanceInput,
  readSupportFlag,
  readSupportInteger,
  refuseSupportAdministration,
} from "@/lib/guards/site-support-administration";

export const dynamic = "force-dynamic";

/**
 * Edits one ticket type, and is where a Site decides who may ask for it.
 *
 * `PhisSupportTicketTypeFlag.Requestable` arrives in `flags` like the others. It is off on a type that
 * came with a Module, because a type nobody on this Site has looked at should not be offered to the
 * public, and this route is the looking.
 *
 * Not its key, for the reason the queue route gives. A type is retired rather than deleted: the tickets
 * opened under it keep naming it, and the requester window they were promised keeps meaning something.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ typeId: string }> },
) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const typeId = readSupportInteger((await params).typeId);
  const types = await listSupportTicketTypes(site.id);
  if (typeId == null || !types.some((type) => type.id === typeId)) {
    return NextResponse.json({ error: "This Site has no such ticket type." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  const name = body.name === undefined ? undefined : readSupportAdministrationName(body.name);
  if (name === null) {
    return NextResponse.json({ error: "A ticket type's name cannot be empty." }, { status: 400 });
  }
  const requesterAllowance = readSupportAllowanceInput(body.requesterAllowance);
  if (requesterAllowance === false) {
    return NextResponse.json(
      { error: "An allowance is a count and a period (1 = month, 2 = year), or null for none." },
      { status: 400 },
    );
  }

  try {
    await updateSupportTicketType({
      requesterAllowance,
      siteId: site.id,
      typeId,
      name,
      flags: body.flags === undefined ? undefined : readSupportInteger(body.flags) ?? undefined,
      closePolicy: body.closePolicy === undefined
        ? undefined
        : readSupportInteger(body.closePolicy) ?? undefined,
      requesterWindowDays: body.requesterWindowDays === undefined
        ? undefined
        : readSupportInteger(body.requesterWindowDays),
      // `<providerKey>#<key>` of a forwarding target, or null/empty for none. Which targets exist is asked
      // of the implementations when a forward happens, so a stored one that stopped existing is just unused.
      forwardTarget: body.forwardTarget === undefined
        ? undefined
        : typeof body.forwardTarget === "string" && body.forwardTarget.trim()
          ? body.forwardTarget.trim().slice(0, 512)
          : null,
      sortOrder: body.sortOrder === undefined ? undefined : readSupportInteger(body.sortOrder) ?? undefined,
      retired: readSupportFlag(body.retired),
    });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    /*
     * `support_ticket_types_close_policy_check` refuses a type that waits for a merge without being a
     * code change. It is a real refusal and not a malformed request, so it is said in the same voice as
     * the others rather than surfacing as a 500 with a constraint name in it.
     */
    if (cause instanceof Error && cause.message.includes("close_policy_check")) {
      return NextResponse.json(
        { error: "Only a code-change type can wait for a merge to accept it." },
        { status: 409 },
      );
    }
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
}
