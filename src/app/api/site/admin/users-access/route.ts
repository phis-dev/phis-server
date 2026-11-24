import { NextRequest, NextResponse } from "next/server";

import { readPhisUsersAccessLogDays } from "@/db/site-users";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { readSitePhisUsersAccess } from "@/lib/site-users-access";

export const dynamic = "force-dynamic";

/**
 * What this Site lets Add-ons read of people with nobody acting (`users:v1` background access), and how
 * long it keeps the access log: `{ retentionDays, addons: [{ addonId, fields, background, granted,
 * effective, awaiting, grantedAt, grantedByUserId }] }`, one row per installed Add-on requiring `users:v1`.
 * `fields` is what the manifest reads at all, `background` what it asks to read with nobody acting,
 * `granted` the Site's grant, `effective` what of it counts (granted and still asked), `awaiting` what is
 * asked and not granted. Site Admin only.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) return error;
  const [retentionDays, addons] = await Promise.all([
    readPhisUsersAccessLogDays(context.site.id),
    readSitePhisUsersAccess(context.site.id),
  ]);
  return NextResponse.json({ retentionDays, addons });
}
