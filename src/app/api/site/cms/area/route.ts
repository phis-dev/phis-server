import type { NextRequest } from "next/server";

import { handleSiteCmsAreaDelete, handleSiteCmsAreaWrite } from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsAreaWrite(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsAreaDelete(request);
}
