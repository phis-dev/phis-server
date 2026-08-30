import type { NextRequest } from "next/server";

import { handleSiteCmsNavigationPublish } from "@/lib/site-cms-navigation-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsNavigationPublish(request);
}
