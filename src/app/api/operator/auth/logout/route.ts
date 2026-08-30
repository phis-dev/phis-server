import { NextResponse } from "next/server";

import { clearAreaCookie, clearCsrfCookie } from "@/lib/auth";
import { clearOperatorSessionCookie } from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({});
  clearOperatorSessionCookie(response);
  clearCsrfCookie(response);
  clearAreaCookie(response);
  return response;
}
