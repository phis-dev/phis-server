import { NextRequest, NextResponse } from "next/server";

import { clearAreaCookie, clearCsrfCookie } from "@/lib/auth";
import {
  clearOperatorSessionCookie,
  endOperatorSessions,
  getOperatorSessionFromRequest,
} from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  /*
   * Clearing the cookie only empties this browser. A copy taken from it would have stayed good until it
   * expired, so a logout also counts the operator's session generation up, which ends that copy and
   * every other session the operator holds.
   */
  const session = getOperatorSessionFromRequest(request);
  if (session) {
    endOperatorSessions(session.email);
  }
  const response = NextResponse.json({});
  clearOperatorSessionCookie(response);
  clearCsrfCookie(response);
  clearAreaCookie(response);
  return response;
}
