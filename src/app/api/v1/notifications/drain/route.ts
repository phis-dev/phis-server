import { NextResponse, type NextRequest } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { drainPhiNotifications } from "@/lib/notifications/deliver";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Sending what is still owed, for the operator's scheduler.
 *
 * It runs inside the serving process because that is where the mail configuration, the translation cache
 * and the transport are -- the same reason `phis addon job` posts here rather than doing the work in the
 * CLI. It deliberately is not a `phis maintain` task: that runs in the CLI process against its own pool
 * and its own `.mts` modules, and reaching the renderer from there would mean a second copy of it.
 *
 * Internal token only. Nobody is waiting on this call: the request that wrote a row already tried it once,
 * so what is left here is the retry, which is late by definition.
 */
export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const body = await request.json().catch(() => null) as { limit?: unknown } | null;
  const requestedLimit = typeof body?.limit === "number" ? Math.trunc(body.limit) : 100;
  const limit = Math.min(1000, Math.max(1, requestedLimit));

  const outcome = await drainPhiNotifications(limit);

  logRuntimeEvent(outcome.failed > 0 ? "warn" : "info", "mail.drained", {
    message: "Notification outbox drained.",
    meta: outcome,
  });

  return NextResponse.json({ ok: true, ...outcome });
}
