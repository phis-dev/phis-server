import type { NextRequest } from "next/server";

import { POST as handleProfileEmailRequest } from "@/lib/site-auth/handlers/profile-email-request";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handleProfileEmailRequest(request);
}
