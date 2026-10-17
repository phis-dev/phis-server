import { NextRequest, NextResponse } from "next/server";

import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";
import { normalizeString } from "@/lib/helpers/request";

/** The column's width; a name shown beside a post is a name, not a sentence. */
const PROFILE_DISPLAY_NAME_MAX_LENGTH = 128;

type ProfileNamePayload = {
  firstName?: unknown;
  lastName?: unknown;
  displayName?: unknown;
  companyName?: unknown;
};

export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request);
  if (!guarded.ok) return guarded.response;
  const { user } = guarded;

  let payload: ProfileNamePayload = {};
  try {
    payload = (await request.json()) as ProfileNamePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const firstName = normalizeString(payload.firstName);
  const lastName = normalizeString(payload.lastName);
  const companyName = normalizeString(payload.companyName);
  // Absent leaves the stored name alone, so a client that predates the field cannot clear it by omission.
  const displayName = Object.hasOwn(payload, "displayName") ? normalizeString(payload.displayName) || null : undefined;
  if (displayName && displayName.length > PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `The display name must be at most ${PROFILE_DISPLAY_NAME_MAX_LENGTH} characters.` },
      { status: 400 },
    );
  }

  if (!firstName || !lastName) {
    return NextResponse.json({ error: "Missing first name or last name." }, { status: 400 });
  }

  await upsertUserProfile({
    userId: user.id,
    firstName,
    lastName,
    displayName,
    companyName: companyName || null,
  });

  const profile = await getUserProfileByUserId(user.id);
  return NextResponse.json({
    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          displayName: profile.displayName,
          companyName: profile.companyName,
        }
      : null,
  });
}
