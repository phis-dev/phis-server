import { NextRequest, NextResponse } from "next/server";

import {
  curateSiteContentEntry,
  listSiteContentEntryAuthorCandidates,
  SITE_CONTENT_ENTRY_KINDS,
} from "@/db/site-content-entries";
import { listSiteContentCategories } from "@/db/site-content-terms";
import { readEntryKind, type EntryRouteContext } from "@/lib/site-content-entry-route";
import { requireSiteAuthorApiContext, requireSitePublisherApiContext } from "@/lib/guards/site-admin-api";
import { normalizeNullableInteger, normalizeString, readRequestBody } from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * Who an entry is attributed to and what it is filed under (CONTENT.md, Curation), under its kind:
 * `/api/site/editor/entries/blog/curation`.
 *
 * The Publisher's, like `publish`: a byline is a public statement about a person and a category is the
 * Site's order, neither is a word of the text. So the change is behind `requireSitePublisherApiContext`,
 * and a save -- the Author's act -- never carries either. The offer the choice is made from is readable
 * by whoever writes entries, so an Author sees what an entry is filed under even where they cannot change
 * it.
 */

/**
 * One of the two choices, read for a `PATCH`: absent is "leave it", empty or `null` is "none", a positive
 * whole number is the one named. A Form's select sends the id as a string and its empty choice as `""`.
 */
function readChoice(body: Record<string, unknown>, key: string): { value: number | null | undefined } | { error: string } {
  if (!Object.hasOwn(body, key)) {
    return { value: undefined };
  }
  const raw = body[key];
  if (raw === null || normalizeString(raw) === "") {
    return { value: null };
  }
  const id = normalizeNullableInteger(raw);
  return id !== null && id > 0 ? { value: id } : { error: `${key} must name one by its id, or be empty for none.` };
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

  const [authors, categories] = await Promise.all([
    listSiteContentEntryAuthorCandidates(site.id),
    listSiteContentCategories(site.id, SITE_CONTENT_ENTRY_KINDS[entryKind.kind].type),
  ]);
  return NextResponse.json({ authors, categories });
}

export async function PATCH(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { kind } = entryKind;
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }
  const site = context.site;

  const body = await readRequestBody(request);
  const contentId = normalizeNullableInteger(body.contentId);
  if (contentId === null || contentId <= 0) {
    return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
  }
  const author = readChoice(body, "authorUserId");
  if ("error" in author) {
    return NextResponse.json({ error: author.error }, { status: 400 });
  }
  const category = readChoice(body, "categoryId");
  if ("error" in category) {
    return NextResponse.json({ error: category.error }, { status: 400 });
  }
  if (author.value === undefined && category.value === undefined) {
    return NextResponse.json({ error: "Name an authorUserId, a categoryId, or both." }, { status: 400 });
  }

  const outcome = await curateSiteContentEntry({
    kind,
    siteId: site.id,
    contentId,
    authorUserId: author.value,
    categoryId: category.value,
  });
  if (outcome === "missing") {
    return NextResponse.json({ error: "No such entry." }, { status: 404 });
  }
  if (outcome === "author_not_eligible") {
    return NextResponse.json(
      { error: "That person may not write entries on this Site.", code: "author_not_eligible" },
      { status: 409 },
    );
  }
  if (outcome === "category_missing") {
    return NextResponse.json({ error: "No such category.", code: "category_missing" }, { status: 409 });
  }

  logRuntimeEvent("info", "site.editor.entry.curated", {
    area: "editor",
    message: "Content entry curated.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { kind, contentId, authorUserId: outcome.authorUserId, categoryId: outcome.categoryId },
  });
  return NextResponse.json(outcome);
}
