import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@phis/contracts/access";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  grants: vi.fn(async (_pool: unknown, _siteId: number): Promise<unknown[]> => []),
  grant: vi.fn(async (_pool: unknown, _input: Record<string, unknown>): Promise<boolean> => true),
  revoke: vi.fn(async (_pool: unknown, _input: Record<string, unknown>) => true),
  days: vi.fn(async (_siteId: number): Promise<number | null> => 90),
  setDays: vi.fn(async (_siteId: number, _days: number) => undefined),
  log: vi.fn(async (_input: Record<string, unknown>): Promise<unknown[]> => []),
  installed: {} as Record<string, unknown>,
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => ({ id: 4, key: "example" }) }));
vi.mock("@/db/site-request-actor", () => ({ getSiteRequestActorFromRequest: mocks.actor }));
vi.mock("@/db/user-sessions", () => ({ touchSession: async () => undefined }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/addons/installed", () => ({ getPhisAddonInstalledManifest: () => mocks.installed }));
vi.mock("@/db/users-grants.mts", () => ({
  listPhisAddonUsersGrants: mocks.grants,
  grantPhisAddonUsersBackground: mocks.grant,
  revokePhisAddonUsersBackground: mocks.revoke,
}));
vi.mock("@/db/site-users", () => ({
  readPhisUsersAccessLogDays: mocks.days,
  setPhisUsersAccessLogDays: mocks.setDays,
  listPhisUsersAccessLog: mocks.log,
}));

import { GET } from "./route";
import { DELETE, PUT } from "./[addonId]/route";
import { PUT as PUT_RETENTION } from "./retention/route";
import { GET as GET_LOG } from "./log/route";

const CRM = "@acme/crm";
const actorWith = (flags: number) => ({
  session: { userId: 7 },
  siteRole: { enabled: true, roleClaims: flags ? [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags }] : [], groupClaims: [] },
});
const url = "https://server.test/api/site/admin/users-access";
const put = (body: unknown, addonId = CRM) =>
  PUT(new NextRequest(`${url}/${encodeURIComponent(addonId)}`, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ addonId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(actorWith(PhiBaseRole.Admin));
  mocks.installed = {
    [CRM]: { flags: 1, manifest: { requiredCoreCapabilities: [PHIS_CORE_CAPABILITIES.users], users: { fields: ["name", "email", "address"], background: ["name", "address"] } } },
    "@acme/blog": { flags: 1, manifest: { requiredCoreCapabilities: [] } },
  };
});

/** What the Site lets Add-ons read of people with nobody acting, and how long it keeps the log: Site Admin only. */
describe("/api/site/admin/users-access", () => {
  it("lists every Add-on that reads people with its grant and the log's retention", async () => {
    mocks.grants.mockResolvedValueOnce([{ addonId: CRM, fields: 1 | 2, grantedByUserId: 7, grantedAt: "2026-11-24T00:00:00.000Z" }]);
    expect(await (await GET(new NextRequest(url))).json()).toEqual({
      retentionDays: 90,
      addons: [{
        addonId: CRM, fields: ["name", "email", "address"], background: ["name", "address"], granted: ["name", "email"],
        effective: ["name"], awaiting: ["address"], grantedAt: "2026-11-24T00:00:00.000Z", grantedByUserId: 7,
      }],
    });
  });

  it("grants a part of what the manifest asks, in the Admin's name, and answers the row", async () => {
    mocks.grants.mockResolvedValueOnce([]).mockResolvedValueOnce([{ addonId: CRM, fields: 8, grantedByUserId: 7, grantedAt: "2026-11-24T00:00:00.000Z" }]);
    const response = await put({ fields: ["address"] });
    expect(response.status).toBe(200);
    expect(mocks.grant).toHaveBeenCalledWith({}, { siteId: 4, addonId: CRM, fields: 8, grantedByUserId: 7 });
    expect((await response.json()).effective).toEqual(["address"]);
  });

  it("refuses fields the manifest does not ask, an Add-on that reads nobody, and one not yet in the registry", async () => {
    for (const fields of [["email"], [], ["name", "name"], "name", undefined]) {
      expect((await put({ fields })).status, JSON.stringify(fields)).toBe(400);
    }
    expect((await put({ fields: ["name"] }, "@acme/blog")).status).toBe(404);
    expect((await put({ fields: ["name"] }, "@acme/missing")).status).toBe(404);
    expect(mocks.grant).not.toHaveBeenCalled();
    mocks.grant.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "23503" }));
    expect((await put({ fields: ["name"] })).status).toBe(409);
  });

  it("withdraws a grant, and sets the log's retention within its bounds", async () => {
    const revoked = await DELETE(new NextRequest(`${url}/x`, { method: "DELETE" }), { params: Promise.resolve({ addonId: CRM }) });
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(mocks.revoke).toHaveBeenCalledWith({}, { siteId: 4, addonId: CRM });

    const retention = (days: unknown) => PUT_RETENTION(new NextRequest(`${url}/retention`, { method: "PUT", body: JSON.stringify({ days }) }));
    expect(await (await retention(30)).json()).toEqual({ retentionDays: 30 });
    expect(mocks.setDays).toHaveBeenCalledWith(4, 30);
    for (const days of [0, 3651, 1.5, "30", null]) {
      expect((await retention(days)).status, String(days)).toBe(400);
    }
    expect(mocks.setDays).toHaveBeenCalledTimes(1);
  });

  it("reads the log a page at a time, by subject and Add-on, with the road, call and fields named", async () => {
    mocks.log.mockResolvedValueOnce([{
      at: "2026-11-24T00:00:00.000Z", addonId: CRM, actor: { userId: 7, displayName: "Ada" }, road: 1, operation: 5, subjects: ["sub_a"], addressIds: [3], fields: 15,
    }]);
    const response = await GET_LOG(new NextRequest(`${url}/log?subject=sub_a&addonId=${encodeURIComponent(CRM)}&page=2&pageSize=500`));
    expect(await response.json()).toEqual({
      items: [{
        at: "2026-11-24T00:00:00.000Z", addonId: CRM, actor: { userId: 7, displayName: "Ada" }, road: "staff", operation: "customerFile",
        subjects: ["sub_a"], addressIds: [3], fields: ["name", "email", "phone", "address"],
      }],
    });
    expect(mocks.log).toHaveBeenCalledWith({ siteId: 4, subject: "sub_a", addonId: CRM, page: 2, pageSize: 100 });
  });

  it.each([
    ["an Accountant", PhiBaseRole.Accountant],
    ["a Maintainer", PhiBaseRole.Maintainer],
    ["a member with no role", 0],
  ])("refuses %s on every route and touches nothing", async (_who, flags) => {
    mocks.actor.mockResolvedValue(actorWith(flags));
    expect((await GET(new NextRequest(url))).status).toBe(403);
    expect((await put({ fields: ["name"] })).status).toBe(403);
    expect((await DELETE(new NextRequest(url, { method: "DELETE" }), { params: Promise.resolve({ addonId: CRM }) })).status).toBe(403);
    expect((await PUT_RETENTION(new NextRequest(url, { method: "PUT", body: JSON.stringify({ days: 30 }) }))).status).toBe(403);
    expect((await GET_LOG(new NextRequest(`${url}/log`))).status).toBe(403);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.setDays).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("refuses nobody signed in", async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await GET(new NextRequest(url))).status).toBe(401);
  });
});
