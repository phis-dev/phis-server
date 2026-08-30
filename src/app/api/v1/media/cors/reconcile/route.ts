import { NextResponse, type NextRequest } from "next/server";

import { guardApiV1 } from "@/lib/api-v1-guard";
import { logRuntimeEvent } from "@/lib/log";
import { reconcilePhiMediaStorageCors } from "@/lib/media-storage-cors";

/**
 * Writes every storage's CORS rule from the Site registry.
 *
 * It lives here rather than in `phis-cli` because a storage adapter is Core's machinery: the CLI runs
 * as plain Node with neither the application's path aliases nor its server conditions, and giving it
 * a second way to build a Provider would be a second implementation to keep in step. Installation is
 * the CLI's; runtime state derived from runtime data is the Server's.
 *
 * Operator-facing, internal token only. There is no Site-scoped variant: a rule covers every Site a
 * storage serves, so a single Site could otherwise withdraw another's permission by reconciling.
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guardError = guardApiV1(request, { requireInternalToken: true });
  if (guardError) {
    return guardError;
  }

  const groups = await reconcilePhiMediaStorageCors();
  const failed = groups.filter((group) => !group.applied);

  logRuntimeEvent(failed.length > 0 ? "error" : "info", "media.cors.reconciled", {
    message: `Reconciled CORS for ${groups.length} storage(s), ${failed.length} failed.`,
    method: request.method,
    path: request.nextUrl.pathname,
    meta: {
      storages: groups.map((group) => ({
        identity: group.identity,
        origins: group.origins,
        sites: group.profiles.map((profile) => profile.siteKey),
        applied: group.applied,
        error: group.error,
      })),
    },
  });

  return NextResponse.json({ ok: failed.length === 0, storages: groups }, {
    status: failed.length > 0 ? 502 : 200,
  });
}
