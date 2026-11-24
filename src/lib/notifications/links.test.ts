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
  const occasion = { providerId: "@acme/newsletter", occasion: "news" };

  function withSecret(secret: string) {
    mocks.config.mockReturnValue({ notifications: { linkSecret: secret } });
  }

  it("verifies the link it issued", () => {
    withSecret("key-one");
    const token = buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion });
    const subject = readPhiUnsubscribeTokenSubject(token);
    expect(subject).toEqual({ userId: 42, occasion, signature: expect.any(String) });
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion, signature: subject!.signature }))
      .toBe(true);
  });

  it("refuses a link after that person's salt was replaced", () => {
    withSecret("key-one");
    const token = buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion });
    const signature = readPhiUnsubscribeTokenSubject(token)!.signature;
    const rotated = createPhiNotificationLinkSalt();
    expect(rotated).toHaveLength(32);
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt: rotated, occasion, signature }))
      .toBe(false);
  });

  it("refuses a link presented for another account, another Site, another occasion, or under another key", () => {
    withSecret("key-one");
    const signature = readPhiUnsubscribeTokenSubject(
      buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion }),
    )!.signature;

    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 43, salt, occasion, signature })).toBe(false);
    expect(verifyPhiUnsubscribeToken({ siteId: 4, userId: 42, salt, occasion, signature })).toBe(false);
    // Leaving one newsletter is not leaving another sender's, nor another occasion of the same sender.
    expect(verifyPhiUnsubscribeToken({
      siteId: 3, userId: 42, salt, occasion: { ...occasion, occasion: "offers" }, signature,
    })).toBe(false);
    expect(verifyPhiUnsubscribeToken({
      siteId: 3, userId: 42, salt, occasion: { ...occasion, providerId: "@other/newsletter" }, signature,
    })).toBe(false);

    withSecret("key-two");
    expect(verifyPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion, signature })).toBe(false);
  });

  it("reads no subject out of something that is not a link", () => {
    withSecret("key-one");
    const encoded = (text: string) => Buffer.from(text).toString("base64url");
    const good = encoded("@acme/newsletter|news");
    for (const value of [
      "", "42", "42.", ".sig", "42.sig", `42.${good}.`, `.${good}.sig`, `abc.${good}.sig`, `0.${good}.sig`,
      `-1.${good}.sig`, `1e1.${good}.sig`, `42.${encoded("no-separator")}.sig`, `42.${encoded("|news")}.sig`,
      `42.${encoded("@acme/newsletter|")}.sig`, `42.${good}.sig.extra`,
    ]) {
      expect(readPhiUnsubscribeTokenSubject(value), value).toBeNull();
    }
  });

  it("refuses to sign without a configured key, and says which one", () => {
    mocks.config.mockReturnValue({});
    expect(() => buildPhiUnsubscribeToken({ siteId: 3, userId: 42, salt, occasion }))
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
