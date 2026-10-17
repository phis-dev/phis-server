import { NextRequest, NextResponse } from "next/server";

import { SITE_CONTENT_ENTRY_KINDS } from "@/db/site-content-entries";
import { deleteSiteContentCategory, updateSiteContentCategory } from "@/db/site-content-terms";
import { readEntryKind } from "@/lib/site-content-entry-route";
import { readSiteContentCategoryBody } from "@/lib/site-content-category-body";
import { requireSitePublisherApiContext } from "@/lib/guards/site-admin-api";
import { parsePositiveIntWithFallback, readRequestBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

type CategoryRouteContext = { params: Promise<{ kind: string; id: string }> };

/*
 * One category of a content type: renamed, readdressed and moved with `PATCH`, removed with `DELETE`.
 * Both the Publisher's (see `../route.ts`). Removing a category files its entries under none; it never
 * touches an entry's words.
 */

async function readCategoryRoute(request: NextRequest, params: CategoryRouteContext["params"]) {
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
  const id = parsePositiveIntWithFallback((await params).id, 0);
  if (id <= 0) {
    return { error: NextResponse.json({ error: "A valid category id is required." }, { status: 400 }) };
  }
  return { kind: entryKind.kind, site, id, userId: context.session?.userId ?? null };
}

export async function PATCH(request: NextRequest, { params }: CategoryRouteContext) {
  const route = await readCategoryRoute(request, params);
  if ("error" in route) {
    return route.error;
  }
  const parsed = readSiteContentCategoryBody(await readRequestBody(request));
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const updated = await updateSiteContentCategory({
    siteId: route.site.id,
    type: SITE_CONTENT_ENTRY_KINDS[route.kind].type,
    id: route.id,
    ...parsed.input,
  });
  if (updated === "missing") {
    return NextResponse.json({ error: "No such category." }, { status: 404 });
  }
  if (updated === "slug_taken") {
    return NextResponse.json({ error: "A category with that address already exists.", code: "slug_taken" }, { status: 409 });
  }
  logRuntimeEvent("info", "site.editor.entry.category.updated", {
    area: "editor",
    message: "Content category updated.",
    siteKey: route.site.key,
    userId: route.userId,
    meta: { kind: route.kind, categoryId: updated.id, slug: updated.slug },
  });
  return NextResponse.json(updated);
}

export async function DELETE(request: NextRequest, { params }: CategoryRouteContext) {
  const route = await readCategoryRoute(request, params);
  if ("error" in route) {
    return route.error;
  }
  const deleted = await deleteSiteContentCategory({
    siteId: route.site.id,
    type: SITE_CONTENT_ENTRY_KINDS[route.kind].type,
    id: route.id,
  });
  if (!deleted) {
    return NextResponse.json({ error: "No such category." }, { status: 404 });
  }
  logRuntimeEvent("info", "site.editor.entry.category.deleted", {
    area: "editor",
    message: "Content category deleted.",
    siteKey: route.site.key,
    userId: route.userId,
    meta: { kind: route.kind, categoryId: route.id },
  });
  return NextResponse.json({ deletedCount: 1 });
}
