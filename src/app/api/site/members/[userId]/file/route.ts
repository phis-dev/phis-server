import { NextRequest, NextResponse } from "next/server";

import { phisSiteAccessHolderOf } from "@/lib/addons/site-access";
import { requireSiteAccountingOrSupportApiContext } from "@/lib/guards/site-admin-api";
import { parsePhiPagination } from "@/lib/helpers/request";
import { readPhisPathId } from "@/lib/site-account-addresses";
import { readPhisCustomerFile } from "@/lib/site-customer-file";

export const dynamic = "force-dynamic";

/**
 * Staff's customer file on one member of the Site: `{ person: { userId, displayName, name?, email?, phone?,
 * addresses? }, fileThreadId, threads }`. The person's fields follow the staff road of `users:v1` -- the Site
 * access `support` reads name, e-mail and telephone, `accounting` (and a Site Admin) also the Site's current
 * addresses -- and the read is written to the access log. `fileThreadId` is the person's file
 * (`PhisThreadKind.File`), opened on first asking; `threads` are the inbox rows of the threads the person
 * takes part in that the actor may see, a page at a time (`page`, `pageSize` up to 100). For the holders of
 * `accounting` or `support`; `403` for the actor's own file, which nobody reaches, `404` for a user who is
 * no member of the Site.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { context, error } = await requireSiteAccountingOrSupportApiContext(request);
  if (error) return error;
  const userId = readPhisPathId((await params).userId);
  if (userId == null) {
    return NextResponse.json({ error: "No member of this Site has this id." }, { status: 404 });
  }
  if (userId === context.session.userId) {
    return NextResponse.json({ error: "Nobody reaches their own file." }, { status: 403 });
  }
  const file = await readPhisCustomerFile({
    siteId: context.site.id,
    actorUserId: context.session.userId,
    holds: phisSiteAccessHolderOf(context.siteRole),
    userId,
    ...parsePhiPagination(request.nextUrl.searchParams),
  });
  return file
    ? NextResponse.json(file)
    : NextResponse.json({ error: "No member of this Site has this id." }, { status: 404 });
}
