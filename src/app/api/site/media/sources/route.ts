import { NextRequest, NextResponse } from "next/server";

import { requireMediaManagementSiteContext } from "@/lib/guards/site-media-api";
import { listMediaSources } from "@/lib/media-sources";

export const dynamic = "force-dynamic";

/**
 * The media sources this Site is offered right now (design/MEDIA_SOURCES.md, section 4).
 *
 * Every source of every installed `media-source` implementation that resolves for the Site and answers
 * its probe as usable: `{ source: "<providerKey>#<key>", label }`. Empty where none is installed.
 * Behind the guard the Media listing uses.
 */
export async function GET(request: NextRequest) {
  const { site, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }
  return NextResponse.json({ rows: await listMediaSources({ id: site.id, key: site.key }) });
}
