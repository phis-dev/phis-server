import { NextRequest, NextResponse } from "next/server";

import { publishSiteContentNews, withdrawSiteContentNews } from "@/db/site-content";
import { requireSitePublisherApiContext } from "@/lib/guards/site-admin-api";
import {
  normalizeNullableInteger,
  normalizeString,
  parsePositiveIntWithFallback,
  readRequestBody,
} from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * When a News entry is seen, which is the publishing half of `design/NEWS.md`.
 *
 * `POST` states the terms -- from when, and until when -- and points the publication at the draft the
 * author last saved. `DELETE` takes the publication back and leaves the words alone. Both are behind
 * `requireSitePublisherApiContext`, and nothing here writes a single word of content.
 *
 * Neither date needs anything to run at the appointed minute: the public read filters
 * `published_at <= NOW()` and `expires_at > NOW()` in the query, so a schedule is a column and an expiry
 * is the absence of a row in the next answer. A Public page that was already rendered carries an expired
 * entry until its `revalidate` window closes, which `design/NEWS.md` §2 states and accepts.
 */

function readPublicationDate(
  value: unknown,
  field: string,
): { date: Date | null } | { error: string } {
  const raw = normalizeString(value);
  if (!raw) {
    return { date: null };
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime())
    ? { error: `${field} must be an ISO date.` }
    : { date };
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const contentId = normalizeNullableInteger(body.contentId);
  if (contentId === null || contentId <= 0) {
    return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
  }

  const publishedAt = readPublicationDate(body.publishedAt, "publishedAt");
  if ("error" in publishedAt) {
    return NextResponse.json({ error: publishedAt.error }, { status: 400 });
  }
  const expiresAt = readPublicationDate(body.expiresAt, "expiresAt");
  if ("error" in expiresAt) {
    return NextResponse.json({ error: expiresAt.error }, { status: 400 });
  }

  /*
   * An entry that expires before it appears would be written, accepted and never answered. Refused rather
   * than stored, because the two dates are a statement about one publication and this one contradicts
   * itself. An entry that should be gone now is withdrawn, which is the other method here.
   */
  if (expiresAt.date) {
    const from = publishedAt.date ?? new Date();
    if (expiresAt.date.getTime() <= from.getTime()) {
      return NextResponse.json(
        { error: "expiresAt must be after publishedAt." },
        { status: 400 },
      );
    }
  }

  const publication = await publishSiteContentNews({
    siteId: site.id,
    contentId,
    publishedAt: publishedAt.date?.toISOString() ?? null,
    expiresAt: expiresAt.date?.toISOString() ?? null,
  });

  if (!publication) {
    return NextResponse.json(
      { error: "No such news entry, or it has no saved version to publish." },
      { status: 404 },
    );
  }

  logRuntimeEvent("info", "site.editor.news.published", {
    area: "editor",
    message: "News entry published.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: {
      contentId,
      publishedAt: publication.publishedAt,
      expiresAt: publication.expiresAt,
    },
  });

  return NextResponse.json(publication);
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireSitePublisherApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const contentId = parsePositiveIntWithFallback(searchParams.get("contentId"), 0);
  if (contentId <= 0) {
    return NextResponse.json({ error: "A valid contentId is required." }, { status: 400 });
  }

  const withdrawn = await withdrawSiteContentNews({ siteId: site.id, contentId });
  if (!withdrawn) {
    return NextResponse.json({ error: "News entry not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.editor.news.withdrawn", {
    area: "editor",
    message: "News entry withdrawn.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { contentId },
  });

  return NextResponse.json({ withdrawn: true });
}
