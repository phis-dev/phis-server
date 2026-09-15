import type { NextRequest } from "next/server";

import { handleSiteCmsPageCreate } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsPageCreate(request);
}
