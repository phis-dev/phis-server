import type { NextRequest } from "next/server";

import { requireSiteAccountingApiContext } from "@/lib/guards/site-admin-api";
import { answerSiteProductCommand } from "@/lib/site-product-directory";

export const dynamic = "force-dynamic";

/**
 * Releases a publisher's product, the first time or its pending terms, as `phis product release` does.
 * Answers `{ outcome, product }`, `product` in the shape of a `GET /api/site/products` row, outcome
 * `released`, `applied` or `unchanged`; `409` for the Site's own product, which needs no release. The id is
 * one path segment, percent-encoded (`@`, `/` and `:` are in every id).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { context, error } = await requireSiteAccountingApiContext(request);
  if (error) return error;
  return answerSiteProductCommand(request, context, (await params).id, "release");
}
