import { NextRequest, NextResponse } from "next/server";

import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";
import { normalizeString } from "@/lib/helpers/request";

type ProfileNamePayload = {
  firstName?: unknown;
  lastName?: unknown;
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

  if (!firstName || !lastName) {
    return NextResponse.json({ error: "Missing first name or last name." }, { status: 400 });
  }

  await upsertUserProfile({
    userId: user.id,
    firstName,
    lastName,
    companyName: companyName || null,
  });

  const profile = await getUserProfileByUserId(user.id);
  return NextResponse.json({
    profile: profile
      ? {
          firstName: profile.firstName,
          lastName: profile.lastName,
          companyName: profile.companyName,
        }
      : null,
  });
}
