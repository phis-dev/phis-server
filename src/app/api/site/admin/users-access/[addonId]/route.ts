import { NextRequest, NextResponse } from "next/server";

import { grantPhisAddonUsersBackground, revokePhisAddonUsersBackground } from "@/db/users-grants.mts";
import { getPool } from "@/lib/db";
import { readPhisUsersGrantFields } from "@/lib/addons/users-access";
import { phisUserFieldBitsOf } from "@/lib/constants/users";
import { requireSiteAdminOnlyApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import { readSitePhisUsersAccess } from "@/lib/site-users-access";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ addonId: string }> };

/** A foreign key refusing the grant: the Add-on is installed and not yet in the registry. */
function isMissingRegistryRow(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23503";
}

/**
 * Grants an Add-on background access to `users:v1` on this Site: `{ fields }`, a non-empty part of what its
 * manifest asks in `users.background`, which becomes the whole grant. Answers the Add-on's row as `GET
 * /api/site/admin/users-access` lists it. `404` for an Add-on that is not installed or does not require
 * `users:v1`, `400` for fields it does not ask, `409` for one not yet reconciled into the registry. The id
 * is one percent-encoded path segment. Site Admin only; the grant names who gave it.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) return error;
  const { addonId } = await params;
  const [row] = await readSitePhisUsersAccess(context.site.id, addonId);
  if (!row) {
    return NextResponse.json({ error: "No installed Add-on of this id reads people (users:v1)." }, { status: 404 });
  }
  const chosen = readPhisUsersGrantFields(row.background, (await readRequestBody(request)).fields);
  if ("error" in chosen) {
    return NextResponse.json({ error: chosen.error }, { status: 400 });
  }
  try {
    await grantPhisAddonUsersBackground(getPool(), {
      siteId: context.site.id,
      addonId,
      fields: phisUserFieldBitsOf(chosen.fields),
      grantedByUserId: context.session.userId,
    });
  } catch (grantError) {
    if (isMissingRegistryRow(grantError)) {
      return NextResponse.json({ error: "The Add-on is not in the registry yet; the operator reconciles it first." }, { status: 409 });
    }
    throw grantError;
  }
  const [granted] = await readSitePhisUsersAccess(context.site.id, addonId);
  return NextResponse.json(granted);
}

/**
 * Withdraws an Add-on's background access to `users:v1` on this Site, installed or not: `{ revoked }`, false
 * where there was no grant. Site Admin only.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const { context, error } = await requireSiteAdminOnlyApiContext(request);
  if (error) return error;
  const { addonId } = await params;
  const revoked = await revokePhisAddonUsersBackground(getPool(), { siteId: context.site.id, addonId });
  return NextResponse.json({ revoked });
}
