import type { NextRequest } from "next/server";

import { PATCH as handleProfileName } from "@/lib/site-auth/handlers/profile-name";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  return (await guardApiV1(request, { requireInternalToken: true })) ?? handleProfileName(request);
}
