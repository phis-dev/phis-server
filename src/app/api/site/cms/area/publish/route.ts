import type { NextRequest } from "next/server";

import { handleSiteCmsAreaPublish } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsAreaPublish(request);
}
