import { NextRequest, NextResponse } from "next/server";

import { isBootstrapEnabled } from "@/lib/config";
import { getOperatorSessionFromRequest } from "@/lib/operator-auth";
import { readOperatorOverviewSnapshot } from "@/lib/operator-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (isBootstrapEnabled()) {
    return NextResponse.json({ error: "Bootstrap is still active." }, { status: 423 });
  }

  const session = getOperatorSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return NextResponse.json(readOperatorOverviewSnapshot());
}
