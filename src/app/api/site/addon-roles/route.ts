import { NextResponse, type NextRequest } from "next/server";

import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import {
  mayGrantPhisAddonRole,
  readPhisAddonDeclaredRoles,
  readPhisAddonGrantableRoles,
} from "@/lib/addons/role-granting";
import {
  grantPhisAddonUserRole,
  readPhiSiteUserAddonRoles,
  revokePhisAddonUserRole,
} from "@/db/server-addon-roles.mts";
import { getPool } from "@/lib/db";
import { getUserSiteMembership } from "@/db/user-site-memberships";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Handing out and taking back an Add-on's own roles.
 *
 * The write lives in Core rather than in the Add-on, for the reason `settings:v1` has no writer: an
 * Add-on able to grant its own roles could grant itself whatever they guard. An Add-on's own surface
 * renders the screen and calls this; it never decides the answer. Whoever reaches the screen without the
 * standing is refused here, not there.
 *
 * Which role may be granted by whom is the manifest's declaration, evaluated per request against the
 * acting user. A Site Admin may always grant.
 */

type Body = { addonId?: unknown; role?: unknown; userId?: unknown };

function readBody(body: Body | null) {
  if (
    typeof body?.addonId !== "string" ||
    typeof body.role !== "string" ||
    !Number.isSafeInteger(body.userId) ||
    (body.userId as number) <= 0
  ) {
    return null;
  }
  return { addonId: body.addonId, role: body.role, userId: body.userId as number };
}

/**
 * What the caller may grant, and optionally what one person already holds.
 *
 * Reading somebody else's grants needs the standing to change at least one of them -- otherwise this
 * would be a way for any signed-in user to enumerate who staffs the Site.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  if (!context?.site || !context.session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const grantable = await readPhisAddonGrantableRoles({
    siteId: context.site.id,
    actorUserId: context.session.userId,
  });

  const requested = request.nextUrl.searchParams.get("userId");
  if (!requested) {
    return NextResponse.json({ grantable });
  }
  const userId = Number.parseInt(requested, 10);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "userId is invalid." }, { status: 400 });
  }
  if (grantable.length === 0) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  const held = await readPhiSiteUserAddonRoles(getPool(), { siteId: context.site.id, userId });
  return NextResponse.json({ grantable, userId, held });
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  if (!context?.site || !context.session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const input = readBody(await request.json().catch(() => null));
  if (!input) {
    return NextResponse.json({ error: "addonId, role and userId are required." }, { status: 400 });
  }

  const verdict = await mayGrantPhisAddonRole({
    addonId: input.addonId,
    siteId: context.site.id,
    actorUserId: context.session.userId,
    role: input.role,
    declared: await readPhisAddonDeclaredRoles(input.addonId, context.site.id),
  });
  if (!verdict.allowed) {
    // An unknown Add-on and an undeclared role are the caller's mistake and say so; a refusal on
    // standing says only that, because naming what would have been needed tells a stranger the shape of
    // the Site's staffing.
    const status = verdict.reason === "not_permitted" ? 403 : 404;
    return NextResponse.json({ error: verdict.reason }, { status });
  }

  // A role is held on a Site by somebody who belongs to it. A grant to anyone else would be a row nobody
  // on this Site can see or take back through user administration.
  if (!await getUserSiteMembership(input.userId, context.site.id)) {
    return NextResponse.json({ error: "user_not_member" }, { status: 404 });
  }

  const granted = await grantPhisAddonUserRole(getPool(), {
    addonId: input.addonId,
    siteId: context.site.id,
    userId: input.userId,
    role: input.role,
    grantedByUserId: context.session.userId,
  });
  logRuntimeEvent("info", "addon.role.granted", {
    siteKey: context.site.key,
    pluginKey: input.addonId,
    meta: { role: input.role, userId: input.userId, added: granted },
  });
  return NextResponse.json({ ok: true, granted });
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  if (!context?.site || !context.session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const input = readBody(await request.json().catch(() => null));
  if (!input) {
    return NextResponse.json({ error: "addonId, role and userId are required." }, { status: 400 });
  }

  // Taking a role back needs the standing to have given it. Anything else would let somebody undo a
  // decision they could not have made.
  const verdict = await mayGrantPhisAddonRole({
    addonId: input.addonId,
    siteId: context.site.id,
    actorUserId: context.session.userId,
    role: input.role,
    declared: await readPhisAddonDeclaredRoles(input.addonId, context.site.id),
  });
  if (!verdict.allowed) {
    const status = verdict.reason === "not_permitted" ? 403 : 404;
    return NextResponse.json({ error: verdict.reason }, { status });
  }

  const revoked = await revokePhisAddonUserRole(getPool(), {
    addonId: input.addonId,
    siteId: context.site.id,
    userId: input.userId,
    role: input.role,
  });
  logRuntimeEvent("info", "addon.role.revoked", {
    siteKey: context.site.key,
    pluginKey: input.addonId,
    meta: { role: input.role, userId: input.userId, removed: revoked },
  });
  return NextResponse.json({ ok: true, revoked });
}
