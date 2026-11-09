import { NextRequest, NextResponse } from "next/server";

import {
  SupportAdministrationError,
  getSupportQueueBySiteAndId,
  updateSupportQueue,
} from "@/db/support";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import {
  readSupportAdministrationName,
  readSupportFlag,
  readSupportInteger,
  refuseSupportAdministration,
} from "@/lib/guards/site-support-administration";

export const dynamic = "force-dynamic";

/**
 * Edits one queue: its name, the group it routes to, its order, and whether it is retired.
 *
 * Not its key. The key is what a Module's declared seed finds its own rows by, so changing one would
 * not rename a queue -- the next publish would simply make a second one beside it. A queue is deleted
 * by nothing: retirement is the whole of it, because tickets standing in a queue keep naming it.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ queueId: string }> },
) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const queueId = readSupportInteger((await params).queueId);
  if (queueId == null || !await getSupportQueueBySiteAndId(site.id, queueId)) {
    return NextResponse.json({ error: "This Site has no such queue." }, { status: 404 });
  }

  const body = await readRequestBody(request);
  const name = body.name === undefined ? undefined : readSupportAdministrationName(body.name);
  if (name === null) {
    return NextResponse.json({ error: "A queue's name cannot be empty." }, { status: 400 });
  }

  try {
    await updateSupportQueue({
      siteId: site.id,
      queueId,
      name,
      groupId: body.groupId === undefined ? undefined : readSupportInteger(body.groupId) ?? undefined,
      flags: body.flags === undefined ? undefined : readSupportInteger(body.flags) ?? undefined,
      sortOrder: body.sortOrder === undefined ? undefined : readSupportInteger(body.sortOrder) ?? undefined,
      retired: readSupportFlag(body.retired),
    });
    return NextResponse.json({ ok: true });
  } catch (cause) {
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
}
