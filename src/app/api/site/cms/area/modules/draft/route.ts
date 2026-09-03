import type { NextRequest } from "next/server";

import { handleSiteCmsAreaModulesDraftRead } from "@/lib/site-cms-write-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsAreaModulesDraftRead(request);
}
