import { NextRequest, NextResponse } from "next/server";

import {
  PHIS_CDN_ADMIN_PAGE_SIZE_DEFAULT,
  PHIS_CDN_ADMIN_PAGE_SIZE_MAX,
  PhisCdnAdminFlags,
  type PhisCdnAdminListV1,
} from "@phis/contracts/addon";

import { listSiteCdnFilesForAdmin, readSiteCdn, readSiteCdnProfile, type SiteCdnAdminListQuery } from "@/db/site-cdn.mts";
import { presentPhisCdnAdminFile } from "@/lib/cdn-core";
import { phisCdnVerifiesSha256 } from "@/lib/cdn-publish.mts";
import { nextCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";
import { requireSiteMaintainerApiContext } from "@/lib/guards/site-admin-api";

export const dynamic = "force-dynamic";

const STATES = ["offered", "withdrawn", "deleted", "all"] as const;
const SORTS = ["publishedAt", "name"] as const;
const DIRS = ["desc", "asc"] as const;

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T | null {
  if (value === null || value === "") return fallback;
  return (allowed as readonly string[]).includes(value) ? value as T : null;
}

function readCount(value: string | null, fallback: number, max: number) {
  if (value === null || value === "") return fallback;
  if (!/^[0-9]{1,6}$/u.test(value)) return null;
  const number = Number(value);
  return number >= 1 && number <= max ? number : null;
}

/** The query of `GET /api/site/admin/cdn` (`PhisCdnAdminListQueryV1`), or null where a parameter is not one it takes. */
function readListQuery(params: URLSearchParams): SiteCdnAdminListQuery | null {
  const q = params.get("q")?.trim() || null;
  const name = params.get("name")?.trim() || null;
  const state = pick(params.get("state"), STATES, "offered");
  const sort = pick(params.get("sort"), SORTS, "publishedAt");
  const dir = pick(params.get("dir"), DIRS, "desc");
  const page = readCount(params.get("page"), 1, 1_000_000);
  const pageSize = readCount(params.get("pageSize"), PHIS_CDN_ADMIN_PAGE_SIZE_DEFAULT, PHIS_CDN_ADMIN_PAGE_SIZE_MAX);
  if (!state || !sort || !dir || page === null || pageSize === null) return null;
  if ((q && q.length > 200) || (name && name.length > 200)) return null;
  return { q, name, state, sort, dir, page, pageSize };
}

/**
 * The Site's CDN catalogue, a page at a time (`PhisCdnAdminListV1`): copies and links, with state and
 * origin. A Site without a CDN answers `cdn: null` and no files, so the page can say how one is attached.
 */
export async function GET(request: NextRequest) {
  const { context, error } = await requireSiteMaintainerApiContext(request);
  if (error) return error;
  const query = readListQuery(request.nextUrl.searchParams);
  if (!query) {
    return nextCdnError("invalid_query", "q, name, state, sort, dir, page or pageSize is not one this list takes.", 400);
  }
  const pool = getPool();
  const cdn = await readSiteCdn(pool, context.site.id);
  if (!cdn) {
    return NextResponse.json({ cdn: null, files: [], total: 0, page: query.page, pageSize: query.pageSize } satisfies PhisCdnAdminListV1);
  }
  const [profile, listed] = await Promise.all([
    readSiteCdnProfile(pool, context.site.id, { id: cdn.storageProfileId }),
    listSiteCdnFilesForAdmin(pool, context.site.id, query),
  ]);
  return NextResponse.json({
    cdn: {
      publicBaseUrl: cdn.publicBaseUrl,
      profileKey: profile?.key ?? "",
      flags: profile && phisCdnVerifiesSha256(profile) ? PhisCdnAdminFlags.VerifiesSha256 : 0,
    },
    files: listed.rows.map((row) => presentPhisCdnAdminFile(row, cdn.publicBaseUrl)),
    total: listed.total,
    page: query.page,
    pageSize: query.pageSize,
  } satisfies PhisCdnAdminListV1);
}
