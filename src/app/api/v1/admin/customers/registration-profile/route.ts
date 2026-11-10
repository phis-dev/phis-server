import { NextResponse } from "next/server";

import {
  getLatestRegistrationIntentProfileByEmail,
  searchLatestRegistrationIntentProfiles,
} from "@/db/registration-intents";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { requireSiteFromRequest } from "@/lib/site-context";

function normalize(value: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  const email = normalize(url.searchParams.get("email"));
  const query = normalize(url.searchParams.get("q"));

  if (query) {
    const matches = await searchLatestRegistrationIntentProfiles(site.id, query);

    return NextResponse.json({
      matches: matches.map((profile) => ({
        siteKey: site.key,
        email: profile.email,
        fullName: profile.fullName,
        companyName: profile.companyName,
        locale: profile.locale,
        newsletterOptIn: profile.newsletterOptIn,
        status: profile.status,
        registeredAt: profile.createdAt,
        verifiedAt: profile.verifiedAt,
        consumedAt: profile.consumedAt,
      })),
    });
  }

  if (!email || !email.includes("@") || !email.includes(".")) {
    return NextResponse.json({ error: "Missing or invalid email." }, { status: 400 });
  }

  const profile = await getLatestRegistrationIntentProfileByEmail(site.id, email);

  return NextResponse.json({
    profile: profile
      ? {
          siteKey: site.key,
          email: profile.email,
          fullName: profile.fullName,
          companyName: profile.companyName,
          locale: profile.locale,
          newsletterOptIn: profile.newsletterOptIn,
          status: profile.status,
          registeredAt: profile.createdAt,
          verifiedAt: profile.verifiedAt,
          consumedAt: profile.consumedAt,
        }
      : null,
  });
}
