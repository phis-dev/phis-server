import type { NextRequest } from "next/server";

import { handleSiteCmsAreaOverrideDelete } from "@/lib/site-cms-write-route";

export async function DELETE(request: NextRequest) {
  return handleSiteCmsAreaOverrideDelete(request);
}
