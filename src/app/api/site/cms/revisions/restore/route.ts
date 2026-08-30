import type { NextRequest } from "next/server";

import { handleSiteCmsRevisionRestore } from "@/lib/site-cms-revisions-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsRevisionRestore(request);
}
