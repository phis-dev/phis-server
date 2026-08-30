import type { NextRequest } from "next/server";

import { handleSiteCmsPagePublish } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsPagePublish(request);
}
