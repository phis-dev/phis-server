import { NextRequest, NextResponse } from "next/server";

import { getSiteRuntimeConfig } from "@/db/sites";
import { setAuthFlowCookie, verifyCsrfRequest } from "@/lib/auth";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { normalizeProviderKey } from "@/lib/site-auth/contracts";
import { startProviderAuthentication } from "@/lib/site-auth/provider-flow";
import { requireSiteFromExplicitKeyRequest } from "@/lib/site-context";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string }> };

export async function POST(request: NextRequest, context: Context) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }
  const siteContext = await requireSiteFromExplicitKeyRequest(request);
  if (siteContext.error || !siteContext.site) {
    return siteContext.error;
  }
  if (!verifyCsrfRequest(request)) {
    return NextResponse.json({ error: "Invalid CSRF token." }, { status: 403 });
  }
  const methodKey = normalizeProviderKey((await context.params).provider);
  if (!methodKey) {
    return NextResponse.json({ error: "Unknown authentication provider." }, { status: 404 });
  }
  const runtime = await getSiteRuntimeConfig(siteContext.site.id);
  if (!runtime) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }
  let payload: { next?: unknown; installation?: unknown } = {};
  try {
    payload = await request.json() as { next?: unknown; installation?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }
  const requestedInstallation =
    request.nextUrl.searchParams.get("installation")?.trim().toLowerCase() ||
    (typeof payload.installation === "string" ? payload.installation.trim().toLowerCase() : "");
  try {
    const result = await startProviderAuthentication({
      siteId: siteContext.site.id,
      sitePublicUrl: runtime.publicUrl,
      methodKey,
      installationKey: requestedInstallation || null,
      nextPath: payload.next,
    });
    // The state goes to the browser that asked, so the callback can refuse a flow somebody else began.
    const response = NextResponse.json({ redirectUrl: result.redirectUrl });
    setAuthFlowCookie(response, result.state, result.expiresAt);
    return response;
  } catch (error) {
    const code = error instanceof Error ? error.message : "AUTH_PROVIDER_START_FAILED";
    const unavailable = code === "AUTH_METHOD_DISABLED" ||
      code === "AUTH_PROVIDER_UNAVAILABLE" ||
      code === "AUTH_PROVIDER_SECRET_MISSING";
    return NextResponse.json(
      { error: unavailable ? "Authentication provider unavailable." : "Authentication could not be started." },
      { status: unavailable ? 404 : 502 },
    );
  }
}
