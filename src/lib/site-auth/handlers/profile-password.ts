import { NextRequest, NextResponse } from "next/server";

import { updateUserAccountPasswordHash } from "@/db/user-accounts";
import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";
import { hashPassword, verifyPasswordHash } from "@/lib/password";
import { revokeUserSessions } from "@/db/user-sessions";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";
import { normalizeString } from "@/lib/helpers/request";

type ProfilePasswordPayload = {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
};

export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request, { allowPasswordChangeRequired: true });
  if (!guarded.ok) return guarded.response;
  const { session, user } = guarded;

  let payload: ProfilePasswordPayload = {};
  try {
    payload = (await request.json()) as ProfilePasswordPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const currentPassword = normalizeString(payload.currentPassword);
  const newPassword = normalizeString(payload.newPassword);
  const confirmPassword = normalizeString(payload.confirmPassword);

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
