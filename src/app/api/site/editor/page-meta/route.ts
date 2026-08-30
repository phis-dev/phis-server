import type { NextRequest } from "next/server";

import { handleSiteEditorPageMetaWrite } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteEditorPageMetaWrite(request);
}
