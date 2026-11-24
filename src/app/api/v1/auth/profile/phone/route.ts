import type { NextRequest } from "next/server";

import { PATCH as handleProfilePhone } from "@/lib/site-auth/handlers/profile-phone";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's business telephone and mobile number: `{ phone: string | null, mobile: string |
 * null }`, both stated, each at most 64 characters; answers the two as kept. `/api/v1/auth/me` reads them
 * back in `user.profile`. `409` while the person has no profile (no name yet). A change owes `user.changed`
 * with `phone` on every Site the person is a member of (users:v1).
 */
export async function PATCH(request: NextRequest) {
  return (await guardApiV1(request, { requireInternalToken: true })) ?? handleProfilePhone(request);
}
