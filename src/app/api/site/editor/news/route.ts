import { NextRequest, NextResponse } from "next/server";

import {
  deleteSiteContentNews,
  listSiteContentNewsForEditor,
  saveSiteContentNewsDraft,
} from "@/db/site-content";
import { requireSiteAuthorApiContext } from "@/lib/guards/site-admin-api";
import {
  normalizeNullableInteger,
  normalizeString,
  parsePositiveIntWithFallback,
  readRequestBody,
} from "@/lib/helpers/request";
import { logRuntimeEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

/*
 * The words of a News entry, which is the authoring half of `design/NEWS.md`.
 *
 * Every method here is behind `requireSiteAuthorApiContext` and none of them touches `status`,
 * `published_at` or `expires_at`: when an entry is seen is stated at `news/publish`, behind the
 * publishing policy. A delete is refused while an entry is published, because removing something from a
 * Site is that same authority's act wearing a different verb.
 */

const NEWS_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MAX_NEWS_TAGS = 12;
const MAX_NEWS_TAG_LENGTH = 40;
const MAX_NEWS_TITLE_LENGTH = 200;
const MAX_NEWS_SUBTITLE_LENGTH = 300;
const MAX_NEWS_CONTENT_LENGTH = 20_000;

type NewsDraftBody = {
  contentId: number | null;
  slug: string | null;
  title: string;
  subtitle: string | null;
  content: string;
  link: string | null;
  tags: string[];
  sortOrder: number;
};

/**
 * A link is either the Site's own path or an absolute `http(s)` address, and nothing else.
 *
 * It is rendered as an `href` on a public page, so a scheme nobody validated is a scheme somebody chose.
 * A protocol-relative `//host` is refused with the rest: it reads like a path and resolves like a host.
 */
function readNewsLink(value: unknown): { link: string | null } | { error: string } {
  const link = normalizeString(value);
  if (!link) {
    return { link: null };
  }
  if (link.startsWith("/")) {
    return link.startsWith("//")
      ? { error: "link must not be protocol-relative." }
      : { link };
  }

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { error: "link must be a site-relative path or an http(s) URL." };
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? { link: parsed.toString() }
    : { error: "link must be a site-relative path or an http(s) URL." };
}

function readNewsTags(value: unknown): { tags: string[] } | { error: string } {
  if (value === undefined || value === null) {
    return { tags: [] };
  }
  if (!Array.isArray(value)) {
    return { error: "tags must be an array of strings." };
  }

  const tags: string[] = [];
  for (const entry of value) {
    const tag = normalizeString(entry);
    if (!tag) {
      continue;
    }
    if (tag.length > MAX_NEWS_TAG_LENGTH) {
      return { error: `A tag must be at most ${MAX_NEWS_TAG_LENGTH} characters.` };
    }
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags.length > MAX_NEWS_TAGS
    ? { error: `At most ${MAX_NEWS_TAGS} tags are allowed.` }
    : { tags };
}

function readNewsDraftBody(
  body: Record<string, unknown>,
  options: { requireSlug: boolean },
): { input: NewsDraftBody } | { error: string } {
  // A Form's hidden field sends the id as a string, a client holding it sends a number; both arrive here.
  const contentId = normalizeNullableInteger(body.contentId);
  const slug = normalizeString(body.slug).toLowerCase();
  const title = normalizeString(body.title);
  const subtitle = normalizeString(body.subtitle);
  const content = normalizeString(body.content);

  if (options.requireSlug || slug) {
    if (!NEWS_SLUG_PATTERN.test(slug)) {
      return {
        error: "slug must be lower-case letters, digits and hyphens, and start with a letter or digit.",
      };
    }
  }
  if (!options.requireSlug && (contentId === null || contentId <= 0)) {
    return { error: "A valid contentId is required." };
  }
  if (!title || title.length > MAX_NEWS_TITLE_LENGTH) {
    return { error: `title is required and must be at most ${MAX_NEWS_TITLE_LENGTH} characters.` };
  }
  if (subtitle.length > MAX_NEWS_SUBTITLE_LENGTH) {
    return { error: `subtitle must be at most ${MAX_NEWS_SUBTITLE_LENGTH} characters.` };
  }
  if (!content || content.length > MAX_NEWS_CONTENT_LENGTH) {
    return { error: `content is required and must be at most ${MAX_NEWS_CONTENT_LENGTH} characters.` };
  }

  const link = readNewsLink(body.link);
  if ("error" in link) {
    return link;
  }
  const tags = readNewsTags(body.tags);
  if ("error" in tags) {
    return tags;
  }

  return {
    input: {
      contentId: contentId !== null && contentId > 0 ? contentId : null,
      slug: slug || null,
      title,
      subtitle: subtitle || null,
      content,
      link: link.link,
      tags: tags.tags,
      sortOrder: normalizeNullableInteger(body.sortOrder) ?? 0,
    },
  };
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  /*
   * The Site's source locale, never a requested one. What this surface edits is source text, and showing a
   * translated title in a form that writes the source would overwrite the original with its translation
   * on the next save. Translating a News entry is the translations editor's work on the same messages.
   */
  const entries = await listSiteContentNewsForEditor(site.id, site.sourceLocale);

  return NextResponse.json({ sourceLocale: site.sourceLocale, entries });
}

async function writeNewsDraft(request: NextRequest, mode: "create" | "update") {
  const { context, error } = await requireSiteAuthorApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  if (!site) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const parsed = readNewsDraftBody(body, { requireSlug: mode === "create" });
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const outcome = await saveSiteContentNewsDraft({
    siteId: site.id,
    contentId: mode === "create" ? null : parsed.input.contentId,
    slug: parsed.input.slug,
    title: parsed.input.title,
    subtitle: parsed.input.subtitle,
    content: parsed.input.content,
    link: parsed.input.link,
    tags: parsed.input.tags,
    sortOrder: parsed.input.sortOrder,
    createdByUserId: context.session?.userId ?? null,
  });

  if (!outcome.ok) {
    return outcome.reason === "slug_taken"
      ? NextResponse.json({ error: "A news entry with that slug already exists.", code: "slug_taken" }, { status: 409 })
      : NextResponse.json({ error: "News entry not found." }, { status: 404 });
  }

  logRuntimeEvent("info", "site.editor.news.saved", {
    area: "editor",
    message: "News draft saved.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { contentId: outcome.contentId, versionId: outcome.versionId, slug: outcome.slug, mode },
  });

  return NextResponse.json({
    contentId: outcome.contentId,
    versionId: outcome.versionId,
    slug: outcome.slug,
  });
}

export async function POST(request: NextRequest) {
  return writeNewsDraft(request, "create");
}

export async function PATCH(request: NextRequest) {
  return writeNewsDraft(request, "update");
}

export async function DELETE(request: NextRequest) {
  const { context, error } = await requireSiteAuthorApiContext(request);
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

  const outcome = await deleteSiteContentNews({ siteId: site.id, contentId });
  if (outcome === "missing") {
    return NextResponse.json({ error: "News entry not found." }, { status: 404 });
  }
  if (outcome === "published") {
    return NextResponse.json(
      { error: "A published news entry must be withdrawn before it can be deleted.", code: "published" },
      { status: 409 },
    );
  }

  logRuntimeEvent("info", "site.editor.news.deleted", {
    area: "editor",
    message: "News draft deleted.",
    siteKey: site.key,
    userId: context.session?.userId ?? null,
    meta: { contentId },
  });

  return NextResponse.json({ deletedCount: 1 });
}
