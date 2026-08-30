import "server-only";

import type { NextRequest } from "next/server";

export async function readSiteCmsRequestJson(request: NextRequest) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function readSiteCmsRequestSearchParam(request: NextRequest, key: string) {
  const value = new URL(request.url).searchParams.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readSiteCmsErrorDetail(error: unknown) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const detail = (error as { detail?: unknown }).detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail.trim() : null;
}

export function readSiteCmsErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return fallback;
}

export function readSiteCmsRevisionId(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : null;
  return typeof numeric === "number" && Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function readSiteCmsRevisionIds(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => readSiteCmsRevisionId(entry))
      .filter((entry): entry is number => entry != null);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(",")
      .map((entry) => readSiteCmsRevisionId(entry))
      .filter((entry): entry is number => entry != null);
  }

  return [];
}
