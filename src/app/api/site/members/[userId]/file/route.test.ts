import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { PHIS_SITE_ACCESS } from "@phis/contracts/addon";
import { PHI_CORE_ROLE_PROVIDER_ID, PhiBaseRole } from "@phis/contracts/access";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ actor: vi.fn(), file: vi.fn() }));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => ({ id: 4, key: "example" }) }));
vi.mock("@/db/site-request-actor", () => ({ getSiteRequestActorFromRequest: mocks.actor }));
vi.mock("@/db/user-sessions", () => ({ touchSession: async () => undefined }));
vi.mock("@/lib/site-customer-file", () => ({ readPhisCustomerFile: mocks.file }));

import { GET } from "./route";

const actorWith = (flags: number) => ({
  session: { userId: 7 },
  siteRole: { enabled: true, roleClaims: flags ? [{ providerId: PHI_CORE_ROLE_PROVIDER_ID, flags }] : [], groupClaims: [] },
});
const ask = (userId: string, query = "") =>
  GET(new NextRequest(`https://server.test/api/site/members/${userId}/file${query}`), { params: Promise.resolve({ userId }) });
const FILE = { person: { userId: 12, displayName: "Ada Lovelace" }, fileThreadId: 81, threads: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.file.mockResolvedValue(FILE);
});

/** Staff's customer file on a member: the staff road's fields, the person's file and the shared threads. */
describe("GET /api/site/members/{userId}/file", () => {
  it.each([
    ["an Accountant", PhiBaseRole.Accountant, true],
    ["a Supporter", PhiBaseRole.Supporter, false],
    ["a Site Admin", PhiBaseRole.Admin, true],
  ])("answers %s the file, with the accesses they hold", async (_who, flags, accounting) => {
    mocks.actor.mockResolvedValue(actorWith(flags));
    const response = await ask("12", "?page=2&pageSize=10");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FILE);
    const input = mocks.file.mock.calls[0]![0] as { holds: (access: string) => boolean };
    expect(mocks.file).toHaveBeenCalledWith(expect.objectContaining({ siteId: 4, actorUserId: 7, userId: 12, page: 2, pageSize: 10 }));
    expect(input.holds(PHIS_SITE_ACCESS.accounting)).toBe(accounting);
  });

  it("refuses the actor's own file, an id that is none, and somebody who is no member", async () => {
    mocks.actor.mockResolvedValue(actorWith(PhiBaseRole.Accountant));
    expect((await ask("7")).status).toBe(403);
    expect((await ask("x")).status).toBe(404);
    expect(mocks.file).not.toHaveBeenCalled();
    mocks.file.mockResolvedValueOnce(null);
    expect((await ask("13")).status).toBe(404);
  });

  it.each([
    ["an Author", PhiBaseRole.Author],
    ["a member with no role", 0],
  ])("refuses %s and reads nothing", async (_who, flags) => {
    mocks.actor.mockResolvedValue(actorWith(flags));
    expect((await ask("12")).status).toBe(403);
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("refuses nobody signed in", async () => {
    mocks.actor.mockResolvedValue(null);
    expect((await ask("12")).status).toBe(401);
  });
});
