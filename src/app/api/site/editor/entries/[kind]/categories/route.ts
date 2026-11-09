import { NextRequest, NextResponse } from "next/server";

import { SITE_CONTENT_ENTRY_KINDS, type SiteContentEntryKind } from "@/db/site-content-entries";
import {
  createSiteContentCategory,
  deleteSiteContentCategory,
  listSiteContentCategories,
  updateSiteContentCategory,
} from "@/db/site-content-terms";
import { readEntryKind, type EntryRouteContext } from "@/lib/site-content-entry-route";
import { readSiteContentCategoryBody } from "@/lib/site-content-category-body";
import { requireSiteAuthorApiContext, requireSitePublisherApiContext } from "@/lib/guards/site-admin-api";
import { normalizeNullableInteger, parsePositiveIntWithFallback, readRequestBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * A content type's categories (CONTENT.md, Terms), under its kind: `/api/site/editor/entries/blog/categories`.
 *
 * Kept as their own list rather than made up while writing, the way tags are: a category is the Site's
 * order, and an order every writer extends by typing is no order. Changing the list is the Publisher's,
 * like filing an entry under one; reading it is open to whoever writes entries.
 *
 * Shaped like the entries route beside it: one `PUT` states a category whole -- with an `id` it is that
 * category, without one a new one -- and `DELETE ?id=` removes one. That is what lets one Form write both,
 * through a relay whose address is fixed.
 */

type PublisherRoute =
  | { error: NextResponse }
  | { kind: SiteContentEntryKind; site: { id: number; key: string }; userId: number | null };

async function readPublisherRoute(request: NextRequest, params: EntryRouteContext["params"]): Promise<PublisherRoute> {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return { error: entryKind.error };
  }
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return { error };
  }
  const site = context?.site;
  if (!site) {
    return { error: NextResponse.json({ error: "Authentication required." }, { status: 401 }) };
  }
  return { kind: entryKind.kind, site, userId: context.session?.userId ?? null };
}

export async function GET(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const categories = await listSiteContentCategories(site.id, SITE_CONTENT_ENTRY_KINDS[entryKind.kind].type);
  return NextResponse.json({ categories, total: categories.length });
}

export async function PUT(request: NextRequest, { params }: EntryRouteContext) {
  const route = await readPublisherRoute(request, params);
  if ("error" in route) {
    return route.error;
  }
  const body = await readRequestBody(request);
  const parsed = readSiteContentCategoryBody(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  // A Form's hidden field sends an empty string for a new category, which is no id; anything else must be one.
  const namesId = body.id != null && String(body.id).trim() !== "";
  const id = namesId ? normalizeNullableInteger(body.id) : null;
  if (namesId && (id === null || id <= 0)) {
    return NextResponse.json({ error: "id must name a category, or be left out for a new one." }, { status: 400 });
  }
  const type = SITE_CONTENT_ENTRY_KINDS[route.kind].type;
  const saved = id === null
    ? await createSiteContentCategory({ siteId: route.site.id, type, ...parsed.input })
    : await updateSiteContentCategory({ siteId: route.site.id, type, id, ...parsed.input });
  if (saved === "missing") {
    return NextResponse.json({ error: "No such category." }, { status: 404 });
  }
  if (saved === "slug_taken") {
    return NextResponse.json({ error: "A category with that address already exists.", code: "slug_taken" }, { status: 409 });
  }

  logRuntimeEvent("info", id === null ? "site.editor.entry.category.created" : "site.editor.entry.category.updated", {
    area: "editor",
    message: id === null ? "Content category created." : "Content category updated.",
    siteKey: route.site.key,
    userId: route.userId,
    meta: { kind: route.kind, categoryId: saved.id, slug: saved.slug },
  });
  return NextResponse.json(saved);
}

export async function DELETE(request: NextRequest, { params }: EntryRouteContext) {
  const route = await readPublisherRoute(request, params);
  if ("error" in route) {
    return route.error;
  }
  const id = parsePositiveIntWithFallback(request.nextUrl.searchParams.get("id"), 0);
  if (id <= 0) {
    return NextResponse.json({ error: "A valid category id is required." }, { status: 400 });
  }
  // Removing a category files its entries under none; it never touches an entry's words.
  const deleted = await deleteSiteContentCategory({
    siteId: route.site.id,
    type: SITE_CONTENT_ENTRY_KINDS[route.kind].type,
    id,
  });
  if (!deleted) {
    return NextResponse.json({ error: "No such category." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.editor.entry.category.deleted", {
    area: "editor",
    message: "Content category deleted.",
    siteKey: route.site.key,
    userId: route.userId,
    meta: { kind: route.kind, categoryId: id },
  });
  return NextResponse.json({ deletedCount: 1 });
}
