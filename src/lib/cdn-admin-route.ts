import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { PhisCdnFileOrigin } from "@phis/contracts/addon";

import { readSiteCdnUpload, type SiteCdnUploadRecord } from "@/db/site-cdn.mts";
import { PhisCdnUploadStatusCode, readPhisCdnKey } from "@/lib/cdn-core";
import { abortPhisCdnUpload, type PhisCdnTarget } from "@/lib/cdn-publish.mts";
import { nextCdnError, openPhisCdnTarget } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";
import { requireSiteMaintainerApiContext, type SiteAdminApiGuardedContext } from "@/lib/guards/site-admin-api";
import { logRuntimeEvent } from "@/lib/log";

/*
 * What every route of the CDN page (`/api/site/admin/cdn/...`) starts with: a Maintainer or Admin of the
 * Site (`requireSiteMaintainerApiContext`), and the Site's CDN, or `404 no_cdn`.
 */

export type PhisCdnAdminRouteContext = { context: SiteAdminApiGuardedContext; target: PhisCdnTarget };

export async function requirePhisCdnAdmin(
  request: NextRequest,
): Promise<{ ok: true; value: PhisCdnAdminRouteContext } | { ok: false; response: NextResponse }> {
  const { context, error } = await requireSiteMaintainerApiContext(request);
  if (error) return { ok: false, response: error };
  const target = await openPhisCdnTarget(context.site.id, context.site.key);
  if (!target) return { ok: false, response: nextCdnError("no_cdn", "This Site has no CDN. Attach one with phis cdn attach.", 404) };
  return { ok: true, value: { context, target } };
}

/**
 * An upload of this Site, of the CDN page, by the caller. A token of another Site or an Add-on's import
 * is unknown; another Maintainer's upload is `403 not_your_upload`; an open one past its expiry is
 * aborted here and answered `410 upload_expired`.
 */
export async function requireOwnPhisCdnUpload(
  admin: PhisCdnAdminRouteContext,
  token: string,
): Promise<{ ok: true; upload: SiteCdnUploadRecord } | { ok: false; response: NextResponse }> {
  const upload = token ? await readSiteCdnUpload(getPool(), token) : null;
  if (!upload || upload.siteId !== admin.target.siteId || upload.origin !== PhisCdnFileOrigin.Upload) {
    return { ok: false, response: nextCdnError("unknown_upload", "There is no such upload.", 404) };
  }
  if (upload.actorUserId !== admin.context.session.userId) {
    return { ok: false, response: nextCdnError("not_your_upload", "This upload is somebody else's.", 403) };
  }
  const open = upload.status === PhisCdnUploadStatusCode.Pending || upload.status === PhisCdnUploadStatusCode.Uploading;
  if (open && Date.parse(upload.expiresAt) < Date.now()) {
    await abortPhisCdnUpload(getPool(), admin.target, upload, PhisCdnUploadStatusCode.Aborted, {
      code: "expired", message: "Nothing was sent for this upload before it ran out.",
    });
    return { ok: false, response: nextCdnError("upload_expired", "This upload ran out; start it again.", 410) };
  }
  return { ok: true, upload };
}

/** One line per thing a Maintainer did to the CDN, with Site, key and actor. */
export function logPhisCdnAdminEvent(
  event: "cdn.upload.started" | "cdn.upload.resumed" | "cdn.published" | "cdn.withdrawn" | "cdn.deleted" | "cdn.upload.failed",
  admin: PhisCdnAdminRouteContext,
  request: NextRequest,
  meta: Record<string, unknown>,
) {
  logRuntimeEvent(event === "cdn.upload.failed" ? "warn" : "info", event, {
    message: `${event} ${String(meta.key ?? "")}`.trim(),
    siteKey: admin.target.siteKey,
    userId: admin.context.session.userId,
    method: request.method,
    path: request.nextUrl.pathname,
    meta,
  });
}

/**
 * The key a route names as three path segments, each against its own pattern (the version may carry a
 * colon); null where one does not hold it.
 */
export async function readPhisCdnRouteKey(params: Promise<{ name: string; version: string; file: string }>) {
  const { name, version, file } = await params;
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  };
  return readPhisCdnKey(`${decode(name)}/${decode(version)}/${decode(file)}`)?.key ?? null;
}
