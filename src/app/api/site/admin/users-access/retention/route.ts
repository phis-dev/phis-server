import { NextRequest, NextResponse } from "next/server";

import { setPhisUsersAccessLogDays } from "@/db/site-users";
import { PHIS_USERS_ACCESS_LOG_MAX_DAYS } from "@/lib/constants/users";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * How many days this Site keeps its `users:v1` access log: `{ days }`, a whole number from 1 to 3650
 * (`sites.users_access_log_days`, also `phis site set --users-access-log-days`). Answers `{ retentionDays }`;
 * the Core job `users-access-log.prune` forgets older entries on its next run. Site Admin only.
 */
export async function PUT(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) return error;
  const { days } = await readRequestBody(request);
  if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > PHIS_USERS_ACCESS_LOG_MAX_DAYS) {
    return NextResponse.json({ error: `days is a whole number from 1 to ${PHIS_USERS_ACCESS_LOG_MAX_DAYS}.` }, { status: 400 });
  }
  await setPhisUsersAccessLogDays(context.site.id, days as number);
  return NextResponse.json({ retentionDays: days });
}
