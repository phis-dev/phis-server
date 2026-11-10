import { NextResponse, type NextRequest } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { getPhiCliSiteByKey } from "@/db/cli-sites.mts";
import { getPool } from "@/lib/db";
import { PhisAddonJobError } from "@/lib/addons/jobs";
import { PHI_CORE_JOB_OWNER } from "@/lib/constants/jobs";
import { runPhiJobNow } from "@/lib/jobs/scheduler";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Starting one declared job now, out of turn.
 *
 * A job runs inside the serving process because that is where its Add-on is loaded, against the release
 * the instance is actually serving. `phis-cli` posts here rather than loading the artifact itself,
 * which also means the CLI never has to become a second runtime. The run goes through the scheduler's
 * ledger like a scheduled one, so it shows there and cannot run beside the clock's run of the same job.
 * `addonId` may be `@phis/server` for one of Core's own jobs, which take no Site.
 *
 * Internal token only, and no Site session: this is not something a person reaches. A job acts as the
 * Add-on with no actor behind it, so the scheduler and an operator are the only things that should be
 * able to start one -- an Add-on able to trigger its own job from a request would have built a way
 * around the row-level ladder.
 */
export async function POST(request: NextRequest) {
  const guardError = await guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const body = await request.json().catch(() => null) as {
    addonId?: unknown;
    jobId?: unknown;
    siteKey?: unknown;
  } | null;
  if (typeof body?.addonId !== "string" || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "addonId and jobId are required." }, { status: 400 });
  }
  const coreJob = body.addonId === PHI_CORE_JOB_OWNER;
  if (!coreJob && typeof body.siteKey !== "string") {
    return NextResponse.json({ error: "siteKey is required for an Add-on job." }, { status: 400 });
  }

  let site: { id: number; key: string } | null = null;
  if (typeof body.siteKey === "string") {
    const found = await getPhiCliSiteByKey(getPool(), body.siteKey.trim().toLowerCase());
    if (!found) {
      return NextResponse.json({ error: "site_not_found" }, { status: 404 });
    }
    site = { id: found.id, key: found.key };
  }

  try {
    const outcome = await runPhiJobNow({ owner: body.addonId, jobId: body.jobId, siteId: site?.id ?? null });
    const answer = {
      addonId: body.addonId,
      jobId: body.jobId,
      siteKey: site?.key ?? null,
      runId: outcome.runId,
      ok: outcome.ok,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
    if (!outcome.ok) {
      logRuntimeEvent("error", "addon.job.failed", {
        message: outcome.error ?? undefined,
        siteKey: site?.key,
        pluginKey: body.addonId,
        meta: { jobId: body.jobId, runId: outcome.runId },
      });
    } else {
      logRuntimeEvent("info", "addon.job.ran", {
        siteKey: site?.key,
        pluginKey: body.addonId,
        meta: { jobId: body.jobId, runId: outcome.runId },
      });
    }
    return NextResponse.json(answer, { status: outcome.ok ? 200 : 500 });
  } catch (error) {
    // A refused job -- not installed, not enabled, not declared, paused -- is the caller's mistake and
    // is reported as one, distinct from a job that ran and threw.
    if (error instanceof PhisAddonJobError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
