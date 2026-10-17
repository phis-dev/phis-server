import { NextResponse } from "next/server";

import { isSiteContentEntryKind, type SiteContentEntryKind } from "@/db/site-content-entries";

/** The route context of every `/entries/[kind]` handler. */
export type EntryRouteContext = { params: Promise<{ kind: string }> };

/** The content type the address names (CONTENT.md), or the answer that it names none. */
export async function readEntryKind(
  params: Promise<{ kind: string }>,
): Promise<{ kind: SiteContentEntryKind } | { error: NextResponse }> {
  const { kind } = await params;
  return isSiteContentEntryKind(kind)
    ? { kind }
    : { error: NextResponse.json({ error: "No such content type." }, { status: 404 }) };
}
