import { NextRequest, NextResponse } from "next/server";

import { setAreaCookie } from "@/lib/auth";
import { readPhiRuntimeConfigSync } from "@/lib/config-files";
import {
  buildOperatorSessionExpiresAt,
  clearOperatorSessionCookie,
  getOperatorSessionFromRequest,
  setOperatorSessionCookie,
} from "@/lib/operator-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = getOperatorSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  /*
   * A refresh re-signs a valid cookie, and used to re-sign it whoever the operator had become: removed
   * from the list or disabled, they could keep the session alive for as long as they kept refreshing.
   * The list is the account; a refresh asks it the way the login does.
   */
  const operator = (readPhiRuntimeConfigSync().platformSuperUsers ?? []).find(
    (entry) => entry.email.trim().toLowerCase() === session.email,
  );
  if (!operator || operator.enabled === false) {
    const refused = NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    clearOperatorSessionCookie(refused);
    return refused;
  }

  const expiresAt = buildOperatorSessionExpiresAt();
  const response = NextResponse.json({});

  setOperatorSessionCookie(response, {
    email: session.email,
    displayName: session.displayName,
    expiresAt,
    // Reading the session already held it to the operator's current generation.
    generation: session.generation,
  });
  setAreaCookie(response, "operator", expiresAt);

  return response;
}
