import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null }));
vi.mock("@/lib/site-context", () => ({
  requireSiteFromRequest: async () => ({ id: 7, key: "site", defaultLocale: "en" }),
}));
vi.mock("@/lib/form-config", () => ({
  getFormGuardSecret: async () => "secret",
  getFormTimingWindow: () => ({ minAgeMs: 0, maxAgeMs: 1 }),
  getSiteMailConfig: async () => ({ contactRecipient: "inbox@site.test", mailFrom: "site@site.test", mailFromName: "Site" }),
}));
vi.mock("@/lib/form-guard", () => ({ verifyFormGuard: mocks.verify }));
vi.mock("@/lib/form-abuse-log", () => ({ logFormAbuse: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => null }));
vi.mock("@/lib/site-auth/attempt-limit", () => ({ tooManyAttemptsResponse: vi.fn() }));
vi.mock("@/lib/notifications/enqueue", () => ({ notifyPhiPerson: mocks.notify }));

import { POST } from "./route";

function request() {
  return new Request("https://server.test/api/v1/forms/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Paula", email: "paula@example.test", subject: "Hello", message: "Hi",
      issuedAt: "1", formToken: "x",
    }),
  });
}

describe("contact submit guard refusals", () => {
  beforeEach(() => {
    mocks.verify.mockReset();
    mocks.notify.mockReset();
  });

  it("answers an expired token with form_expired, so the browser can renew it", async () => {
    mocks.verify.mockReturnValue({ ok: false, reason: "expired", ageMs: 10 });
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "form_expired" });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("answers every other refusal with the silent success a bot gets", async () => {
    mocks.verify.mockReturnValue({ ok: false, reason: "too-fast", ageMs: 0 });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
