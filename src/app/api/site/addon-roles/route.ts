import { NextResponse, type NextRequest } from "next/server";

import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { readAvailablePhisProviderIds } from "@/lib/addons/capability-snapshot";
import { PHIS_SITE_ACCESS } from "@/lib/addons/contract";
import { mayGrantPhisAddonRole, readPhisAddonRoleCatalog } from "@/lib/addons/role-granting";
import { readPhisSiteAccessHolder } from "@/lib/addons/site-access";
import {
  filterPhiCountingAddonGrants,
  listPhiCountingAddonDeclaredRoles,
  listPhiCountingAddonRolesHeldThroughSiteAccess,
} from "@/lib/addons/viewer-roles";
import {
  grantPhisAddonUserRole,
  readPhiSiteUserAddonRoles,
  replacePhisAddonUserRoles,
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
 *
 * Every call here sees and writes the roles of the Add-ons that count on the Site -- enabled and available
 * (`listPhiCountingAddonDeclaredRoles`), the set user administration reads and saves. A role of an Add-on
 * outside it guards nothing here and would silently start to count the day the Add-on is back, so naming one
 * is `addon_unknown`, and what is stored for it is neither shown nor touched.
 */

type Body = { addonId?: unknown; role?: unknown; userId?: unknown };

/** The roles an Add-on that counts here declares, or null for any other Add-on. */
function readCountingDeclaredRoles(addonId: string, availableProviderIds: ReadonlySet<string>) {
  return listPhiCountingAddonDeclaredRoles(availableProviderIds).get(addonId) ?? null;
}

/**
 * What one person holds of the roles that count here, as the answers with `userId` carry it: `held`, the
 * stored grants; `implied`, what a Site access of theirs hands them without one (`impliedBy`, with what it
 * includes); `holdsAll`, whether they are Site Admin. The two last from one read of their authorization
 * snapshot, beside the one read of their grants.
 */
async function readPersonAddonRoles(siteId: number, userId: number, availableProviderIds: ReadonlySet<string>) {
  const [grants, holdsSiteAccess] = await Promise.all([
    readPhiSiteUserAddonRoles(getPool(), { siteId, userId }),
    readPhisSiteAccessHolder(siteId, userId),
  ]);
  return {
    held: filterPhiCountingAddonGrants(grants, availableProviderIds),
    implied: listPhiCountingAddonRolesHeldThroughSiteAccess(availableProviderIds, holdsSiteAccess),
    holdsAll: holdsSiteAccess(PHIS_SITE_ACCESS.siteAdmin),
  };
}

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
 * Every role of every Add-on that counts here, each marked with whether the caller may grant it, and
 * optionally what one person already holds, and whether that is every role.
 *
 * `held` is the stored assignments that count, as `GET /api/site/admin/users` lists them; `implied` is
 * `[{ addonId, role, through: { siteAccess } }]`, every role a Site access of theirs hands them without a grant
 * (a role's `impliedBy`, and what it includes), whether or not it is stored as well -- shown, never written;
 * `holdsAll` is true when the person is Site Admin, who holds every declared role whatever is stored (and
 * whose `implied` is empty). Each catalog role carries its `impliedBy` as declared.
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

  const requested = request.nextUrl.searchParams.get("userId");
  let userId: number | null = null;
  if (requested) {
    userId = Number.parseInt(requested, 10);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      return NextResponse.json({ error: "userId is invalid." }, { status: 400 });
    }
  }

  const availableProviderIds = await readAvailablePhisProviderIds(context.site.id);
  const addons = await readPhisAddonRoleCatalog({
    siteId: context.site.id,
    actorUserId: context.session.userId,
    availableProviderIds,
  });
  if (userId === null) {
    return NextResponse.json({ addons });
  }
  if (!addons.some((addon) => addon.roles.some((role) => role.grantable))) {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }
  return NextResponse.json({ addons, userId, ...await readPersonAddonRoles(context.site.id, userId, availableProviderIds) });
}

/**
 * Sets the roles one person holds in one Add-on to exactly the ones named, in one call.
 *
 * The difference to what is held is what changes: every role to give and every role to take back needs
 * the caller's standing, as it would one at a time, and a single refusal writes nothing. A role stored
 * that the manifest no longer declares is left as it is -- it is not the caller's to see or to decide. An
 * Add-on that does not count here is `addon_unknown`.
 */
export async function PUT(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) return error;
  if (!context?.site || !context.session) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as
    { addonId?: unknown; roles?: unknown; userId?: unknown } | null;
  if (
    typeof body?.addonId !== "string" ||
    !Array.isArray(body.roles) ||
    !body.roles.every((role) => typeof role === "string") ||
    !Number.isSafeInteger(body.userId) ||
    (body.userId as number) <= 0
  ) {
    return NextResponse.json({ error: "addonId, roles and userId are required." }, { status: 400 });
  }
  const addonId = body.addonId;
  const userId = body.userId as number;
  const wanted = new Set(body.roles as string[]);

  const availableProviderIds = await readAvailablePhisProviderIds(context.site.id);
  const declared = readCountingDeclaredRoles(addonId, availableProviderIds);
  if (declared === null) {
    return NextResponse.json({ error: "addon_unknown" }, { status: 404 });
  }
  const declaredNames = new Set(declared.map((role) => role.name));
  if ([...wanted].some((role) => !declaredNames.has(role))) {
    return NextResponse.json({ error: "role_undeclared" }, { status: 404 });
  }
  if (!await getUserSiteMembership(userId, context.site.id)) {
    return NextResponse.json({ error: "user_not_member" }, { status: 404 });
  }

  const held = (await readPhiSiteUserAddonRoles(getPool(), { siteId: context.site.id, userId }))
    .filter((grant) => grant.addonId === addonId && declaredNames.has(grant.role))
    .map((grant) => grant.role);
  const grant = declared.map((role) => role.name).filter((name) => wanted.has(name) && !held.includes(name));
  const revoke = declared.map((role) => role.name).filter((name) => !wanted.has(name) && held.includes(name));

  for (const role of [...grant, ...revoke]) {
    const verdict = await mayGrantPhisAddonRole({
      addonId,
      siteId: context.site.id,
      actorUserId: context.session.userId,
      role,
      declared,
    });
    if (!verdict.allowed) {
      const status = verdict.reason === "not_permitted" ? 403 : 404;
      return NextResponse.json({ error: verdict.reason, role }, { status });
    }
  }

  const changed = await replacePhisAddonUserRoles(getPool(), {
    addonId,
    siteId: context.site.id,
    userId,
    grant,
    revoke,
    grantedByUserId: context.session.userId,
  });
  for (const role of changed.granted) {
    logRuntimeEvent("info", "addon.role.granted", {
      siteKey: context.site.key,
      pluginKey: addonId,
      meta: { role, userId, added: true },
    });
  }
  for (const role of changed.revoked) {
    logRuntimeEvent("info", "addon.role.revoked", {
      siteKey: context.site.key,
      pluginKey: addonId,
      meta: { role, userId, removed: true },
    });
  }

  const addons = await readPhisAddonRoleCatalog({
    siteId: context.site.id,
    actorUserId: context.session.userId,
    availableProviderIds,
  });
  return NextResponse.json({ addons, userId, ...await readPersonAddonRoles(context.site.id, userId, availableProviderIds) });
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
    declared: readCountingDeclaredRoles(input.addonId, await readAvailablePhisProviderIds(context.site.id)),
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
    declared: readCountingDeclaredRoles(input.addonId, await readAvailablePhisProviderIds(context.site.id)),
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
