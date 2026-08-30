import type { NextRequest } from "next/server";

import { GET as handleViewer } from "@/app/api/auth/me/route";
import { guardApiV1 } from "@/lib/api-v1-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return guardApiV1(request, { requireInternalToken: true }) ?? handleViewer(request);
}
