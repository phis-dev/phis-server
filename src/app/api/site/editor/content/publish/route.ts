import type { NextRequest } from "next/server";

import { handleSiteEditorContentPublish } from "@/lib/site-content-route";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleSiteEditorContentPublish(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteEditorContentPublish(request);
}
