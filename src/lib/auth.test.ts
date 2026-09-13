import { describe, expect, it } from "vitest";

import { buildSessionCookieValue, createSessionId, parseSessionCookieValue } from "./auth";

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
