import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  builderContext: vi.fn(),
  changePath: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteBuilderApiContext: mocks.builderContext,
}));
// The error class stays real: the route decides the status from `instanceof`, so a mocked class would
// pin nothing.
vi.mock("@/db/site-pages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/site-pages")>()),
  changeSitePagePath: mocks.changePath,
}));
vi.mock("@/lib/site-cms-audit", () => ({ logSiteCmsAuditEvent: mocks.audit }));

import { SitePagePathChangeError } from "@/db/site-pages";
import { PhiCmsAuditEvent } from "@/lib/constants/phi-cms";
import { POST } from "./route";

function authorized() {
  mocks.builderContext.mockResolvedValue({
    error: null,
    context: { site: { id: 31, key: "skeleton" }, session: { userId: 7 } },
  });
}

function request(body: unknown) {
  return new NextRequest("https://site.test/api/site/cms/pages/18/path", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = (scopeId = "18") => ({ params: Promise.resolve({ scopeId }) });

const result = {
  pageScopeId: 18,
  areaMask: 1,
  path: "/kontakt",
  pendingPath: "/kontakt-neu",
  publishedRevisionId: 184,
  workingDraftRevisionId: 190,
  references: { total: 3, bySource: { page: 2, navigation: 0, content: 0, area: 1 } },
};

/*
 * The command surface in front of the path change. What it has to get right is narrow but load-bearing:
 * an operator reads the affected-reference count out of the audit trail to judge a rename, and a client
 * distinguishes "that Page is gone" from "that path is taken" by the status alone.
 */
describe("The Page path change command", () => {
  it("reports the affected references to the audit trail, with the live and the pending path", async () => {
    authorized();
    mocks.changePath.mockResolvedValue(result);
    const response = await POST(request({ area: "public", path: "/kontakt-neu" }), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(result);
    expect(mocks.audit).toHaveBeenCalledWith(
      PhiCmsAuditEvent.PagePathChanged,
      expect.objectContaining({
        siteKey: "skeleton",
        area: "public",
        userId: 7,
        targetType: "page_scope",
        targetId: 18,
        meta: { path: "/kontakt", pendingPath: "/kontakt-neu", references: result.references },
      }),
    );
  });

  it("names the Area the Scope is addressed in", async () => {
    authorized();
    mocks.changePath.mockResolvedValue(result);
    await POST(request({ area: "Admin", path: "/team" }), params("42"));
    // The Area arrives as a key and reaches the write as its mask.
    expect(mocks.changePath).toHaveBeenCalledWith(31, 8, 42, "/team");
  });

  it("separates a missing Page from a taken path from a rejected one", async () => {
    for (const [code, status] of [
      ["page_not_found", 404],
      ["path_collision", 409],
      ["module_owned", 400],
      ["invalid_path", 400],
    ] as const) {
      authorized();
      mocks.changePath.mockRejectedValue(new SitePagePathChangeError(code, "no"));
      const response = await POST(request({ area: "public", path: "/x" }), params());
      expect(response.status, code).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code });
    }
  });

  it("does not audit a change that never happened", async () => {
    authorized();
    mocks.changePath.mockRejectedValue(new SitePagePathChangeError("path_collision", "no"));
    await POST(request({ area: "public", path: "/x" }), params());
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses a request that does not name a Scope, an Area, and a path", async () => {
    for (const [body, scopeId] of [
      [{ area: "public", path: "/x" }, "0"],
      [{ area: "public", path: "/x" }, "not-a-number"],
      [{ area: "nowhere", path: "/x" }, "18"],
      [{ path: "/x" }, "18"],
      [{ area: "public" }, "18"],
      [{ area: "public", path: 7 }, "18"],
    ] as const) {
      authorized();
      mocks.changePath.mockResolvedValue(result);
      const response = await POST(request(body), params(scopeId));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(mocks.changePath).not.toHaveBeenCalled();
    }
  });

  it("never reaches the write without the structure-authoring role", async () => {
    mocks.builderContext.mockResolvedValue({
      error: new Response(null, { status: 403 }),
      context: null,
    });
    const response = await POST(request({ area: "public", path: "/x" }), params());
    expect(response.status).toBe(403);
    expect(mocks.changePath).not.toHaveBeenCalled();
  });
});
