import "server-only";

import { NextResponse } from "next/server";

import { getSiteByKey, type SiteRecord } from "@/db/sites";

type HeaderReader = {
  get(name: string): string | null;
};

function normalizeSiteKey(input?: string | null) {
  return input?.trim().toLowerCase() ?? "";
}

/**
 * Resolves the Site exclusively from the explicit `x-phi-site-key` header.
 *
 * The former `x-forwarded-host`/`host`/`origin`/`referer` fallback is removed: those headers are
 * caller-controlled, so a request without the explicit key could claim any Site whose hostname it
 * spoofed. Every legitimate caller — the shared-ui gateways, the Skeleton proxies, and direct SSR
 * calls — already sends the key; a request without it is simply not Site-scoped.
 */
export async function resolveSiteFromHeaders(headers: HeaderReader): Promise<SiteRecord | null> {
  const explicitKey = normalizeSiteKey(headers.get("x-phi-site-key"));
  if (!explicitKey) {
    return null;
  }
  return getSiteByKey(explicitKey);
}

export async function requireSiteFromRequest(request: Request) {
  return resolveSiteFromHeaders(request.headers);
}

export async function requireSiteFromExplicitKeyRequest(request: Request) {
  const explicitKey = normalizeSiteKey(request.headers.get("x-phi-site-key"));
  if (!explicitKey) {
    return {
      site: null,
      error: NextResponse.json({ error: "Missing x-phi-site-key header." }, { status: 400 }),
    };
  }

  const site = await getSiteByKey(explicitKey);
  if (!site) {
    return {
      site: null,
      error: NextResponse.json({ error: "Site not found." }, { status: 404 }),
    };
  }

  return {
    site,
    error: null,
  };
}
