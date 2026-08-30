import type { NextRequest } from "next/server";

import {
  handleSiteCmsThemeDelete,
  handleSiteCmsThemeRead,
  handleSiteCmsThemeWrite,
} from "@/lib/site-cms-theme-route";

export async function GET(request: NextRequest) {
  return handleSiteCmsThemeRead(request);
}

export async function POST(request: NextRequest) {
  return handleSiteCmsThemeWrite(request);
}

export async function DELETE(request: NextRequest) {
  return handleSiteCmsThemeDelete(request);
}
