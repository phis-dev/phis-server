import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { createLocalSiteGroup, listSiteGroups } from "@/db/site-groups";
import { requireSiteDeveloperApiContext } from "@/lib/guards/site-admin-api";

/*
 * Creating a group is Site administration: a group is an authorization unit Pages, Navigation and
 * Assets refer to, so group membership must never confer the authority to create more of them. It sits
 * with Developer and Admin -- the Developer policy already means both, because the evaluator applies
 * the Core Admin override centrally.
 */
export async function GET(request: NextRequest) {
  const guarded = await requireSiteDeveloperApiContext(request);
  if (guarded.error) return guarded.error;
  return NextResponse.json({
    provider: {
      capability: "@phis/phi-server/groups:v1",
      providerId: "@phis/phi-server/core",
      connectionKey: null,
    },
    groups: await listSiteGroups(guarded.context!.site!.id),
  });
}

export async function POST(request: NextRequest) {
  const guarded = await requireSiteDeveloperApiContext(request);
  if (guarded.error) return guarded.error;
  const body = await request.json().catch(() => null) as { key?: unknown; name?: unknown } | null;
  if (typeof body?.key !== "string" || typeof body?.name !== "string") {
    return NextResponse.json({ error: "invalid_group" }, { status: 400 });
  }
  try {
    const group = await createLocalSiteGroup({
      siteId: guarded.context!.site!.id,
      key: body.key,
      name: body.name,
    });
    return NextResponse.json({ group }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: "group_create_failed",
      message: error instanceof Error ? error.message : "Group creation failed.",
    }, { status: 400 });
  }
}
