import type { NextRequest } from "next/server";

import { POST as handlePasswordLogin } from "@/lib/site-auth/handlers/password-login";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handlePasswordLogin(request);
}
