import { NextRequest, NextResponse } from "next/server";

import { getSessionFromRequest, revokeSession } from "@/db/user-sessions";
import { clearAreaCookie, clearCsrfCookie, clearSessionCookie, verifyCsrfRequest } from "@/lib/auth";
import { requireSiteFromRequest } from "@/lib/site-context";

export async function POST(request: NextRequest) {
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }

  const session = await getSessionFromRequest(request, site.id, {
    allowDisabled: true,
    allowIncomplete: true,
    allowPasswordChangeRequired: true,
  });
  const response = NextResponse.json({});

  if (session) {
    await revokeSession(session.id);
  }

  clearSessionCookie(response);
  clearCsrfCookie(response);
  clearAreaCookie(response);
  return response;
}
