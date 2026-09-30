/**
 * The attributes every cookie this server writes shares, in one place.
 *
 * Fifteen setters in `auth.ts` and `operator-auth.ts` each spelled them out, and one of them -- the
 * locale cookie -- had already lost `secure` that way. What differs between cookies is only whether a
 * script may read it and when it ends; everything else is the same on purpose: `Lax` for the reasons
 * written above `setSessionCookie`, the whole path, and `secure` wherever the server runs in production.
 */
export function buildPhiCookieOptions(input: {
  /** Whether the cookie is withheld from page scripts; false only for what the client has to read. */
  httpOnly: boolean;
  /** When it ends; without one it lasts as long as the browser session. */
  expires?: Date;
}) {
  return {
    httpOnly: input.httpOnly,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(input.expires ? { expires: input.expires } : {}),
  };
}

/** The same attributes with an expiry in the past, which is how a browser is told to drop a cookie. */
export function buildPhiClearedCookieOptions(input: { httpOnly: boolean }) {
  return buildPhiCookieOptions({ httpOnly: input.httpOnly, expires: new Date(0) });
}
