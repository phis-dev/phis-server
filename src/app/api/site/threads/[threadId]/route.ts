import { NextRequest, NextResponse } from "next/server";

import { PhisThreadStatus, type PhisThreadStatusValue } from "@phis/contracts/threads";

import { getThreadDetail, setThreadStatus } from "@/db/threads";
import { requireSiteAuthenticatedApiContext } from "@/lib/guards/site-admin-api";
import { readRequestBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

function parsePositiveId(value: string) {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseOptionalInt(value: string | null) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

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

  const threadId = parsePositiveId((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const thread = await getThreadDetail(site.id, { kind: "user", userId }, threadId, {
    messageLimit: parseOptionalInt(searchParams.get("messageLimit")) ?? undefined,
    beforeMessageId: parseOptionalInt(searchParams.get("beforeMessageId")),
  });
  if (!thread) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  return NextResponse.json({ thread });
}

/** Archiving and reopening. One row carries the status, so this is the thread closing for everyone. */
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

  const threadId = parsePositiveId((await params).threadId);
  if (!threadId) {
    return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  }

  const body = await readRequestBody(request);
  const status = typeof body.status === "number" ? body.status : null;
  if (status !== PhisThreadStatus.Open && status !== PhisThreadStatus.Archived) {
    return NextResponse.json({ error: "status must be open or archived." }, { status: 400 });
  }

  const changed = await setThreadStatus({
    siteId: site.id,
    threadId,
    reader: { kind: "user", userId },
    status: status as PhisThreadStatusValue,
  });
  if (!changed) {
    return NextResponse.json({ error: "Thread not found." }, { status: 404 });
  }

  return NextResponse.json({ status });
}
