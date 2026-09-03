import "server-only";

import { NextResponse } from "next/server";
import { getPhiServerConfigSync } from "@/lib/config";
import { PHIS_TOKEN_HEADER } from "@/lib/constants/http-headers";

type CorsOptions = {
  methods: string[];
  headers?: string[];
  credentials?: boolean;
};

function getAllowedOriginSuffixes() {
  return (
    getPhiServerConfigSync().cors?.allowedOriginSuffixes
      ?.map((item) => item.trim().toLowerCase())
      .filter(Boolean) ?? []
  );
}

function getAllowedOrigins() {
  return (
    getPhiServerConfigSync().cors?.allowedOrigins
      ?.map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

function resolveAllowedOrigin(origin: string | null) {
  if (!origin) {
    return null;
  }

  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.includes(origin)) {
    return origin;
  }

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const suffixes = getAllowedOriginSuffixes();
    if (
      suffixes.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
      )
    ) {
      return origin;
    }
  } catch {
    return null;
  }

  return null;
}

export function buildCorsHeaders(request: Request, options: CorsOptions) {
  const origin = resolveAllowedOrigin(request.headers.get("origin"));
  if (!origin) {
    return {};
  }

  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": options.methods.join(", "),
    "Access-Control-Allow-Headers": (options.headers ?? [
      "content-type",
      "x-csrf-token",
      PHIS_TOKEN_HEADER,
      "authorization",
    ]).join(", "),
    Vary: "Origin",
  } as Record<string, string>;

  if (options.credentials !== false) {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

export function withCors<T extends NextResponse>(
  request: Request,
  response: T,
  options: CorsOptions,
) {
  const headers = buildCorsHeaders(request, options);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

export function createCorsOptionsResponse(request: Request, options: CorsOptions) {
  return new NextResponse(null, {
    status: 204,
    headers: buildCorsHeaders(request, options),
  });
}
