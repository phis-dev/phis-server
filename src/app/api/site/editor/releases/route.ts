import { NextRequest, NextResponse } from "next/server";

import { listSiteReleases } from "@/db/site-releases";
import { requireSiteReviewApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

/*
 * What waits for a Publisher (CONTENT.md, Submission): submitted Widget content, submitted entries, and the
 * Working Drafts of Pages and Areas. Readable by everybody who reads drafts -- an Author sees what they
 * submitted waiting -- and acted on through the publish endpoints, which are the Publisher's.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteReviewApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  return NextResponse.json({ items: await listSiteReleases(site.id) });
}
