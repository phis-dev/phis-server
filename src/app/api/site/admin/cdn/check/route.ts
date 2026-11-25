import { NextRequest, NextResponse } from "next/server";

import { requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { checkPhisCdnBucket } from "@/lib/cdn-catalogue.mts";
import { nextCdnError, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/** How long a check may list the bucket before it is answered `504 check_timeout`. */
const CHECK_TIMEOUT_MS = 60_000;

/**
 * The bucket against the catalogue's copies (`PhisCdnCheckReportV1`): what lies there unrecorded and
 * whether it can be adopted, what is offered and gone, and sizes that disagree. Links are not checked.
 */
export async function POST(request: NextRequest) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  let timer: NodeJS.Timeout | undefined;
  try {
    const report = await Promise.race([
      checkPhisCdnBucket(getPool(), admin.value.target),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CHECK_TIMEOUT_MS); }),
    ]);
    if (!report) return nextCdnError("check_timeout", "The bucket took too long to list; run phis cdn check instead.", 504);
    return NextResponse.json(report);
  } catch (error) {
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
