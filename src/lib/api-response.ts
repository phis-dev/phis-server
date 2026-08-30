import { createHash } from "crypto";
import { NextResponse } from "next/server";

type JsonResponseOptions = {
  cacheControl?: string;
  status?: number;
  headers?: Record<string, string>;
};

export function createJsonResponse(
  request: Request,
  payload: unknown,
  options: JsonResponseOptions = {},
) {
  const body = JSON.stringify(payload);
  const etag = createHash("sha1").update(body).digest("hex");
  const headers = new Headers(options.headers);

  headers.set("Content-Type", "application/json");
  headers.set("ETag", etag);

  if (options.cacheControl) {
    headers.set("Cache-Control", options.cacheControl);
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  return new NextResponse(body, { status: options.status ?? 200, headers });
}
