import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  builderContext: vi.fn(),
  saveDraft: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/guards/site-admin-api")>()),
  requireSiteBuilderApiContext: mocks.builderContext,
}));
// The error classes stay real: the route decides the answer from `instanceof`.
vi.mock("@/db/site-pages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/site-pages")>()),
  saveSitePageDraftRevision: mocks.saveDraft,
  // A new path has neither a draft nor a published tree to take the meta from.
  getSiteCurrentPageDraft: vi.fn(async () => null),
  getResolvedSitePageTree: vi.fn(async () => null),
}));
vi.mock("@/lib/site-cms-audit", () => ({ logSiteCmsAuditEvent: mocks.audit }));

import { SitePageExistsError, SitePagePathChangeError } from "@/db/site-pages";
import { readPhiPageReference } from "@/lib/internal-references";
import { POST } from "./route";

function authorized() {
  mocks.builderContext.mockResolvedValue({
    error: null,
    context: { site: { id: 31, key: "skeleton", sourceLocale: "en" }, session: { userId: 7 } },
  });
}

function request(path = "/about") {
  return new NextRequest("https://site.test/api/site/cms/page/create", {
    method: "POST",
    body: JSON.stringify({
      area: "public",
      path,
      sourcePreset: null,
      page: {
        status: 1,
        flags: 0,
        visibilityMask: 1,
        heroRootLayoutNodeId: null,
        headerBottomRootLayoutNodeId: null,
        siderRightRootLayoutNodeId: null,
        contentRootLayoutNodeId: null,
        footerTopRootLayoutNodeId: null,
        drawerRightRootLayoutNodeId: null,
        layoutConfig: { pageRegionConfigs: {} },
      },
      overlays: [],
      layoutNodes: [],
      contentWidgets: [],
      controllerSettings: [],
    }),
  });
}

/*
 * The create command in front of the draft save. What it adds over a plain save is one decision: a path
 * that a Page already holds is answered with that Page, so the Builder can open it instead of writing a
 * blank draft over it.
 */
describe("The Page create command", () => {
  it("saves the draft in create-only mode", async () => {
    authorized();
    mocks.saveDraft.mockResolvedValue({
      revisionId: 501,
      path: "/about",
      areaMask: 1,
      draft: { revisionId: 501, version: 1, nextNodeSequence: 1 },
      sourcePreset: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.saveDraft.mock.calls[0]?.[2]).toMatchObject({ createOnly: true, createdByUserId: 7 });
  });

  it("answers page_exists with the Page that holds the path", async () => {
    authorized();
    mocks.saveDraft.mockRejectedValue(new SitePageExistsError(18, "/about", false));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ error: "page_exists", page: { id: 18, path: "/about", tombstoned: false } });
    expect(readPhiPageReference(body.page.reference)?.target).toEqual({ kind: "site", pageScopeId: 18 });
  });

  it("answers path_nested as a conflict with the code the Builder can act on", async () => {
    authorized();
    mocks.saveDraft.mockRejectedValue(new SitePagePathChangeError("path_nested", "A Page is never a folder."));

    const response = await POST(request("/about/team"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "path_nested", message: "A Page is never a folder." });
  });
});
