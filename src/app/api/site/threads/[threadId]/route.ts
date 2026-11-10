import { NextRequest, NextResponse } from "next/server";

import { PhisThreadStatus, type PhisThreadStatusValue } from "@phis/contracts/threads";

import { getThreadDetail, PhisThreadError, setThreadLocked, setThreadStatus } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import {
  normalizeNullableInteger,
  parseStrictPositiveInt,
  readRequestBody,
} from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const threadId = parseStrictPositiveInt((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const thread = await getThreadDetail(site.id, { kind: "user", userId }, threadId, {
    messageLimit: normalizeNullableInteger(searchParams.get("messageLimit")) ?? undefined,
    beforeMessageId: normalizeNullableInteger(searchParams.get("beforeMessageId")),
  });
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  return NextResponse.json({ thread });
}

/**
 * Archiving and reopening. One row carries the status, so this is the thread closing for everyone -- and
 * therefore only for its opener, Staff, or a Manager of a group in it (`setThreadStatus` decides).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { context, error } = await requireSiteAuthenticatedApiContext(request);
  if (error) {
    return error;
  }

  const site = context?.site;
  const userId = context?.session?.userId ?? null;
  if (!site || !userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const threadId = parseStrictPositiveInt((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  // Either or both: where a thread stands, and whether it takes new messages.
  const statesStatus = Object.hasOwn(body, "status");
  const statesLocked = Object.hasOwn(body, "locked");
  const status = typeof body.status === "number" ? body.status : null;
  if (statesStatus && status !== PhisThreadStatus.Open && status !== PhisThreadStatus.Archived) {
    return NextResponse.json({ error: "status must be open or archived." }, { status: 400 });
  }
  if (statesLocked && typeof body.locked !== "boolean") {
    return NextResponse.json({ error: "locked must be true or false." }, { status: 400 });
  }
  if (!statesStatus && !statesLocked) {
    return NextResponse.json({ error: "status or locked must be provided." }, { status: 400 });
  }

  let found = true;
  try {
    const reader = { kind: "user", userId } as const;
    if (statesStatus) {
      found = await setThreadStatus({ siteId: site.id, threadId, reader, status: status as PhisThreadStatusValue });
    }
    if (found && statesLocked) {
      found = await setThreadLocked({ siteId: site.id, threadId, reader, locked: body.locked as boolean });
    }
  } catch (cause) {
    if (cause instanceof PhisThreadError) {
      return NextResponse.json({ error: cause.message }, { status: 403 });
    }
    throw cause;
  }
  if (!found) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  return NextResponse.json({
    ...(statesStatus ? { status } : {}),
    ...(statesLocked ? { locked: body.locked } : {}),
  });
}
