import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ config: vi.fn() }));

vi.mock("@/lib/config", () => ({ getPhisConfigSync: mocks.config }));

import {
  buildPhiUnsubscribeToken,
  buildPhiUnsubscribeUrl,
  createPhiNotificationLinkSalt,
  readPhiUnsubscribeTokenSubject,
  verifyPhiUnsubscribeToken,
} from "./links";

/**
 * An unsubscribe link has to hold for years in an archived mailbox and must not let anybody unsubscribe
 * anybody. These pin both halves: what a link is bound to, and what it stops being valid for.
 */
describe("unsubscribe links", () => {
  const salt = "0123456789abcdef0123456789abcdef";

  function withSecret(secret: string) {
    mocks.config.mockReturnValue({ notifications: { linkSecret: secret } });
  }

  it("verifies the link it issued", () => {
    withSecret("key-one");
    const token = buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt });
    const subject = readPhiUnsubscribeTokenSubject(token);
    expect(subject).toEqual({ userId: 42, signature: expect.any(String) });
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, signature: subject!.signature }))
      .toBe(true);
  });

  it("refuses a link after that person's salt was replaced", () => {
    withSecret("key-one");
    const token = buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt });
    const signature = readPhiUnsubscribeTokenSubject(token)!.signature;
    const rotated = createPhiNotificationLinkSalt();
    expect(rotated).toHaveLength(32);
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt: rotated, signature })).toBe(false);
  });

  it("refuses a link presented for another account, another Site, or under another key", () => {
    withSecret("key-one");
    const signature = readPhiUnsubscribeTokenSubject(
      buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt }),
    )!.signature;

    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 43, salt, signature })).toBe(false);
    expect(verifyPhiUnsubscribeToken({ siteId: 4, userId: 42, salt, signature })).toBe(false);

    withSecret("key-two");
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, signature })).toBe(false);
  });

  it("reads no subject out of something that is not a link", () => {
    withSecret("key-one");
    for (const value of ["", "42", "42.", ".sig", "abc.sig", "0.sig", "-1.sig"]) {
      expect(readPhiUnsubscribeTokenSubject(value), value).toBeNull();
    }
  });

  it("refuses to sign without a configured key, and says which one", () => {
    mocks.config.mockReturnValue({});
    expect(() => buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt }))
      .toThrow(/notifications\.linkSecret/);
  });

  it("builds a URL on the Site's own base, in the reader's language", () => {
    withSecret("key-one");
    expect(buildPhiUnsubscribeUrl({
      publicBaseUrl: "https://site.test/",
      locale: "de",
      token: "42.sig+with/chars",
    })).toBe("https://site.test/de/unsubscribe?token=42.sig%2Bwith%2Fchars");

    expect(() => buildPhiUnsubscribeUrl({ publicBaseUrl: "  ", locale: "de", token: "t" }))
      .toThrow(/public base URL/);
  });
});
