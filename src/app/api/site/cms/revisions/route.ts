import type { NextRequest } from "next/server";

import {
  handleSiteCmsRevisionDelete,
  handleSiteCmsRevisionsRead,
} from "@/lib/site-cms-revisions-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsRevisionsRead(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsRevisionDelete(request);
}
