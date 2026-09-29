import { NextRequest, NextResponse } from "next/server";

export async function readJsonBody(request: NextRequest) {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function nextMediaError(
  error: string,
  message: string,
  status = 400,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    {
      error,
      message,
      ...(extra ?? {}),
    },
    { status },
  );
}
