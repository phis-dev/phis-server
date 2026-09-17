import { NextResponse } from "next/server";

import { createCsrfToken, setCsrfCookie } from "@/lib/auth";

export async function GET() {
  const token = createCsrfToken();
  const response = NextResponse.json({ token });
  setCsrfCookie(response, token);
  return response;
}
