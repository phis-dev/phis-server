import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  readSalt: vi.fn(),
  touchSalt: vi.fn(),
  hasOptOut: vi.fn(),
  recordOptOut: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/notifications", () => ({
  readPhiNotificationLinkSalt: mocks.readSalt,
  touchPhiNotificationLinkSalt: mocks.touchSalt,
  hasPhiNotificationOptOut: mocks.hasOptOut,
  recordPhiNotificationOptOut: mocks.recordOptOut,
}));
vi.mock("@/lib/notifications/links", () => ({
  readPhiUnsubscribeTokenSubject: (raw: string) => {
    const [id, occasion, signature] = raw.split(".");
    return signature && occasion && Number(id) > 0
      ? { userId: Number(id), occasion: { providerId: "@acme/newsletter", occasion }, signature }
      : null;
  },
  verifyPhiUnsubscribeToken: mocks.verify,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { GET, POST } from "./route";

const TOKEN = "42.news.signature";
const OPT_OUT = { userId: 42, siteId: 3, providerId: "@acme/newsletter", occasion: "news" };

function url(token = TOKEN) {
  return `https://server.test/api/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Mail clients and security scanners fetch the links in a message before a person has seen them, so the
 * one thing this route must never do is act on a `GET`. The rest is what the two presses of one button
 * should say.
 */
describe("the unsubscribe route", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.guard.mockReturnValue(null);
    mocks.site.mockResolvedValue({ id: 3, key: "site" });
    mocks.readSalt.mockResolvedValue("a".repeat(32));
    mocks.verify.mockReturnValue(true);
    mocks.hasOptOut.mockResolvedValue(false);
    mocks.recordOptOut.mockResolvedValue(true);
  });

  it("reports what a press would do on GET, and changes nothing", async () => {
    const response = await GET(new Request(url()) as never);

    expect(await response.json()).toEqual({ outcome: "unsubscribed", pending: true });
    expect(mocks.hasOptOut).toHaveBeenCalledWith(OPT_OUT);
    expect(mocks.recordOptOut).not.toHaveBeenCalled();
    expect(mocks.touchSalt).not.toHaveBeenCalled();
  });

  it("says on GET that somebody already left the occasion", async () => {
    mocks.hasOptOut.mockResolvedValue(true);
    const response = await GET(new Request(url()) as never);

    expect(await response.json()).toEqual({ outcome: "already" });
    expect(mocks.recordOptOut).not.toHaveBeenCalled();
  });

  it("records the opt-out of the link's occasion on POST and notes the use", async () => {
    const response = await POST(new Request(url(), { method: "POST" }) as never);

    expect(await response.json()).toEqual({ outcome: "unsubscribed" });
    expect(mocks.recordOptOut).toHaveBeenCalledWith(OPT_OUT);
    expect(mocks.touchSalt).toHaveBeenCalledWith(42, 3);
  });

  it("says so rather than reporting a change when somebody is already out", async () => {
    mocks.recordOptOut.mockResolvedValue(false);
    const response = await POST(new Request(url(), { method: "POST" }) as never);

    expect(await response.json()).toEqual({ outcome: "already" });
    expect(mocks.touchSalt).toHaveBeenCalledWith(42, 3);
  });

  it("records nothing, and touches nothing, when the link does not hold", async () => {
    mocks.verify.mockReturnValue(false);
    const response = await POST(new Request(url(), { method: "POST" }) as never);

    // A failing status, because the page is a Form and a Form reads the status: a 200 here would report
    // success and tell somebody they were unsubscribed when nothing happened.
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ outcome: "invalid" });
    expect(mocks.hasOptOut).not.toHaveBeenCalled();
    expect(mocks.recordOptOut).not.toHaveBeenCalled();
    expect(mocks.touchSalt).not.toHaveBeenCalled();
  });

  it("answers a link for a membership that is gone the same way as a forged one", async () => {
    mocks.readSalt.mockResolvedValue(null);
    const response = await POST(new Request(url(), { method: "POST" }) as never);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ outcome: "invalid" });
    // The salt is missing, so nothing can be verified and nothing should be.
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("reads the token out of the body as well, for a one-click POST", async () => {
    const response = await POST(new Request(
      "https://server.test/api/v1/notifications/unsubscribe",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) },
    ) as never);

    expect(await response.json()).toEqual({ outcome: "unsubscribed" });
    expect(mocks.recordOptOut).toHaveBeenCalledWith(OPT_OUT);
  });

  it("refuses a token that is not one at all", async () => {
    for (const bad of ["", "42", "42.signature", "nonsense"]) {
      const response = await POST(new Request(url(bad), { method: "POST" }) as never);
      expect(response.status, bad).toBe(422);
      expect(await response.json(), bad).toMatchObject({ outcome: "invalid" });
    }
    expect(mocks.readSalt).not.toHaveBeenCalled();
  });
});
