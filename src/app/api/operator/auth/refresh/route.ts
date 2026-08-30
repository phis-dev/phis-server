import { NextRequest, NextResponse } from "next/server";

import { setAreaCookie } from "@/lib/auth";
import {
  buildOperatorSessionExpiresAt,
  getOperatorSessionFromRequest,
  setOperatorSessionCookie,
} from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = getOperatorSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const expiresAt = buildOperatorSessionExpiresAt();
  const response = NextResponse.json({});

  setOperatorSessionCookie(response, {
    email: session.email,
    displayName: session.displayName,
    expiresAt,
  });
  setAreaCookie(response, "operator", expiresAt);

  return response;
}
