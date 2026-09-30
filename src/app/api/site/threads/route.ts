import { NextRequest, NextResponse } from "next/server";

import type { PhisThreadKindValue, PhisThreadStatusValue } from "@phis/contracts/threads";

import { createThread, listThreadsForUser, PhisThreadError } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";
import {
  normalizeNullableInteger,
  normalizePositiveIdArray,
  normalizeString,
  parsePhiPagination,
  readRequestBody,
} from "@/lib/helpers/request";

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
    ...parsePhiPagination(searchParams),
    unreadOnly: parseBoolean(searchParams.get("unreadOnly")),
    kind: normalizeNullableInteger(searchParams.get("kind")) as PhisThreadKindValue | null,
    status: normalizeNullableInteger(searchParams.get("status")) as PhisThreadStatusValue | null,
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
  const subject = normalizeString(body.subject);
  const kind = normalizeNullableInteger(body.kind);
  if (!message) {
    return NextResponse.json({ error: "message is required." }, { status: 400 });
  }
  /*
   * A person opening a conversation names it, and this route is only ever a person.
   *
   * The subject is the name of the whole chain -- the inbox row, the heading over the messages, what a
   * notification is called -- so a conversation without one ends up named after whoever is in it. The
   * column is nullable and stays that way for the integration path, where a mail can genuinely arrive
   * with an empty subject header and is still a conversation; losing the message to protect a heading
   * would be the wrong trade. Here the person who could say it in four words is the one asking.
   *
   * Refused on the route and not only in the form: a validated field a route does not hold to is a
   * courtesy, and the surface is not the only thing that can call this.
   */
  if (!subject) {
    return NextResponse.json({ error: "subject is required." }, { status: 400 });
  }
  if (kind == null) {
    return NextResponse.json({ error: "kind is required." }, { status: 400 });
  }

  let thread;
  try {
    thread = await createThread({
      siteId: site.id,
      kind: kind as PhisThreadKindValue,
      subject,
      message,
      messageMarkdown: normalizeString(body.messageMarkdown) || null,
      messageFlags: normalizeNullableInteger(body.messageFlags) ?? 0,
      participantUserIds: normalizePositiveIdArray(body.participantUserIds),
      participantGroupIds: normalizePositiveIdArray(body.participantGroupIds),
      // The writer's own files, hung on the opening message. Who may read them is this message's answer.
      assetIds: normalizePositiveIdArray(body.assetIds),
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
