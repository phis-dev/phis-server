import { NextResponse } from "next/server";

import {
  getRegistrationIntentByVerificationToken,
  markRegistrationIntentExpired,
  REGISTRATION_INTENT_STATUS_CONSUMED,
  REGISTRATION_INTENT_STATUS_PENDING,
  REGISTRATION_INTENT_STATUS_VERIFIED,
} from "@/db/registration-intents";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { hasExpiryPassed } from "@/lib/helpers/expiry";
import { requireSiteFromRequest } from "@/lib/site-context";

function normalize(value: string | null) {
  return value?.trim() ?? "";
}

function buildFullName(firstName: string | null | undefined, lastName: string | null | undefined) {
  return [firstName?.trim() ?? "", lastName?.trim() ?? ""].filter(Boolean).join(" ").trim();
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
  const token = normalize(url.searchParams.get("token"));

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return NextResponse.json(
      { ok: false, code: "invalid_token", error: "The verification link is invalid." },
      { status: 400 },
    );
  }

  const intent = await getRegistrationIntentByVerificationToken(site.id, token);
  if (!intent) {
    return NextResponse.json(
      { ok: false, code: "invalid_token", error: "The verification link is invalid." },
      { status: 404 },
    );
  }

  if (
    intent.status === REGISTRATION_INTENT_STATUS_CONSUMED ||
    intent.status === REGISTRATION_INTENT_STATUS_VERIFIED
  ) {
    return NextResponse.json({
      ok: true,
      status: "already_confirmed",
      preview: {
        firstName: intent.firstName,
        lastName: intent.lastName,
        fullName: buildFullName(intent.firstName, intent.lastName),
        email: intent.email,
        companyName: intent.companyName,
      },
    });
  }

  if (intent.status !== REGISTRATION_INTENT_STATUS_PENDING) {
    return NextResponse.json(
      { ok: false, code: "invalid_state", error: "This verification link can no longer be used." },
      { status: 409 },
    );
  }

  if (hasExpiryPassed(intent.verificationTokenExpiresAt)) {
    await markRegistrationIntentExpired(intent.id);
    return NextResponse.json(
      { ok: false, code: "expired", error: "This verification link has expired." },
      { status: 410 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: "pending",
    preview: {
      firstName: intent.firstName,
      lastName: intent.lastName,
      fullName: intent.fullName,
      email: intent.email,
      companyName: intent.companyName,
    },
  });
}
