import type { NextRequest } from "next/server";

import { handleSiteCmsThemeDraftRead } from "@/lib/site-cms-theme-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsThemeDraftRead(request);
}
