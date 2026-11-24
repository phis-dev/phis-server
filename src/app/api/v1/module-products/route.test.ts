import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({
  getPhisConfigSync: vi.fn(),
  site: vi.fn(),
  actor: vi.fn(),
  apply: vi.fn(),
  rows: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/site-module-products.mts", () => ({ listSiteModuleProducts: mocks.rows }));
vi.mock("@/lib/addons/command-actor", () => ({ resolvePhisCommandActor: mocks.actor }));
vi.mock("@/lib/module-products-apply", () => ({ applyModuleProductProposal: mocks.apply }));

import { GET, POST } from "./route";

const SITE = { id: 1, key: "acme", publicBaseUrl: "https://acme.test", timeZone: "UTC" };
const INTERNAL = { "user-agent": "t", "x-phis-token": "internal-token", "x-phis-site-key": "acme", "content-type": "application/json" };

function post(body: unknown, headers: Record<string, string> = INTERNAL) {
  return POST(new Request("https://core.test/api/v1/module-products", { method: "POST", headers, body: JSON.stringify(body) }));
}

describe("the Module products routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPhisConfigSync.mockReturnValue({ api: { internalToken: "internal-token", publicToken: "public-token", disableRateLimit: true } } as PhisConfig);
    mocks.site.mockResolvedValue(SITE);
    mocks.rows.mockResolvedValue([]);
    mocks.actor.mockResolvedValue({ ok: true, id: 9, email: "ops@acme.test" });
    mocks.apply.mockResolvedValue({ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", status: "created" });
  });

  it("refuse no token and the public token before the Site is looked up", async () => {
    for (const token of [undefined, "public-token", "wrong"]) {
      const headers: Record<string, string> = { "user-agent": "t", "x-phis-site-key": "acme", ...(token ? { "x-phis-token": token } : {}) };
      expect((await GET(new Request("https://core.test/api/v1/module-products", { headers }))).status).toBe(403);
      expect((await post({}, headers)).status).toBe(403);
    }
    expect(mocks.site).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("answer 404 for a Site they do not know", async () => {
    mocks.site.mockResolvedValue(null);
    expect((await GET(new Request("https://core.test/api/v1/module-products", { headers: INTERNAL }))).status).toBe(404);
    expect((await post({ package: "@acme/site", proposal: { key: "pro", title: "Pro" }, as: "9" })).status).toBe(404);
  });

  it("list the Site's taken proposals", async () => {
    mocks.rows.mockResolvedValue([{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", flags: 0, createdAt: "x" }]);
    const response = await GET(new Request("https://core.test/api/v1/module-products", { headers: INTERNAL }));
    expect(await response.json()).toEqual({ rows: [{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", flags: 0, createdAt: "x" }] });
    expect(mocks.rows).toHaveBeenCalledWith({}, 1);
  });

  it("refuse a proposal that is not one, and a body without the member", async () => {
    expect((await post({ package: "@acme/site", proposal: { key: "pro" }, as: "9" })).status).toBe(400);
    expect((await post({ package: "not a name", proposal: { key: "pro", title: "Pro" }, as: "9" })).status).toBe(400);
    expect((await post({ package: "@acme/site", proposal: { key: "pro", title: "Pro" } })).status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("answer the actor's refusal as it is, and take nothing", async () => {
    mocks.actor.mockResolvedValue({ ok: false, status: 404, error: "nobody is not a member of acme." });
    const response = await post({ package: "@acme/site", proposal: { key: "pro", title: "Pro" }, as: "nobody" });
    expect(response.status).toBe(404);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("take the proposal as the member named, and answer what it came to", async () => {
    const response = await post({ package: "@acme/site", proposal: { key: "pro", title: "Pro", flags: 1 }, as: "ops@acme.test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", status: "created" } });
    expect(mocks.actor).toHaveBeenCalledWith(SITE, "ops@acme.test");
    expect(mocks.apply).toHaveBeenCalledWith(SITE, {
      packageName: "@acme/site",
      proposal: { key: "pro", title: "Pro", flags: 1 },
      actorUserId: 9,
    });
  });
});
