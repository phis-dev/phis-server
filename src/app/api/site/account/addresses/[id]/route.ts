import { NextRequest, NextResponse } from "next/server";

import { removePhisSiteAddress } from "@/db/site-users";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { readPhisPathId, writeSiteAccountAddress } from "@/lib/site-account-addresses";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: "No current address of yours has this id." }, { status: 404 });

/**
 * Changes one of the signed-in person's current addresses: `{ address, flags }` as for `POST`, written as a
 * new version that replaces it (the old one becomes `Superseded`). Answers the new `PhisSiteAddress`, or the
 * current one equal to it; `404` for an id that is no current address of theirs on this Site.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  const id = readPhisPathId((await params).id);
  if (id == null) return notFound();
  return writeSiteAccountAddress(request, { siteId: context.site.id, userId: context.session.userId, replaces: id });
}

/**
 * Removes one of the signed-in person's current addresses and the versions it followed. Answers `{ outcome:
 * "deleted" }` where no Add-on was ever handed it, and `{ outcome: "removed" }` where one was: it stays,
 * `Removed`, for the records that may point at it, and is gone from the account. `404` for an id that is no
 * current address of theirs on this Site.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  const id = readPhisPathId((await params).id);
  if (id == null) return notFound();
  const outcome = await removePhisSiteAddress({ siteId: context.site.id, userId: context.session.userId, addressId: id });
  return outcome ? NextResponse.json({ outcome }) : notFound();
}
