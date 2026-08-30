import type { NextRequest } from "next/server";

import { POST as handlePasswordResetRequest } from "@/app/api/auth/password/reset/request/route";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handlePasswordResetRequest(request);
}
