import type { NextRequest } from "next/server";

import { PATCH as handleProfilePassword } from "@/lib/site-auth/handlers/profile-password";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  return (await guardApiV1(request, { requireInternalToken: true })) ?? handleProfilePassword(request);
}
