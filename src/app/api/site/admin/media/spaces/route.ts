import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { ensureSiteMediaConfig, resolveEffectiveMediaQuotaBytes, PhisMediaSpaceKind } from "@/db/media-spaces";
import { listSiteMediaSpacesForAdmin } from "@/db/media-storage-settings";
import { requireSiteMaintainerApiContext } from "@/lib/guards/site-admin-api";

/**
 * The existing User or Group Spaces of the Site, with the Profile each writes to and its quota.
 *
 * The second half of the Admin storage settings: the defaults above decide for Spaces made from now on,
 * this is where one that already exists departs from them. A page at a time, because a Site can have a
 * User Space per person.
 */

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteMaintainerApiContext(request);
  if (error) return error;
  const site = context!.site!;
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind");
  if (kind !== "user" && kind !== "group") {
    return NextResponse.json({ error: "kind must be user or group." }, { status: 400 });
  }
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(params.get("pageSize") ?? "25", 10) || 25));
  const [config, listed] = await Promise.all([
    ensureSiteMediaConfig(site.id),
    listSiteMediaSpacesForAdmin(site.id, kind, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      search: params.get("search"),
    }),
  ]);
  const spaceKind = kind === "user" ? PhisMediaSpaceKind.User : PhisMediaSpaceKind.Group;
  return NextResponse.json({
    spaces: listed.rows.map((row) => ({
      ...row,
      // What actually bounds the Space, so an inherited figure is not read as "no limit".
      effectiveQuotaBytes: resolveEffectiveMediaQuotaBytes({ kind: spaceKind, quotaBytes: row.quotaBytes }, config),
    })),
    total: listed.total,
    page,
    pageSize,
  });
}
