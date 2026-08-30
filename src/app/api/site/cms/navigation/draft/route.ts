import type { NextRequest } from "next/server";

import { handleSiteCmsNavigationDraftRead } from "@/lib/site-cms-navigation-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsNavigationDraftRead(request);
}
