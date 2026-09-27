/**
 * Gives Assets stored before this a digest duplicate detection can compare.
 *
 * Every Asset delivered straight to a storage before Core asked the Client for a digest carries an `md5` off a
 * single-request ETag, or nothing -- and neither is ever compared, so those Assets sit outside duplicate
 * detection permanently. Only their bytes can fix that, and reading them is exactly the cost the Client-side
 * digest exists to avoid. So it is an operator's decision, once, and never something an upload does on the way
 * past.
 *
 * It lives here rather than in `phis-cli` for the reason the storage policy route gives: a storage adapter is
 * Core's machinery, and the CLI runs as plain Node with neither the application's path aliases nor its server
 * conditions. Core's own Local adapter cannot be loaded there at all, and that is where most Assets are.
 *
 * Bounded by `limit`, because each Asset is a whole object read back from storage. The answer says how many
 * are left, so an operator knows whether to run it again rather than guessing.
 *
 * Operator-facing, internal token only, and Site-scoped: an Asset belongs to a Site, and the work is charged
 * to whoever asked for it.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getSiteByKey } from "@/db/sites";
import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { recomputePhiMediaAssetChecksums } from "@/lib/media-checksum-recompute";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;

export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const siteKey = request.nextUrl.searchParams.get("site")?.trim() ?? "";
  if (!siteKey) {
    return NextResponse.json({ ok: false, error: "missing_site" }, { status: 400 });
  }
  const site = await getSiteByKey(siteKey);
  if (!site) {
    return NextResponse.json({ ok: false, error: "site_not_found" }, { status: 404 });
  }

  const requested = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT;

  const report = await recomputePhiMediaAssetChecksums({
    siteId: site.id,
    siteKey: site.key,
    limit,
  });

  /*
   * Logged at `warn` where something was found that an operator has to decide about. A duplicate is not a
   * failure of this command -- it is the corpus telling the truth for the first time -- but it is also not
   * something to leave in a response body nobody keeps.
   */
  const notable = report.duplicates.length > 0 || report.incomparable > 0 || report.unreadable > 0;
  logRuntimeEvent(notable ? "warn" : "info", "media.checksum.recomputed", {
    message:
      `Recorded ${report.recorded} of ${report.examined} digest(s) for ${site.key}, ${report.remaining} left.`,
    siteKey: site.key,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: {
      examined: report.examined,
      recorded: report.recorded,
      incomparable: report.incomparable,
      unreadable: report.unreadable,
      duplicates: report.duplicates.length,
      remaining: report.remaining,
    },
  });

  return NextResponse.json({ ok: true, site: site.key, ...report }, {
    headers: { "cache-control": "no-store" },
  });
}
