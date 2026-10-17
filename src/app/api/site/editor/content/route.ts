import type { NextRequest } from "next/server";

import { handleSiteEditorContentRead, handleSiteEditorContentWrite } from "@/lib/site-content-route";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleSiteEditorContentRead(request);
}

export async function PUT(request: NextRequest) {
  return handleSiteEditorContentWrite(request);
}
