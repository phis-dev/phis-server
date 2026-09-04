import { NextResponse, type NextRequest } from "next/server";

/**
 * Everything this service serves in a browser, named once.
 *
 * `phis` was API-only when this file was written, and the refusal below was the whole of it. It stayed
 * after the operator, setup and recovery pages arrived, so a production build answered `404` on all
 * three while `next dev` -- which never loaded this file from the repository root -- showed them
 * working. The list is explicit rather than derived, because a page reachable in a browser is a
 * decision and not a consequence of a file existing; `middleware.test.ts` fails when `src/app` grows a
 * page that nobody added here.
 */
export const PHIS_BROWSER_ROUTE_PREFIXES = ["/operator", "/recovery", "/setup"] as const;

const PUBLIC_FILE = /\.(.*)$/;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/" ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    PUBLIC_FILE.test(pathname) ||
    PHIS_BROWSER_ROUTE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return NextResponse.next();
  }

  return NextResponse.json({ error: "API-only service. Use /api routes." }, { status: 404 });
}

export const config = {
  matcher: ["/:path*"],
};
