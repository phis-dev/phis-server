import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  site: vi.fn(),
  csrf: vi.fn(),
  session: vi.fn(),
  user: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/auth", () => ({ verifyCsrfRequest: mocks.csrf }));
vi.mock("@/db/user-sessions", () => ({ getSessionFromRequest: mocks.session }));
vi.mock("@/db/user-accounts", () => ({ getUserAccountById: mocks.user }));
vi.mock("@/db/user-site-memberships", () => ({ getEffectiveUserSiteAuthorization: mocks.role }));

import { requireAuthenticatedSiteUser } from "./authenticated-site-user";

const request = () => new NextRequest("https://server.test/api/v1/auth/profile/name", { method: "PATCH" });

/** Each link of the chain, and the answer it gives when it is the one that fails. */
describe("the signed-in chain of the auth handlers", () => {
  beforeEach(() => {
    mocks.site.mockReset().mockResolvedValue({ id: 7 });
    mocks.csrf.mockReset().mockReturnValue(true);
    mocks.session.mockReset().mockResolvedValue({ id: "s", userId: 41 });
    mocks.user.mockReset().mockResolvedValue({ id: 41, siteIds: [7] });
    mocks.role.mockReset().mockResolvedValue({ enabled: true });
  });

  it("hands over Site, session, account and membership when every link holds", async () => {
    const guarded = await requireAuthenticatedSiteUser(request());
    expect(guarded.ok && guarded.user.id).toBe(41);
  });

  it.each([
    ["no Site", () => mocks.site.mockResolvedValue(null), 400],
    ["no CSRF token", () => mocks.csrf.mockReturnValue(false), 403],
    ["no session", () => mocks.session.mockResolvedValue(null), 401],
    ["an account of another Site", () => mocks.user.mockResolvedValue({ id: 41, siteIds: [2] }), 401],
    ["a disabled membership", () => mocks.role.mockResolvedValue({ enabled: false }), 401],
  ])("refuses %s", async (_label, arrange, status) => {
    arrange();
    const guarded = await requireAuthenticatedSiteUser(request());
    expect(guarded.ok).toBe(false);
    expect(!guarded.ok && guarded.response.status).toBe(status);
  });

  it("admits an account told to change its password only where the caller says so", async () => {
    await requireAuthenticatedSiteUser(request());
    expect(mocks.session).toHaveBeenLastCalledWith(expect.anything(), 7, {
      allowPasswordChangeRequired: undefined,
    });
    await requireAuthenticatedSiteUser(request(), { allowPasswordChangeRequired: true });
    expect(mocks.session).toHaveBeenLastCalledWith(expect.anything(), 7, {
      allowPasswordChangeRequired: true,
    });
  });
});
