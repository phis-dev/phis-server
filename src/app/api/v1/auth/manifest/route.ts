import { NextResponse } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { buildPublicAuthManifest } from "@/lib/site-auth/manifest";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }
  const context = await requireSiteFromExplicitKeyRequest(request);
  if (context.error || !context.site) {
    return context.error;
  }
  return NextResponse.json(await buildPublicAuthManifest(context.site.id));
}
