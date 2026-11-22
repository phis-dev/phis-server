import type { NextRequest } from "next/server";

import { requireSiteAccountingApiContext } from "@/lib/guards/site-admin-api";
import { answerSiteProductDirectory } from "@/lib/site-product-directory";

export const dynamic = "force-dynamic";

/**
 * The Site's product directory, a page at a time: `supplier` (an Add-on id), `state` (a comma-separated list
 * of draft, active, withdrawn, locked; absent: every state), `pendingTerms` (true: only products waiting for
 * the operator's release, false: only those that are not), `q` (a part of the title or the id), `page` and
 * `pageSize`. Answers `{ rows, total, page, pageSize }`, each row the product's id, supplier, publisher,
 * title, summary, type, state, sale, referralUrl, free, accountRequired, counted, parts, released,
 * pendingTerms, imagePath, iconPath, imageListPath, iconListPath and version. imageListPath and iconListPath
 * are the picture's and the icon's `icon` variant (64 x 64, fitted whole on a transparent ground) for a list
 * that shows them small, with the delivery revision and the variant version, null without one or for an
 * Asset that is no image.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAccountingApiContext(request);
  if (error) return error;
  return answerSiteProductDirectory(request, context);
}
