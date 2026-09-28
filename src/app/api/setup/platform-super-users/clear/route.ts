import { NextResponse } from "next/server";

import { isBootstrapEnabled } from "@/lib/config";
import {
  readPhiRuntimeConfigSync,
  writePhiRuntimeConfigSync,
} from "@/lib/config-files";
import { isSameOriginRequest } from "@/lib/helpers/request";

export async function POST(request: Request) {
  if (!isBootstrapEnabled()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // No session exists yet to ask, so the page asking is the check: a cross-site form must not empty
  // the operator list of an installation that is being set up.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 });
  }

  const runtimeConfig = readPhiRuntimeConfigSync();

  writePhiRuntimeConfigSync({
    ...runtimeConfig,
    platformSuperUsers: [],
  });

  return NextResponse.json({});
}
