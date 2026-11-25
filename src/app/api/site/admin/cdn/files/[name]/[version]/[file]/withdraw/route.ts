import { NextRequest, NextResponse } from "next/server";

import type { PhisCdnAdminWithdrawResultV1 } from "@phis/contracts/addon";

import { logPhisCdnAdminEvent, readPhisCdnRouteKey, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PhisCdnUnknownFileError, withdrawPhisCdnFile } from "@/lib/cdn-catalogue.mts";
import { presentPhisCdnAdminFile } from "@/lib/cdn-core";
import { nextCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Takes the file -- a copy or a link -- out of the offer; its key stays taken and a copy's bytes stay in
 * the bucket. `PhisCdnAdminWithdrawResultV1`, with `AlreadyWithdrawn` where nothing changed.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ name: string; version: string; file: string }> }) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const key = await readPhisCdnRouteKey(params);
  if (!key) return nextCdnError("unknown_file", "There is no such file.", 404);
  try {
    const outcome = await withdrawPhisCdnFile(getPool(), admin.value.target, key, { remove: false });
    if (outcome.flags === 0) logPhisCdnAdminEvent("cdn.withdrawn", admin.value, request, { key });
    return NextResponse.json({
      file: presentPhisCdnAdminFile(outcome.row, admin.value.target.cdn.publicBaseUrl),
      flags: outcome.flags,
    } satisfies PhisCdnAdminWithdrawResultV1);
  } catch (error) {
    if (error instanceof PhisCdnUnknownFileError) return nextCdnError("unknown_file", error.message, 404);
    throw error;
  }
}
