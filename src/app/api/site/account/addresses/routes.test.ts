import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class PhisSiteUsersError extends Error {}
  return {
    PhisSiteUsersError,
    actor: vi.fn(),
    current: vi.fn(async (_siteId: number, _userIds: readonly number[], _options: unknown) => new Map()),
    create: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ id: 31, subject: "sub_me", ...(input.address as object), flags: input.flags })),
    remove: vi.fn(async (_input: Record<string, unknown>): Promise<"deleted" | "removed" | null> => "deleted"),
  };
});

// The guard is the real one; only what it reads is stood in for.
vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => ({ id: 4, key: "example" }) }));
vi.mock("@/db/site-request-actor", () => ({ getSiteRequestActorFromRequest: mocks.actor }));
vi.mock("@/db/user-sessions", () => ({ touchSession: async () => undefined }));
vi.mock("@/db/site-users", () => ({
  PhisSiteUsersError: mocks.PhisSiteUsersError,
  readPhisCurrentSiteAddresses: mocks.current,
  createPhisSiteAddress: mocks.create,
  removePhisSiteAddress: mocks.remove,
}));

import { GET, POST } from "./route";
import { DELETE, PUT } from "./[id]/route";

const ADDRESS = { name: "Ada Lovelace", line1: "12 St James's Square", city: "London", country: "gb" };
const member = { session: { userId: 9 }, siteRole: { enabled: true, roleClaims: [], groupClaims: [] } };
const url = "https://server.test/api/site/account/addresses";
const send = (method: string, body: unknown, path = "") => new NextRequest(`${url}${path}`, { method, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(member);
});

/** The signed-in person's addresses on this Site, by the rule users:v1 holds an Add-on to, never handed out. */
describe("/api/site/account/addresses", () => {
  it("lists the person's current addresses, not marking them handed out", async () => {
    mocks.current.mockResolvedValueOnce(new Map([[9, [{ id: 3 }]]]));
    const response = await GET(new NextRequest(url));
    expect(await response.json()).toEqual({ items: [{ id: 3 }] });
    expect(mocks.current).toHaveBeenCalledWith(4, [9], { handedOut: false });
  });

  it("writes a new address with 201 and a new version with 200, for the person and never handed out", async () => {
    const created = await POST(send("POST", { address: ADDRESS, flags: 5 }));
    expect(created.status).toBe(201);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({
      siteId: 4, userId: 9, flags: 5, replaces: null, handedOut: false, address: expect.objectContaining({ country: "GB", line2: null }),
    }));
    const changed = await PUT(send("PUT", { address: ADDRESS, flags: 1 }, "/3"), params("3"));
    expect(changed.status).toBe(200);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ replaces: 3, userId: 9 }));
  });

  it("refuses an address or flags that are refused, and an id that is no current address of theirs", async () => {
    expect((await POST(send("POST", { address: { ...ADDRESS, country: "GBR" }, flags: 1 }))).status).toBe(400);
    expect((await POST(send("POST", { address: ADDRESS, flags: 16 }))).status).toBe(400);
    expect((await POST(send("POST", { flags: 1 }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockRejectedValueOnce(new mocks.PhisSiteUsersError("replaces names no current address"));
    expect((await PUT(send("PUT", { address: ADDRESS, flags: 1 }, "/77"), params("77"))).status).toBe(404);
    expect((await PUT(send("PUT", { address: ADDRESS, flags: 1 }, "/x"), params("x"))).status).toBe(404);
  });

  it("removes an address, answering whether it was deleted or kept as removed", async () => {
    const deleted = await DELETE(new NextRequest(`${url}/3`, { method: "DELETE" }), params("3"));
    expect(await deleted.json()).toEqual({ outcome: "deleted" });
    expect(mocks.remove).toHaveBeenCalledWith({ siteId: 4, userId: 9, addressId: 3 });
    mocks.remove.mockResolvedValueOnce("removed");
    expect(await (await DELETE(new NextRequest(`${url}/3`, { method: "DELETE" }), params("3"))).json()).toEqual({ outcome: "removed" });
    mocks.remove.mockResolvedValueOnce(null);
    expect((await DELETE(new NextRequest(`${url}/4`, { method: "DELETE" }), params("4"))).status).toBe(404);
  });

  it("refuses nobody signed in and a disabled membership", async () => {
    mocks.actor.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest(url))).status).toBe(401);
    mocks.actor.mockResolvedValueOnce({ ...member, siteRole: { ...member.siteRole, enabled: false } });
    expect((await POST(send("POST", { address: ADDRESS, flags: 1 }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
