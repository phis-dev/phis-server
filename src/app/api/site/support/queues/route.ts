import { NextRequest, NextResponse } from "next/server";

import {
  createSupportQueue,
  listSupportQueues,
  SupportAdministrationError,
} from "@/db/support";
import {
  requireSiteDeveloperApiContext,
  requireSiteSupportApiContext,
} from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import {
  readSupportAdministrationKey,
  readSupportAdministrationName,
  readSupportInteger,
  refuseSupportAdministration,
} from "@/lib/guards/site-support-administration";

export const dynamic = "force-dynamic";

/**
 * The Site's Support queues.
 *
 * Where work is routed, and the group each one routes to. Who is in that group is a group question and
 * is answered by the group surfaces -- a queue owns routing, never membership.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteSupportApiContext(request);
  if (error) {
    return error;
  }

  const site = context.site;

  return NextResponse.json({ rows: await listSupportQueues(site.id) });
}

/**
 * Adds a queue.
 *
 * Behind `Developer | Admin` rather than the Supporter role the listing above uses: a queue names a
 * group, and creating groups is the Site's own administration
 * ([GROUPS_AND_STORAGE.md](../../../../../../GROUPS_AND_STORAGE.md) section 6). Somebody who answers
 * tickets is not therefore somebody who decides where tickets go.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteDeveloperApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const body = await readRequestBody(request);
  const key = readSupportAdministrationKey(body.key);
  const name = readSupportAdministrationName(body.name);
  const groupId = readSupportInteger(body.groupId);
  if (!key || !name || groupId == null) {
    return NextResponse.json(
      { error: "A queue needs a key, a name, and the group it routes to." },
      { status: 400 },
    );
  }

  try {
    const id = await createSupportQueue({
      siteId: site.id,
      groupId,
      key,
      name,
      flags: readSupportInteger(body.flags) ?? 0,
      sortOrder: readSupportInteger(body.sortOrder) ?? 0,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (cause) {
    return refuseSupportAdministration(cause, SupportAdministrationError);
  }
}
