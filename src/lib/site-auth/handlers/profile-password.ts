import { NextRequest, NextResponse } from "next/server";

import { getUserAccountById, updateUserAccountPasswordHash } from "@/db/user-accounts";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { hashPassword, verifyPasswordHash } from "@/lib/password";
import { requireSiteFromRequest } from "@/lib/site-context";
import { revokeUserSessions } from "@/db/user-sessions";

type ProfilePasswordPayload = {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function PATCH(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  const session = await getSessionFromRequest(request, site.id);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const user = await getUserAccountById(session.userId);
  if (!user || !user.siteIds.includes(site.id)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const siteRole = await getEffectiveUserSiteAuthorization(user.id, site.id);
  if (!siteRole.enabled) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: ProfilePasswordPayload = {};
  try {
    payload = (await request.json()) as ProfilePasswordPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const currentPassword = normalize(payload.currentPassword);
  const newPassword = normalize(payload.newPassword);
  const confirmPassword = normalize(payload.confirmPassword);

  if (!currentPassword) {
    return NextResponse.json({ error: "Missing current password." }, { status: 400 });
  }

  if (!newPassword || !confirmPassword) {
    return NextResponse.json({ error: "Missing new password fields." }, { status: 400 });
  }

  if (!user.passwordHash) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const validPassword = await verifyPasswordHash(user.passwordHash, currentPassword);
  if (!validPassword) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  if (newPassword.length < 10) {
    return NextResponse.json({ error: "Password is too short." }, { status: 400 });
  }

  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 });
  }

  const passwordHash = await hashPassword(newPassword);
  await updateUserAccountPasswordHash(user.id, passwordHash, {
    clearFlags: PhiUserAccountFlag.MustChangePassword,
  });
  /*
   * Everywhere else is signed out; here is not.
   *
   * The point of the revoke is somebody else holding a session, so it has to be every other one. This
   * one belongs to whoever just proved the old password, and taking it would answer a password change
   * with a login screen.
   */
  await revokeUserSessions(user.id, { exceptSessionId: session.id });

  return NextResponse.json({});
}
