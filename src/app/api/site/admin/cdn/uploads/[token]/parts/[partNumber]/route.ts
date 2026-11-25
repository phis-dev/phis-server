import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { NextRequest, NextResponse } from "next/server";

import { requireOwnPhisCdnUpload, requirePhisCdnAdmin } from "@/lib/cdn-admin-route";
import { PhisCdnUploadStatusCode } from "@/lib/cdn-core";
import { relayPhisCdnUploadPart } from "@/lib/cdn-publish.mts";
import { nextCdnError, respondToPhisCdnError } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * One part of an upload, as raw bytes: streamed from this request to the storage's presigned part address
 * and never buffered here, its SHA-256 signed into that request where the storage verifies one. The
 * length is the Media upload's division of the size; `content-length`, where the request states one, must
 * be it, and a body of another length fails as it streams.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ token: string; partNumber: string }> }) {
  const admin = await requirePhisCdnAdmin(request);
  if (!admin.ok) return admin.response;
  const { token, partNumber: rawPart } = await params;
  const own = await requireOwnPhisCdnUpload(admin.value, token);
  if (!own.ok) return own.response;
  const partNumber = /^[1-9][0-9]{0,4}$/u.test(rawPart) ? Number(rawPart) : null;
  if (partNumber === null) return nextCdnError("part_length", "The part number is not a positive integer.", 400);
  if (own.upload.status !== PhisCdnUploadStatusCode.Pending && own.upload.status !== PhisCdnUploadStatusCode.Uploading) {
    return nextCdnError("upload_state", "This upload takes no more parts.", 409);
  }
  if (!request.body) return nextCdnError("part_length", "The part has no body.", 400);
  const declared = request.headers.get("content-length");
  try {
    const result = await relayPhisCdnUploadPart(getPool(), admin.value.target, own.upload, {
      partNumber,
      body: Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>),
      declaredLength: declared !== null && /^[0-9]+$/u.test(declared) ? Number(declared) : null,
      signal: request.signal,
    });
    return NextResponse.json({ partNumber, uploaded: result.uploaded });
  } catch (error) {
    const response = respondToPhisCdnError(error);
    if (response) return response;
    throw error;
  }
}
