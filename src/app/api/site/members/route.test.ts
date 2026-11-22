import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@phis/contracts/access";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ actor: vi.fn(), search: vi.fn() }));

// The guard is the real one, so the test holds who passes it; only what it reads is stood in for.
vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => ({ id: 4, key: "example" }) }));
vi.mock("@/db/site-request-actor", () => ({ getSiteRequestActorFromRequest: mocks.actor }));
vi.mock("@/db/user-sessions", () => ({ touchSession: async () => undefined }));
vi.mock("@/db/user-admin", () => ({ searchSiteMembers: mocks.search }));

import { GET } from "./route";

function actor(flags: number) {
  return {
    session: { userId: 9 },
    siteRole: {
      enabled: true,
      roleClaims: flags ? [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags }] : [],
      groupClaims: [],
    },
  };
}

const ask = (query = "") => GET(new NextRequest(`https://server.test/api/site/members${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue([{ userId: 12, displayName: "Ada Lovelace" }]);
});

/**
 * The Site's members for a picker, offered to the staff who act on a member's behalf: the holders of the
 * Site access accounting or support, the two Core asks before it names a member to an Add-on.
 */
describe("GET /api/site/members", () => {
  it.each([
    ["an Accountant", PhiBaseRole.Accountant],
    ["a Supporter", PhiBaseRole.Supporter],
    ["a Maintainer", PhiBaseRole.Maintainer],
    ["a Site Admin", PhiBaseRole.Admin],
  ])("answers %s with the page of members, id and name", async (_who, flags) => {
    mocks.actor.mockResolvedValue(actor(flags));
    const response = await ask("?q=ada");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ userId: 12, displayName: "Ada Lovelace" }] });
    expect(mocks.search).toHaveBeenCalledWith({ siteId: 4, query: "ada", page: 1, pageSize: 20 });
  });

  it.each([
    ["an Author", PhiBaseRole.Author],
    ["a Builder", PhiBaseRole.Builder],
    ["a member with no role", 0],
  ])("refuses %s and reads nobody", async (_who, flags) => {
    mocks.actor.mockResolvedValue(actor(flags));
    const response = await ask("?q=ada");

    expect(response.status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("refuses nobody signed in", async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await ask()).status).toBe(401);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("pages, and caps the page at fifty", async () => {
    mocks.actor.mockResolvedValue(actor(PhiBaseRole.Accountant));
    await ask("?page=3&pageSize=500");
    expect(mocks.search).toHaveBeenCalledWith({ siteId: 4, query: "", page: 3, pageSize: 50 });
    await ask("?page=nope&pageSize=-1");
    expect(mocks.search).toHaveBeenLastCalledWith({ siteId: 4, query: "", page: 1, pageSize: 20 });
  });
});
