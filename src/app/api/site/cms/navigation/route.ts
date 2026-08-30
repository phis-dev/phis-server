import type { NextRequest } from "next/server";

import {
  handleSiteCmsNavigationDelete,
  handleSiteCmsNavigationRead,
  handleSiteCmsNavigationWrite,
} from "@/lib/site-cms-navigation-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsNavigationRead(request);
}

export async function POST(request: NextRequest) {
  return handleSiteCmsNavigationWrite(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsNavigationDelete(request);
}
