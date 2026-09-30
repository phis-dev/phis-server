import { NextResponse } from "next/server";

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
