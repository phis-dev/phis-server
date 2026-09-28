import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import {
  buildSessionCookieValue,
  createSessionId,
  LOCALE_COOKIE_NAME,
  parseSessionCookieValue,
  resolveSignedInLocale,
} from "./auth";

/**
 * What a Session cookie has to say before anybody looks the Session up.
 *
 * The id is read straight into a `uuid` column, so a cookie the parser lets through decides whether
 * the query answers or raises. A value that cannot name a Session is no Session: it has to be refused
 * here, where the caller already handles `null`, and not in Postgres, where it is a 500 on every route
 * that asks who is signed in -- the Login page included.
 */
describe("parseSessionCookieValue", () => {
  it("reads the value that buildSessionCookieValue writes", () => {
    const sessionId = createSessionId();
    const parsed = parseSessionCookieValue(buildSessionCookieValue(sessionId, "s3cret"));

    expect(parsed).toEqual({ sessionId, sessionSecret: "s3cret" });
  });

  it("keeps a secret that contains dots whole", () => {
    const sessionId = createSessionId();
    const parsed = parseSessionCookieValue(`${sessionId}.a.b.c`);

    expect(parsed).toEqual({ sessionId, sessionSecret: "a.b.c" });
  });

  it.each([
    ["empty", ""],
    ["missing", null],
    ["no separator", "11111111-1111-1111-1111-111111111111"],
    ["no secret", "11111111-1111-1111-1111-111111111111."],
    ["no id", ".secret"],
    ["id that is not a uuid", "garbage.secret"],
    ["numeric id from an older cookie", "4711.secret"],
    ["uuid with a trailing character", "11111111-1111-1111-1111-111111111111a.secret"],
  ])("refuses a cookie with %s", (_case, value) => {
    expect(parseSessionCookieValue(value)).toBeNull();
  });
});

/**
 * Which language a signed-in person is served.
 *
 * `preferred_locale` is empty until somebody answers the question under their profile, and that absence
 * is the switch: then the language the browser is being read in decides -- the cookie the language
 * switch wrote, else `Accept-Language`, else the Site default. Sign-in used to resolve from the column
 * alone and then overwrite the cookie with the result, so a visitor who had just chosen German in the
 * Public Area was handed the Site default by an account that had never been asked.
 */
describe("resolveSignedInLocale", () => {
  const availableLocales = ["en", "de", "fr"];

  function signIn(input: {
    cookie?: string;
    acceptLanguage?: string;
    preferredLocale?: string | null;
  }) {
    const headers = new Headers();
    if (input.cookie) {
      headers.set("cookie", `${LOCALE_COOKIE_NAME}=${input.cookie}`);
    }
    if (input.acceptLanguage) {
      headers.set("accept-language", input.acceptLanguage);
    }
    return resolveSignedInLocale(
      new NextRequest("https://example.test/api/v1/auth/password/login", { headers }),
      {
        user: { preferredLocale: input.preferredLocale ?? null },
        defaultLocale: "en",
        availableLocales,
      },
    );
  }

  it("keeps the language the browser was reading in when nobody has answered", () => {
    expect(signIn({ cookie: "de" })).toBe("de");
  });

  it("serves the saved language instead, because answering is what outranks the cookie", () => {
    expect(signIn({ cookie: "de", preferredLocale: "fr" })).toBe("fr");
  });

  it("falls back to the browser's own preference, then to the Site default", () => {
    expect(signIn({ acceptLanguage: "de-CH,de;q=0.9" })).toBe("de");
    expect(signIn({})).toBe("en");
    expect(signIn({ cookie: "es", acceptLanguage: "es-ES" })).toBe("en");
  });

  it("ignores an answer in a language this Site does not offer", () => {
    expect(signIn({ cookie: "de", preferredLocale: "es" })).toBe("de");
  });
});
