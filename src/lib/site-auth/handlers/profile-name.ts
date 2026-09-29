import { NextRequest, NextResponse } from "next/server";

import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";

type ProfileNamePayload = {
  firstName?: unknown;
  lastName?: unknown;
  companyName?: unknown;
};

function normalize(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

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

  const firstName = normalize(payload.firstName);
  const lastName = normalize(payload.lastName);
  const companyName = normalize(payload.companyName);

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
