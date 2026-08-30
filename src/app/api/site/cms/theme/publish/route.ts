import type { NextRequest } from "next/server";

import { handleSiteCmsThemePublish } from "@/lib/site-cms-theme-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsThemePublish(request);
}
