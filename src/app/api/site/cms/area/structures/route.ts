import type { NextRequest } from "next/server";

import { handleSiteCmsAreaStructuresRead } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsAreaStructuresRead(request);
}
