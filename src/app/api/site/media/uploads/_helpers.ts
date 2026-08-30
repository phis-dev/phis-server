import { NextRequest, NextResponse } from "next/server";


export function parsePositiveInt(value: string | null | undefined) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

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
