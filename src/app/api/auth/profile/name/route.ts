import { NextRequest, NextResponse } from "next/server";

import { getUserAccountById } from "@/db/user-accounts";
import { getUserProfileByUserId, upsertUserProfile } from "@/db/user-profiles";
import { getEffectiveUserSiteAuthorization } from "@/db/user-site-memberships";
import { getSessionFromRequest } from "@/db/user-sessions";
import { verifyCsrfRequest } from "@/lib/auth";
import { requireSiteFromRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

type ProfileNamePayload = {
  firstName?: unknown;
  lastName?: unknown;
  companyName?: unknown;
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
