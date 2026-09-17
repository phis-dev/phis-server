import type { NextRequest } from "next/server";

import { PATCH as handleProfileNewsletter } from "@/lib/site-auth/handlers/profile-newsletter";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handleProfileNewsletter(request);
}
