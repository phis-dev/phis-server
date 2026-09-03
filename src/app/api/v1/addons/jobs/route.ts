import { NextResponse, type NextRequest } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { getPhiCliSiteByKey } from "@/db/cli-sites.mts";
import { getPool } from "@/lib/db";
import { PhisAddonJobError, runPhisAddonJob } from "@/lib/addons/jobs";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Starting one declared Add-on job.
 *
 * A job runs inside the serving process because that is where its Add-on is loaded, against the release
 * the instance is actually serving. `phis-cli` posts here rather than loading the artifact itself,
 * which also means the CLI never has to become a second runtime.
 *
 * Internal token only, and no Site session: this is not something a person reaches. A job acts as the
 * Add-on with no actor behind it, so an operator's scheduler is the only thing that should be able to
 * start one -- an Add-on able to trigger its own job from a request would have built a way around the
 * row-level ladder.
 */
export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const body = await request.json().catch(() => null) as {
    addonId?: unknown;
    jobId?: unknown;
    siteKey?: unknown;
  } | null;
  if (
    typeof body?.addonId !== "string" ||
    typeof body.jobId !== "string" ||
    typeof body.siteKey !== "string"
  ) {
    return NextResponse.json({ error: "addonId, jobId and siteKey are required." }, { status: 400 });
  }

  const site = await getPhiCliSiteByKey(getPool(), body.siteKey.trim().toLowerCase());
  if (!site) {
    return NextResponse.json({ error: "site_not_found" }, { status: 404 });
  }

  try {
    const outcome = await runPhisAddonJob({
      addonId: body.addonId,
      jobId: body.jobId,
      site: { id: site.id, key: site.key },
      signal: request.signal,
    });
    if (!outcome.ok) {
      logRuntimeEvent("error", "addon.job.failed", {
        message: outcome.error,
        siteKey: site.key,
        pluginKey: outcome.addonId,
        meta: { jobId: outcome.jobId, runId: outcome.runId },
      });
    } else {
      logRuntimeEvent("info", "addon.job.ran", {
        siteKey: site.key,
        pluginKey: outcome.addonId,
        meta: { jobId: outcome.jobId, runId: outcome.runId },
      });
    }
    return NextResponse.json(outcome, { status: outcome.ok ? 200 : 500 });
  } catch (error) {
    // A refused job -- not installed, not enabled, not declared -- is the caller's mistake and is
    // reported as one, distinct from a job that ran and threw.
    if (error instanceof PhisAddonJobError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
