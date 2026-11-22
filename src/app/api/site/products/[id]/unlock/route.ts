import type { NextRequest } from "next/server";

import { requireSiteAccountingApiContext } from "@/lib/guards/site-admin-api";
import { answerSiteProductCommand } from "@/lib/site-product-directory";

export const dynamic = "force-dynamic";

/**
 * Unlocks a locked product, which becomes `withdrawn` -- the state before the lock is not kept -- as `phis
 * product unlock` does. Answers `{ outcome, product }`, outcome `unlocked` or `unchanged`. The id is one
 * path segment, percent-encoded (`@`, `/` and `:` are in every id).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteAccountingApiContext(request);
  if (error) return error;
  return answerSiteProductCommand(request, context, (await params).id, "unlock");
}
