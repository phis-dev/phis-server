import type { NextRequest } from "next/server";

import { handleSiteCmsPageOverrideDelete } from "@/lib/site-cms-write-route";

export async function DELETE(request: NextRequest) {
  return handleSiteCmsPageOverrideDelete(request);
}
