import { NextRequest, NextResponse } from "next/server";

import { updateUserAccountProfileFields } from "@/db/user-accounts";
import { setThemeModeCookie } from "@/lib/auth";
import {
  resolveUserThemeModeFlagUpdate,
  resolveUserThemeModeName,
} from "@/lib/user-flags";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";

type ProfileThemePayload = {
  themeMode?: unknown;
};

export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request);
  if (!guarded.ok) return guarded.response;
  const { session, user } = guarded;

  let payload: ProfileThemePayload = {};
  try {
    payload = (await request.json()) as ProfileThemePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  /*
   * Two bits on the account, not a field of its own: every answer clears both and then sets at most
   * one, so "back to system" is simply the update that sets nothing and needs no case of its own.
   */
  const update = resolveUserThemeModeFlagUpdate(payload.themeMode);
  if (!update) {
    return NextResponse.json({ error: "Unsupported theme mode." }, { status: 400 });
  }

  const updated = await updateUserAccountProfileFields(user.id, update);
  if (!updated) {
    return NextResponse.json({ error: "Failed to update theme mode." }, { status: 500 });
  }

  const themeMode = resolveUserThemeModeName(updated.flags);
  const response = NextResponse.json({ themeMode });
  setThemeModeCookie(
    response,
    themeMode,
    session.expiresAt ? new Date(session.expiresAt) : undefined,
  );

  return response;
}
