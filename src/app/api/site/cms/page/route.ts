import type { NextRequest } from "next/server";

import { handleSiteCmsPageDelete, handleSiteCmsPageWrite } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsPageWrite(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsPageDelete(request);
}
