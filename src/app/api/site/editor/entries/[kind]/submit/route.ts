import { NextRequest, NextResponse } from "next/server";

import { submitSiteContentEntry, withdrawSiteContentEntrySubmission } from "@/db/site-content-entries";
import { requireSiteAuthorApiContext } from "@/lib/guards/site-admin-api";
import { normalizeNullableInteger, parsePositiveIntWithFallback, readRequestBody } from "@/lib/helpers/request";
import { readEntryKind, type EntryRouteContext } from "@/lib/site-content-entry-route";

export const dynamic = "force-dynamic";

/*
 * Putting an entry forward for publication (CONTENT.md, Submission), which is the Author's: `POST` names
 * the current version, `DELETE` takes the submission back. Neither publishes anything.
 */

export async function POST(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }
  const body = await readRequestBody(request);
  const contentId = normalizeNullableInteger(body.contentId);
  const versionId = normalizeNullableInteger(body.versionId);
  if (contentId === null || contentId <= 0 || versionId === null || versionId <= 0) {
    return NextResponse.json({ error: "contentId and versionId are required." }, { status: 400 });
  }
  const outcome = await submitSiteContentEntry({ kind: entryKind.kind, siteId: context!.site!.id, contentId, versionId });
  if (outcome === "missing") {
    return NextResponse.json({ error: "Entry not found." }, { status: 404 });
  }
  if (outcome === "version_mismatch") {
    return NextResponse.json(
      { error: "Only the current version can be submitted.", code: "version_mismatch" },
      { status: 409 },
    );
  }
  return NextResponse.json({ submitted: true, contentId, versionId });
}

export async function DELETE(request: NextRequest, { params }: EntryRouteContext) {
  const entryKind = await readEntryKind(params);
  if ("error" in entryKind) {
    return entryKind.error;
  }
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }
  const contentId = parsePositiveIntWithFallback(new URL(request.url).searchParams.get("contentId"), 0);
  if (contentId <= 0) {
    return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
  }
  return (await withdrawSiteContentEntrySubmission({ kind: entryKind.kind, siteId: context!.site!.id, contentId }))
    ? NextResponse.json({ withdrawn: true })
    : NextResponse.json({ error: "Entry not found." }, { status: 404 });
}
