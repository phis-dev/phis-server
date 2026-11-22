import { NextRequest, NextResponse } from "next/server";

import { searchSiteMembers } from "@/db/user-admin";
import { requireSiteAccountingOrSupportApiContext } from "@/lib/guards/site-admin-api";
import { parsePositiveIntWithFallback } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/** The most members one page answers: a picker's page, not a list to read through. */
const SITE_MEMBERS_MOST_PER_PAGE = 50;
const SITE_MEMBERS_DEFAULT_PER_PAGE = 20;

/**
 * The Site's members, for a picker that names a person by user id (a licence granted on somebody's
 * behalf): `q` matched on the name and the e-mail addresses, `page` and `pageSize` (at most 50). Answers
 * `{ items }`, each `{ userId, displayName }`, ordered by name -- the name the person is shown under, or
 * `#<id>` without one, never the address that may have been searched by. For the staff who act on a
 * member's behalf, the holders of the Site access `accounting` or `support`, which Core asks before it
 * names a member to an Add-on (`subjectForUser`); the Site's user list is the Site Admin's and the group
 * candidates are a group Manager's.
 */
export async function GET(request: NextRequest) {
  const guarded = await requireSiteAccountingOrSupportApiContext(request);
  if (guarded.error) return guarded.error;

  const params = request.nextUrl.searchParams;
  return NextResponse.json({
    items: await searchSiteMembers({
      siteId: guarded.context.site.id,
      query: (params.get("q") ?? "").slice(0, 200),
      page: parsePositiveIntWithFallback(params.get("page"), 1),
      pageSize: Math.min(
        parsePositiveIntWithFallback(params.get("pageSize"), SITE_MEMBERS_DEFAULT_PER_PAGE),
        SITE_MEMBERS_MOST_PER_PAGE,
      ),
    }),
  });
}
