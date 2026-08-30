import type { NextRequest } from "next/server";

import { handleSiteCmsAreaDraftRead } from "@/lib/site-cms-write-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsAreaDraftRead(request);
}
