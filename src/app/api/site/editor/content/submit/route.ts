import type { NextRequest } from "next/server";

import { handleSiteEditorContentSubmit } from "@/lib/site-content-route";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return handleSiteEditorContentSubmit(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteEditorContentSubmit(request);
}
