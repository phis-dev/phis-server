import { NextRequest, NextResponse } from "next/server";

import { setUserProfilePhones } from "@/db/user-profiles";
import { requireAuthenticatedSiteUser } from "@/lib/site-auth/authenticated-site-user";

/** The columns' width (`user_profiles.phone`, `mobile`). */
export const PROFILE_PHONE_MAX_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

type ProfilePhonePayload = { phone?: unknown; mobile?: unknown };

/** A number as the person typed it, trimmed; null clears it. Undefined where the value is no number. */
function readNumber(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > PROFILE_PHONE_MAX_LENGTH) return undefined;
  return trimmed || null;
}

/**
 * The person's business telephone and mobile number, `{ phone, mobile }`, each a string of at most 64
 * characters or null, both stated: what is sent is what is kept, so a client cannot clear one by leaving it
 * out. The numbers are the profile's and so the same on every Site; a change owes `user.changed` with
 * `phone` on each of them (users:v1). A person who has no profile yet sets their name first: 409.
 */
export async function PATCH(request: NextRequest) {
  const guarded = await requireAuthenticatedSiteUser(request);
  if (!guarded.ok) return guarded.response;
  const { user } = guarded;

  let payload: ProfilePhonePayload;
  try {
    payload = (await request.json()) as ProfilePhonePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  if (typeof payload !== "object" || payload === null || !Object.hasOwn(payload, "phone") || !Object.hasOwn(payload, "mobile")) {
    return NextResponse.json({ error: "Send phone and mobile, each a number or null." }, { status: 400 });
  }
  const phone = readNumber(payload.phone);
  const mobile = readNumber(payload.mobile);
  if (phone === undefined || mobile === undefined) {
    return NextResponse.json(
      { error: `A telephone number is a line of text of at most ${PROFILE_PHONE_MAX_LENGTH} characters, or null.` },
      { status: 400 },
    );
  }

  if (!await setUserProfilePhones({ userId: user.id, phone, mobile })) {
    return NextResponse.json({ error: "Set a first and last name before a telephone number." }, { status: 409 });
  }
  return NextResponse.json({ phone, mobile });
}
