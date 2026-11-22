import type { NextRequest } from "next/server";

import { requireSiteAccountingApiContext } from "@/lib/guards/site-admin-api";
import { answerSiteProductCommand } from "@/lib/site-product-directory";

export const dynamic = "force-dynamic";

/**
 * Locks a product, the Site operator's alone: no entry for it counts while it is locked, as `phis product
 * lock` does. Answers `{ outcome, product }`, `product` in the shape of a `GET /api/site/products` row,
 * outcome `locked` or `unchanged`. The id is one path segment, percent-encoded (`@`, `/` and `:` are in
 * every id).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteAccountingApiContext(request);
  if (error) return error;
  return answerSiteProductCommand(request, context, (await params).id, "lock");
}
