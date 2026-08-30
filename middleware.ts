import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_FILE = /\.(.*)$/;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/" ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: "API-only service. Use /api routes." }, { status: 404 });
}

export const config = {
  matcher: ["/:path*"],
};
