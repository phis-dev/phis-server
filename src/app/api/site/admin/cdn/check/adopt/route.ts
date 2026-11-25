import { NextRequest, NextResponse } from "next/server";

import { PHIS_CDN_ADOPT_KEYS_MAX, type PhisCdnAdoptResultV1 } from "@phis/contracts/addon";

import { requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { adoptPhisCdnObjects } from "@/lib/cdn-catalogue.mts";
import { nextCdnError, readPhisCdnSiteLimits, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";
import { readJsonObjectBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * Takes objects of the bucket the catalogue does not hold into it (`PhisCdnAdoptRequestV1`, at most
 * `PHIS_CDN_ADOPT_KEYS_MAX` keys): each hashed once from the bucket and recorded with origin `cli`, as
 * `phis cdn check --adopt` records it, and counted in the Site Space. `PhisCdnAdoptResultV1`.
 */
export async function POST(request: NextRequest) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const body = await readJsonObjectBody(request);
  const keys = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > PHIS_CDN_ADOPT_KEYS_MAX
    || keys.some((key) => typeof key !== "string" || key.length === 0 || key.length > 620)) {
    return nextCdnError("invalid_body", `keys must be 1 to ${PHIS_CDN_ADOPT_KEYS_MAX} keys.`, 400);
  }
  try {
    await readPhisCdnSiteLimits(admin.value.target.siteId);
    const result = await adoptPhisCdnObjects(getPool(), admin.value.target, [...new Set(keys as string[])]);
    return NextResponse.json(result satisfies PhisCdnAdoptResultV1);
  } catch (error) {
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  }
}
