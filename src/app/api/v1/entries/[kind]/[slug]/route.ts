import { NextResponse } from "next/server";
import { createJsonResponse } from "@/lib/api-response";
import { guardApiV1 } from "@/lib/api-v1-guard";
import {
  isSiteContentEntryKind,
  listRelatedSiteContentEntries,
  readPublishedSiteContentEntry,
} from "@/db/site-content-entries";
import { resolveRequestLocale } from "@/lib/locale";
import { requireSiteFromRequest } from "@/lib/site-context";
import {
  serializePublishedSiteContentEntry,
  SITE_CONTENT_ENTRY_CACHE_CONTROL,
  translatePublishedSiteContentEntries,
} from "@/lib/site-content-entry-reader";

/** As many relatives as a page shows under an entry; more is a list Page of its own. */
const DEFAULT_RELATED_LIMIT = 3;
const MAX_RELATED_LIMIT = 12;

/*
 * One published entry by its address, for a detail Page, and what goes with it (CONTENT.md).
 *
 * Everything a detail Page shows in one answer: the entry with its author and terms, and -- asked for with
 * `include=related` -- the entries closest to it. One question rather than three, because the Page's
 * parts would otherwise each ask for the same entry, and the relatives are translated with it in the same
 * provider requests. `404` where nothing published answers at the address: never written, not yet due,
 * expired, or withdrawn.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string; slug: string }> }) {
  const guardError = guardApiV1(request);
  if (guardError) {
    return guardError;
  }
  const { kind, slug: rawSlug } = await params;
  if (!isSiteContentEntryKind(kind)) {
    return NextResponse.json({ error: "No such content type." }, { status: 404 });
  }

  const site = await requireSiteFromRequest(request);
  if (!site) {
    return NextResponse.json({ error: "Missing site context." }, { status: 400 });
  }

  const searchParams = new URL(request.url).searchParams;
  const include = new Set((searchParams.get("include") ?? "").split(",").map((part) => part.trim()).filter(Boolean));
  const unknown = [...include].filter((part) => part !== "related");
  if (unknown.length > 0) {
    return NextResponse.json({ error: `include names nothing this answers: ${unknown.join(", ")}.` }, { status: 400 });
  }
  const rawRelatedLimit = searchParams.get("relatedLimit");
  const relatedLimit = rawRelatedLimit === null ? DEFAULT_RELATED_LIMIT : Number(rawRelatedLimit);
  if (!Number.isInteger(relatedLimit) || relatedLimit <= 0 || relatedLimit > MAX_RELATED_LIMIT) {
    return NextResponse.json(
      { error: `relatedLimit must be a whole number from 1 to ${MAX_RELATED_LIMIT}.` },
      { status: 400 },
    );
  }

  const locale = resolveRequestLocale(request.headers);
  const slug = decodeURIComponent(rawSlug).trim();
  const entry = slug ? await readPublishedSiteContentEntry(kind, site.id, locale, slug) : null;
  if (!entry) {
    return NextResponse.json({ error: "No published entry at this address." }, { status: 404 });
  }
  const related = include.has("related")
    ? await listRelatedSiteContentEntries(kind, site.id, locale, { contentId: entry.contentId, limit: relatedLimit })
    : null;

  // The entry and its relatives in one pass, so a language costs one provider request per context.
  const { provisional } = await translatePublishedSiteContentEntries({
    kind,
    site,
    locale,
    entries: [entry, ...(related ?? [])],
  });

  return createJsonResponse(
    request,
    {
      version: entry.created.slice(0, 10),
      site: site.key,
      locale,
      kind,
      entry: serializePublishedSiteContentEntry(entry),
      ...(related ? { related: related.map(serializePublishedSiteContentEntry) } : {}),
      ...(provisional ? { provisional: true } : {}),
    },
    { cacheControl: provisional ? "no-store" : SITE_CONTENT_ENTRY_CACHE_CONTROL },
  );
}
