import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import {
  isSiteContentEntryKind,
  listPublishedSiteContentEntries,
  type SiteContentEntryCategoryFilter,
} from "@/db/site-content-entries";
import { resolveRequestLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  serializePublishedSiteContentEntry,
  SITE_CONTENT_ENTRY_CACHE_CONTROL,
  translatePublishedSiteContentEntries,
} from "@/lib/site-content-entry-reader";

/*
 * The published entries of one content type (CONTENT.md), translated for the reader's language. Every
 * content type answers here, under its own kind: `/api/v1/entries/news`. One entry by its address, with
 * the entries related to it, is `/api/v1/entries/<kind>/<slug>`.
 */

function readCategoryFilter(value: string): SiteContentEntryCategoryFilter | null {
  const filter: SiteContentEntryCategoryFilter = { categoryIds: [], uncategorized: false };
  for (const part of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (part === "none") {
      filter.uncategorized = true;
    } else if (/^[1-9][0-9]{0,9}$/u.test(part) && Number(part) <= 2_147_483_647) {
      filter.categoryIds.push(Number(part));
    } else {
      return null;
    }
  }
  return filter;
}

export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const guardError = await guardApiV1(request);
  if (guardError) {
    return guardError;
  }
  const { kind } = await params;
  if (!isSiteContentEntryKind(kind)) {
    return NextResponse.json({ error: "No such content type." }, { status: 404 });
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Site not found." }, { status: 404 });
  }

  const locale = resolveRequestLocale(request.headers);
  /*
   * How many the caller will show. Optional for a caller that wants the list, refused when it is not a
   * count: a `limit` that silently meant "all" would let a typo re-translate the whole history.
   */
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    return NextResponse.json({ error: "limit must be a positive integer." }, { status: 400 });
  }
  /*
   * Which categories, by id: `categories=3,7` for the entries filed under either, `none` among them for
   * those filed under no category. Absent is every entry. Anything else in the list is refused rather
   * than dropped -- a list that quietly lost its filter would show what it was set not to.
   */
  const rawCategories = new URL(request.url).searchParams.get("categories");
  const categories = rawCategories === null ? undefined : readCategoryFilter(rawCategories);
  if (categories === null) {
    return NextResponse.json({ error: "categories must be category ids or none, comma-separated." }, { status: 400 });
  }
  const entries = await listPublishedSiteContentEntries(kind, site.id, locale, {
    ...(limit === undefined ? {} : { limit }),
    ...(categories ? { categories } : {}),
  });
  const { provisional } = await translatePublishedSiteContentEntries({ kind, site, locale, entries });

  const items = entries.map(serializePublishedSiteContentEntry);
  const version = items[0]?.created?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);

  return createJsonResponse(
    request,
    {
      version,
      site: site.key,
      locale,
      kind,
      entries: items,
      // `provisional`: at least one answer is source text standing in for a failure; do not keep it.
      ...(provisional ? { provisional: true } : {}),
    },
    { cacheControl: provisional ? "no-store" : SITE_CONTENT_ENTRY_CACHE_CONTROL },
  );
}
