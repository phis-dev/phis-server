import type { NextRequest } from "next/server";

import { handleSiteCmsAreaModulesPublish } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsAreaModulesPublish(request);
}
