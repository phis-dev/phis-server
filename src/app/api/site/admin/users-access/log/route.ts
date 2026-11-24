import { NextRequest, NextResponse } from "next/server";

import { listPhisUsersAccessLog } from "@/db/site-users";
import { PHIS_USERS_ACCESS_OPERATION_NAMES, PHIS_USERS_ACCESS_ROAD_NAMES, phisUserFieldsOf } from "@/lib/constants/users";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { normalizeNullableString, parsePhiPagination } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * This Site's `users:v1` access log, newest first, a page at a time (`page`, `pageSize` up to 100, 25 by
 * default), narrowed with `subject` (an entitlement subject among those named) and `addonId`: `{ items: [{
 * at, addonId, actor: { userId, displayName } | null, road, operation, subjects, addressIds, fields }] }`.
 * `road` is `staff`, `self`, `background` or `checkout`; `operation` `describe`, `addresses`,
 * `createAddress`, `fileOf` or `customerFile` (Core's own, `addonId` `@phis/server`); `fields` the
 * `users:v1` fields the answer carried. Site Admin only.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  const entries = await listPhisUsersAccessLog({
    siteId: context.site.id,
    subject: normalizeNullableString(params.get("subject")),
    addonId: normalizeNullableString(params.get("addonId")),
    ...parsePhiPagination(params),
  });
  return NextResponse.json({
    items: entries.map((entry) => ({
      at: entry.at,
      addonId: entry.addonId,
      actor: entry.actor,
      road: PHIS_USERS_ACCESS_ROAD_NAMES[entry.road] ?? String(entry.road),
      operation: PHIS_USERS_ACCESS_OPERATION_NAMES[entry.operation] ?? String(entry.operation),
      subjects: entry.subjects,
      addressIds: entry.addressIds,
      fields: phisUserFieldsOf(entry.fields),
    })),
  });
}
