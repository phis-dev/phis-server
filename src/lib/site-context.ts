import "server-only";

import { NextResponse } from "next/server";

import { getSiteByKey, type SiteRecord } from "@/db/sites";
import { PHIS_SITE_KEY_HEADER } from "@/lib/constants/http-headers";
import { normalizePhiSiteKey } from "@/lib/helpers/normalize";
import { notePhiLogSite } from "@/lib/log";

type HeaderReader = {
  get(name: string): string | null;
};

/**
 * Resolves the Site exclusively from the explicit `x-phis-site-key` header.
 *
 * The former `x-forwarded-host`/`host`/`origin`/`referer` fallback is removed: those headers are
 * caller-controlled, so a request without the explicit key could claim any Site whose hostname it
 * spoofed. Every legitimate caller — the shared-ui gateways, the Skeleton proxies, and direct SSR
 * calls — already sends the key; a request without it is simply not Site-scoped.
 */
export async function resolveSiteFromHeaders(headers: HeaderReader): Promise<SiteRecord | null> {
  const explicitKey = normalizePhiSiteKey(headers.get(PHIS_SITE_KEY_HEADER));
  if (!explicitKey) {
    return null;
  }
  const site = await getSiteByKey(explicitKey);
  if (site) notePhiLogSite(site.key);
  return site;
}

export async function requireSiteFromRequest(request: Request) {
  return resolveSiteFromHeaders(request.headers);
}

export async function requireSiteFromExplicitKeyRequest(request: Request) {
  const explicitKey = normalizePhiSiteKey(request.headers.get(PHIS_SITE_KEY_HEADER));
  if (!explicitKey) {
    return {
      site: null,
      error: NextResponse.json({ error: `Missing ${PHIS_SITE_KEY_HEADER} header.` }, { status: 400 }),
    };
  }

  const site = await getSiteByKey(explicitKey);
  if (site) notePhiLogSite(site.key);
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
