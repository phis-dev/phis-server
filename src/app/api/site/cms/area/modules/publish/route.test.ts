import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Publishing an Area's Module selection is the Builder's activation of a package: the products the package
 * proposes are taken then, as the person who published, and nothing that comes of them changes the answer.
 */

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  publish: vi.fn(),
  take: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/guards/site-admin-api")>()),
  requireSitePublisherApiContext: mocks.guard,
}));
vi.mock("@/db/site-pages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/site-pages")>()),
  publishSiteAreaModulesRevision: mocks.publish,
}));
vi.mock("@/lib/site-cms-audit", () => ({ logSiteCmsAuditEvent: vi.fn() }));
vi.mock("@/lib/module-products-apply", () => ({ takeModuleProductProposalsOnActivation: mocks.take }));

import { POST } from "./route";

const SITE = { id: 3, key: "acme", publicBaseUrl: "https://acme.test", timeZone: "UTC" };

function publish(body: unknown) {
  return POST(new NextRequest("https://acme.test/api/site/cms/area/modules/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("publishing an Area's Module selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockResolvedValue({ context: { site: SITE, session: { userId: 41 } }, error: null });
    mocks.publish.mockResolvedValue({ revisionId: 7, config: { modules: { runtimeModules: ["@acme/site/modules/site"] } } });
    mocks.take.mockResolvedValue([]);
  });

  it("takes the proposed products after the publish, as the person who published", async () => {
    const response = await publish({ area: "public", revisionId: 7 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ areaMask: expect.any(Number), revisionId: 7, config: { modules: { runtimeModules: ["@acme/site/modules/site"] } } });
    expect(mocks.take).toHaveBeenCalledWith(SITE, { actorUserId: 41 });
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(mocks.take.mock.invocationCallOrder[0]!);
  });

  it("answers the publish as published when taking them fails, and takes nothing when the publish fails", async () => {
    mocks.take.mockRejectedValueOnce(new Error("database gone"));
    expect((await publish({ area: "public", revisionId: 7 })).status).toBe(200);
    mocks.publish.mockRejectedValueOnce(new Error("No Area Module draft revision available to publish."));
    mocks.take.mockClear();
    expect((await publish({ area: "public", revisionId: 7 })).status).toBe(500);
    expect(mocks.take).not.toHaveBeenCalled();
  });

  it("takes nothing without a signed-in person, and nothing for a refused request", async () => {
    mocks.guard.mockResolvedValueOnce({ context: { site: SITE, session: null }, error: null });
    expect((await publish({ area: "public", revisionId: 7 })).status).toBe(200);
    mocks.guard.mockResolvedValueOnce({ context: null, error: new Response(null, { status: 403 }) });
    expect((await publish({ area: "public", revisionId: 7 })).status).toBe(403);
    expect(mocks.take).not.toHaveBeenCalled();
  });
});
