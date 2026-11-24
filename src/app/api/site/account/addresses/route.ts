import { NextRequest, NextResponse } from "next/server";

import { readPhisCurrentSiteAddresses } from "@/db/site-users";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { writeSiteAccountAddress } from "@/lib/site-account-addresses";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's current addresses on this Site (neither `Superseded` nor `Removed`), oldest first:
 * `{ items: PhisSiteAddress[] }` (`@phis/contracts/users`). The address book is the Site's, so another Site
 * shows its own.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  const { site, session } = context;
  const items = (await readPhisCurrentSiteAddresses(site.id, [session.userId], { handedOut: false })).get(session.userId) ?? [];
  return NextResponse.json({ items });
}

/**
 * Writes an address for the signed-in person: `{ address: PhisSiteAddressInput, flags }`, `flags` of
 * `Billing`, `Shipping`, `DefaultBilling`, `DefaultShipping` (at least one purpose, a default only with its
 * purpose). Answers `201` with the `PhisSiteAddress`; one equal in every part to a current one is that one,
 * given the purposes and defaults besides, and a default moves from the address that held it. `400` for an
 * address or flags that are refused.
 */
export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  return writeSiteAccountAddress(request, { siteId: context.site.id, userId: context.session.userId, replaces: null });
}
