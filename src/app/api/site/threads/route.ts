import { NextRequest, NextResponse } from "next/server";

import type { PhisThreadKindValue, PhisThreadStatusValue } from "@phis/contracts/threads";

import { createThread, listThreadsForUser, PhisThreadError } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import { normalizeString, parsePositiveIntWithFallback, readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/*
 * Threads belong to Core, not to Support.
 *
 * The guard is therefore the Site session rather than a Support role: a Builder writing to a Publisher
 * holds no Support role, and a customer in an Add-on's group holds no Core role at all. What each of
 * them may actually reach is the visibility predicate's answer, asked once in the database layer and
 * not reproduced here -- a guard that tried to decide it would be the second answer that eventually
 * disagrees with the first.
 */

function normalizeInteger(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const parsed = Number.parseInt(normalizeString(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeIdArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((entry) => normalizeInteger(entry))
        .filter((entry): entry is number => entry != null && entry > 0)
    : [];
}

function parseOptionalInt(value: string | null) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseBoolean(value: string | null) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const result = await listThreadsForUser(site.id, userId, {
    page: parsePositiveIntWithFallback(searchParams.get("page"), 1),
    pageSize: Math.min(parsePositiveIntWithFallback(searchParams.get("pageSize"), 25), 100),
    unreadOnly: parseBoolean(searchParams.get("unreadOnly")),
    kind: parseOptionalInt(searchParams.get("kind")) as PhisThreadKindValue | null,
    status: parseOptionalInt(searchParams.get("status")) as PhisThreadStatusValue | null,
  });

  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const body = await readRequestBody(request);
  const message = normalizeString(body.message);
  const kind = normalizeInteger(body.kind);
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  if (kind == null) {
    return NextResponse.json({ error: "kind is required." }, { status: 400 });
  }

  let thread;
  try {
    thread = await createThread({
      siteId: site.id,
      kind: kind as PhisThreadKindValue,
      subject: normalizeString(body.subject) || null,
      message,
      messageMarkdown: normalizeString(body.messageMarkdown) || null,
      messageFlags: normalizeInteger(body.messageFlags) ?? 0,
      participantUserIds: normalizeIdArray(body.participantUserIds),
      participantGroupIds: normalizeIdArray(body.participantGroupIds),
      // The writer's own files, hung on the opening message. Who may read them is this message's answer.
      assetIds: normalizeIdArray(body.assetIds),
      createdByUserId: userId,
    });
  } catch (cause) {
    if (cause instanceof PhisThreadError) {
      return NextResponse.json({ error: cause.message }, { status: 400 });
    }
    throw cause;
  }

  logRuntimeEvent("info", "site.thread.created", {
    area: "threads",
    message: "Thread opened.",
    siteKey: site.key,
    userId,
    meta: { threadId: thread.thread.id, kind: thread.thread.kind },
  });

  return NextResponse.json({ thread }, { status: 201 });
}
