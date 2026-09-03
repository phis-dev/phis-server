import type { NextRequest } from "next/server";

import {
  handleSiteCmsAreaModulesDelete,
  handleSiteCmsAreaModulesWrite,
} from "@/lib/site-cms-write-route";

export async function POST(request: NextRequest) {
  return handleSiteCmsAreaModulesWrite(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsAreaModulesDelete(request);
}
