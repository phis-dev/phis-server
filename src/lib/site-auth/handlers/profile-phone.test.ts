import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  setPhones: vi.fn(async (_input: Record<string, unknown>) => true),
  actor: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("@/lib/site-auth/authenticated-site-user", () => ({ requireAuthenticatedSiteUser: mocks.guard }));
vi.mock("@/db/user-profiles", () => ({ setUserProfilePhones: mocks.setPhones, getUserProfileByUserId: mocks.profile }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => ({ id: 4, key: "example", defaultLocale: "en" }) }));
vi.mock("@/db/site-request-actor", () => ({ getSiteRequestActorFromRequest: mocks.actor }));
vi.mock("@/db/user-sessions", () => ({ touchSession: async () => undefined }));
vi.mock("@/db/sites", () => ({ readSiteLocaleCodes: async () => ["en"] }));
vi.mock("@/lib/addons/viewer-roles", () => ({ readPhiViewerAddonRoleClaims: async () => [] }));
vi.mock("@/lib/auth", () => ({ resolveSignedInLocale: () => "en" }));

import { PATCH } from "./profile-phone";
import { GET as viewer } from "./viewer";

const patch = (body: unknown) => PATCH(new NextRequest("https://server.test/api/v1/auth/profile/phone", {
  method: "PATCH",
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ ok: true, user: { id: 9 } });
  mocks.setPhones.mockResolvedValue(true);
});

/** The person's own telephone numbers, written as the names are and read back through `/api/v1/auth/me`. */
describe("PATCH /api/v1/auth/profile/phone", () => {
  it("keeps both numbers as typed, trimmed, an empty one as null, and answers them", async () => {
    const response = await patch({ phone: " +41 44 123 45 67 ", mobile: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ phone: "+41 44 123 45 67", mobile: null });
    expect(mocks.setPhones).toHaveBeenCalledWith({ userId: 9, phone: "+41 44 123 45 67", mobile: null });
  });

  it("refuses a body without both, a number that is no line of text or too long, and writes nothing", async () => {
    for (const body of [{ phone: "1" }, { phone: 41, mobile: null }, { phone: "1".repeat(65), mobile: null }, { phone: "a\nb", mobile: null }, "nope"]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.setPhones).not.toHaveBeenCalled();
    expect((await patch({ phone: "1".repeat(64), mobile: null })).status).toBe(200);
  });

  it("answers 409 for a person without a profile, and the guard's refusal for nobody signed in", async () => {
    mocks.setPhones.mockResolvedValueOnce(false);
    expect((await patch({ phone: null, mobile: null })).status).toBe(409);
    mocks.guard.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) });
    expect((await patch({ phone: null, mobile: null })).status).toBe(401);
  });
});

describe("GET /api/v1/auth/me", () => {
  it("answers the person's own numbers in the profile", async () => {
    mocks.actor.mockResolvedValue({
      session: { authenticatedAt: "2026-11-24T00:00:00.000Z", assuranceLevel: 1, authMethodKeys: ["password"] },
      user: { id: 9, emailNormalized: "ada@example.invalid", siteIds: [4], flags: 0 },
      siteRole: { enabled: true, roleClaims: [], groupClaims: [], authorizationRevision: 0, siteFlags: 0, availableProviderIds: new Set() },
    });
    mocks.profile.mockResolvedValue({ userId: 9, firstName: "Ada", lastName: "L", displayName: null, companyName: null, phone: "+44 20", mobile: null });
    const body = await (await viewer(new NextRequest("https://server.test/api/v1/auth/me"))).json();
    expect(body.user.profile).toEqual({ firstName: "Ada", lastName: "L", displayName: null, companyName: null, phone: "+44 20", mobile: null });
  });
});
