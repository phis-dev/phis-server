import type { NextRequest } from "next/server";

import { handleSiteCmsPageDraftRead } from "@/lib/site-cms-write-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsPageDraftRead(request);
}
