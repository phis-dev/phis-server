import { NextRequest, NextResponse } from "next/server";

import type { PhisCdnUploadInitV1 } from "@phis/contracts/addon";

import { requirePhisCdnAdmin, logPhisCdnAdminEvent } from "@/lib/cdn-admin-route";
import { openPhisCdnBrowserUpload } from "@/lib/cdn-publish.mts";
import { nextCdnError, presentPhisCdnUploadState, readPhisCdnSiteLimits, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";
import { readJsonObjectBody } from "@/lib/helpers/request";

export const dynamic = "force-dynamic";

/**
 * Starts a Maintainer's upload into the Site's CDN (`PhisCdnUploadInitV1`), answered `201` with its state.
 * The same key, size and part digests by the same person carry the open upload on: `200` with the parts
 * the storage holds already. The bytes follow part by part through `uploads/{token}/parts/{n}`.
 */
export async function POST(request: NextRequest) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const body = await readJsonObjectBody(request);
  if (!body) return nextCdnError("invalid_json_body", "Invalid JSON body.", 400);
  const optionalString = (value: unknown) => (value === undefined || value === null ? undefined : typeof value === "string" ? value : null);
  const contentType = optionalString(body.contentType);
  if (typeof body.name !== "string" || typeof body.version !== "string" || typeof body.fileName !== "string"
    || typeof body.sizeBytes !== "number" || contentType === null
    || (body.os !== undefined && typeof body.os !== "number") || (body.arch !== undefined && typeof body.arch !== "number")) {
    return nextCdnError("invalid_body", "name, version, fileName, sizeBytes and partSha256 are required; contentType, os and arch are optional.", 400);
  }
  const init: PhisCdnUploadInitV1 = {
    name: body.name,
    version: body.version,
    fileName: body.fileName,
    sizeBytes: body.sizeBytes,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(typeof body.os === "number" ? { os: body.os } : {}),
    ...(typeof body.arch === "number" ? { arch: body.arch } : {}),
    partSha256: body.partSha256 as string[],
  };
  try {
    const { maxObjectBytes } = await readPhisCdnSiteLimits(admin.value.target.siteId);
    const opened = await openPhisCdnBrowserUpload(getPool(), admin.value.target, init, {
      actorUserId: admin.value.context.session.userId,
      maxObjectBytes,
    });
    logPhisCdnAdminEvent(opened.resumed ? "cdn.upload.resumed" : "cdn.upload.started", admin.value, request, {
      key: opened.upload.key, token: opened.upload.token, sizeBytes: opened.upload.sizeBytes, uploaded: opened.uploaded.length,
    });
    const state = await presentPhisCdnUploadState(admin.value.target, opened.upload);
    return NextResponse.json({ ...state, uploaded: opened.uploaded }, { status: opened.resumed ? 200 : 201 });
  } catch (error) {
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  }
}
