import { NextRequest, NextResponse } from "next/server";

import { SITE_CONTENT_ENTRY_KINDS } from "@/db/site-content-entries";
import { createSiteContentCategory, listSiteContentCategories } from "@/db/site-content-terms";
import { readEntryKind, type EntryRouteContext } from "@/lib/site-content-entry-route";
import { readSiteContentCategoryBody } from "@/lib/site-content-category-body";
import { requireSiteAuthorApiContext, requireSitePublisherApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * A content type's categories (CONTENT.md, Terms), under its kind: `/api/site/editor/entries/blog/categories`.
 *
 * Kept as their own list rather than made up while writing, the way tags are: a category is the Site's
 * order, and an order every writer extends by typing is no order. Changing the list is the Publisher's,
 * like filing an entry under one; reading it is open to whoever writes entries.
 */

export async function GET(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const categories = await listSiteContentCategories(site.id, SITE_CONTENT_ENTRY_KINDS[entryKind.kind].type);
  return NextResponse.json({ categories, total: categories.length });
}

export async function POST(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { kind } = entryKind;
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }
  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const parsed = readSiteContentCategoryBody(await readRequestBody(request));
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const created = await createSiteContentCategory({
    siteId: site.id,
    type: SITE_CONTENT_ENTRY_KINDS[kind].type,
    ...parsed.input,
  });
  if (created === "slug_taken") {
    return NextResponse.json({ error: "A category with that address already exists.", code: "slug_taken" }, { status: 409 });
  }

  logRuntimeEvent("info", "site.editor.entry.category.created", {
    area: "editor",
    message: "Content category created.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { kind, categoryId: created.id, slug: created.slug },
  });
  return NextResponse.json(created);
}
