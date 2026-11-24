import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({
  getPhisConfigSync: vi.fn(),
  site: vi.fn(),
  actor: vi.fn(),
  apply: vi.fn(),
  record: vi.fn(),
  rows: vi.fn(),
  proposals: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/site-module-products.mts", () => ({ listSiteModuleProducts: mocks.rows, listSiteModuleProductProposals: mocks.proposals }));
vi.mock("@/lib/addons/command-actor", () => ({ resolvePhisCommandActor: mocks.actor }));
vi.mock("@/lib/module-products-apply", () => ({ applyModuleProductProposal: mocks.apply, recordModuleProductProposals: mocks.record }));

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
    mocks.proposals.mockResolvedValue([]);
    mocks.record.mockResolvedValue([{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", status: "waiting", reason: "activation" }]);
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

  it("list the Site's taken proposals, and the ones Core keeps with why they wait", async () => {
    mocks.rows.mockResolvedValue([{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", flags: 0, createdAt: "x" }]);
    mocks.proposals.mockResolvedValue([{ packageName: "@acme/site", key: "basic", proposal: { key: "basic", title: "Basic" }, waitingReason: "supplier_refused", waitingDetail: "No." }]);
    const response = await GET(new Request("https://core.test/api/v1/module-products", { headers: INTERNAL }));
    expect(await response.json()).toEqual({
      rows: [{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", flags: 0, createdAt: "x" }],
      proposals: [{ packageName: "@acme/site", key: "basic", waitingReason: "supplier_refused", waitingDetail: "No." }],
    });
    expect(mocks.rows).toHaveBeenCalledWith({}, 1);
  });

  it("refuse a proposal that is not one, and a body without the member", async () => {
    expect((await post({ package: "@acme/site", proposal: { key: "pro" }, as: "9" })).status).toBe(400);
    expect((await post({ package: "not a name", proposal: { key: "pro", title: "Pro" }, as: "9" })).status).toBe(400);
    expect((await post({ package: "@acme/site", proposal: { key: "pro", title: "Pro" } })).status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("keep a package's whole list of proposals when it is handed over without a member, and refuse it whole on one that is not valid", async () => {
    const response = await post({ package: "@acme/site", proposals: [{ key: "pro", title: "Pro", gallery: ["shot"] }] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ packageName: "@acme/site", key: "pro", productKey: "acme.site.pro", status: "waiting", reason: "activation" }] });
    expect(mocks.record).toHaveBeenCalledWith(SITE, { packageName: "@acme/site", proposals: [{ key: "pro", title: "Pro", gallery: ["shot"] }] });
    expect((await post({ package: "@acme/site", proposals: [] })).status).toBe(200);
    expect(mocks.record).toHaveBeenLastCalledWith(SITE, { packageName: "@acme/site", proposals: [] });
    mocks.record.mockClear();
    expect((await post({ package: "@acme/site", proposals: [{ key: "pro", title: "Pro" }, { key: "bad" }] })).status).toBe(400);
    expect((await post({ package: "@acme/site", proposals: [{ key: "pro", title: "Pro" }, { key: "pro", title: "Again" }] })).status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.actor).not.toHaveBeenCalled();
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
