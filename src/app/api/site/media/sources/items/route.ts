import { NextRequest, NextResponse } from "next/server";

import { normalizePhiMediaKind } from "@/lib/constants/media";
import { requireMediaManagementSiteContext } from "@/lib/guards/site-media-api";
import { normalizeString, parsePositiveInt } from "@/lib/helpers/request";
import { resolveSiteReadLocale } from "@/lib/locale";
import { listMediaSourcePage, MediaSourceError } from "@/lib/media-sources";

export const dynamic = "force-dynamic";

/** What a page asks for when the request names no limit. */
const DEFAULT_LIMIT = 30;

/**
 * One page of one media source: `?source=&q=&kind=&cursor=&limit=&locale=`.
 *
 * `{ items, nextCursor }`, as the implementation answered it and Core checked it. The locale is the
 * request's own (query, `x-locale`, then the browser's), else the Site's default.
 */
export async function GET(request: NextRequest) {
  const { site, error } = await requireMediaManagementSiteContext(request);
  if (error) {
    return error;
  }

  const params = request.nextUrl.searchParams;
  const source = normalizeString(params.get("source"));
  if (!source) {
    return NextResponse.json({ error: "invalid_request", message: "A listing needs a source." }, { status: 400 });
  }
  const kinds = [...new Set(params.getAll("kind")
    .map((kind) => kind.trim())
    .filter(Boolean)
    .map(normalizePhiMediaKind))];

  try {
    const page = await listMediaSourcePage({
      site: { id: site.id, key: site.key },
      source,
      query: params.get("q"),
      kinds,
      cursor: params.get("cursor"),
      limit: parsePositiveInt(params.get("limit")) ?? DEFAULT_LIMIT,
      locale: resolveSiteReadLocale(request) ?? site.defaultLocale,
    });
    return NextResponse.json({ items: page.items, nextCursor: page.nextCursor });
  } catch (cause) {
    if (cause instanceof MediaSourceError) {
      return NextResponse.json({ error: cause.code, message: cause.message }, { status: cause.status });
    }
    throw cause;
  }
}
