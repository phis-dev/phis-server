import { NextRequest, NextResponse } from "next/server";

import { logPhisCdnAdminEvent, readPhisCdnRouteKey, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PhisCdnUnknownFileError, withdrawPhisCdnFile } from "@/lib/cdn-catalogue.mts";
import { presentPhisCdnAdminFile } from "@/lib/cdn-core";
import { nextCdnError, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ name: string; version: string; file: string }> };

/**
 * Withdraws the file and deletes it: a copy's bytes leave the bucket and the Site Space, a link keeps its
 * entry and moves no bytes. The key stays taken, and a cache in front of the CDN may serve a copy until
 * it expires. `{ file }`.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const key = await readPhisCdnRouteKey(params);
  if (!key) return nextCdnError("unknown_file", "There is no such file.", 404);
  try {
    const outcome = await withdrawPhisCdnFile(getPool(), admin.value.target, key, { remove: true });
    if (outcome.deleted) logPhisCdnAdminEvent("cdn.deleted", admin.value, request, { key });
    return NextResponse.json({ file: presentPhisCdnAdminFile(outcome.row, admin.value.target.cdn.publicBaseUrl) });
  } catch (error) {
    if (error instanceof PhisCdnUnknownFileError) return nextCdnError("unknown_file", error.message, 404);
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  }
}
