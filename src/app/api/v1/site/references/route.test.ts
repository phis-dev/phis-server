import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { MediaAssetRecord } from "@/db/media";
import type { SitePageScopeCatalogRecord } from "@/db/site-pages";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  site: vi.fn(),
  scopes: vi.fn(),
  assets: vi.fn(),
}));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: mocks.guard, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/db/site-pages", () => ({ listSitePageScopes: mocks.scopes }));
vi.mock("@/db/media", () => ({ listPublicSiteSpaceMediaAssetsByIds: mocks.assets }));

import { createPhiPageReference } from "@/lib/internal-references";
import { POST } from "./route";

function scope(overrides: Partial<SitePageScopeCatalogRecord>): SitePageScopeCatalogRecord {
  return {
    id: 18,
    siteId: 31,
    areaMask: 1,
    path: "/kontakt",
    ownerModuleId: null,
    presetKey: null,
    tombstonedAt: null,
    publishedRevisionId: 184,
    workingDraftRevisionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as SitePageScopeCatalogRecord;
}

function asset(id: number): MediaAssetRecord {
  return {
    id,
    siteId: 31,
    contentType: "image/jpeg",
    originalName: "bild.jpg",
    deliveryRevision: 1,
    variantVersion: 1,
    width: 100,
    height: 80,
    blurDataUrl: null,
    title: null,
    altText: null,
    meta: null,
  } as MediaAssetRecord;
}

const pageUri = (pageScopeId: number) => createPhiPageReference({ kind: "site", pageScopeId });
const moduleUri = () => createPhiPageReference({
  kind: "module",
  ownerModuleId: "@phis/ui",
  presetKey: "login",
});

function request(body: unknown) {
  return new NextRequest("https://site.test/api/v1/site/references", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function resolve(body: unknown) {
  mocks.guard.mockReturnValue(null);
  mocks.site.mockResolvedValue({ id: 31, key: "skeleton" });
  const response = await POST(request(body));
  return { status: response.status, body: await response.json() };
}

/*
 * Every rendered Page and Asset reference passes through here. A Page reference names a Scope, never a
 * path, so a target that is gone, tombstoned, or simply in another Area has to come back as an answer
 * rather than as an error -- a broken link must not take a page down with it. The Asset half answers
 * from the public projection alone, which is what keeps a protected Asset from leaking through a
 * reference the Editor happens to carry.
 */
describe("Resolving internal references", () => {
  it("answers a live Page reference with its current path", async () => {
    mocks.scopes.mockResolvedValue([scope({ id: 18, path: "/kontakt" })]);
    mocks.assets.mockResolvedValue([]);
    const { status, body } = await resolve({ area: "public", references: [pageUri(18)] });
    expect(status).toBe(200);
    expect(body.resolved).toEqual([
      { reference: pageUri(18), path: "/kontakt", deleted: false, targetKind: "site" },
    ]);
  });

  it("reports a tombstoned Page as deleted and hands out no path", async () => {
    mocks.scopes.mockResolvedValue([scope({ id: 18, path: "/kontakt", tombstonedAt: "2026-08-01T00:00:00.000Z" })]);
    mocks.assets.mockResolvedValue([]);
    const { body } = await resolve({ area: "public", references: [pageUri(18)] });
    // The path is still reserved on the row, and precisely that must not be rendered as a live link.
    expect(body.resolved[0]).toMatchObject({ path: null, deleted: true });
  });

  it("reports a Scope that no longer exists as deleted rather than failing the render", async () => {
    mocks.scopes.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([]);
    const { status, body } = await resolve({ area: "public", references: [pageUri(999)] });
    expect(status).toBe(200);
    expect(body.resolved[0]).toMatchObject({ path: null, deleted: true, targetKind: "site" });
  });

  it("reports a Scope that carries a Module identity instead of a path as deleted", async () => {
    mocks.scopes.mockResolvedValue([scope({ id: 18, path: null, ownerModuleId: "@phis/ui", presetKey: "login" })]);
    mocks.assets.mockResolvedValue([]);
    const { body } = await resolve({ area: "public", references: [pageUri(18)] });
    expect(body.resolved[0]).toMatchObject({ path: null, deleted: true });
  });

  it("leaves a Module target to the Module, without calling it deleted", async () => {
    mocks.scopes.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([]);
    const { body } = await resolve({ area: "public", references: [moduleUri()] });
    expect(body.resolved[0]).toMatchObject({ path: null, deleted: false, targetKind: "module" });
  });

  it("resolves inside the named Area only", async () => {
    mocks.scopes.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([]);
    await resolve({ area: "app", references: [pageUri(18)] });
    // A Page Scope of the Public Area is not in the App Area's catalog, so the same id resolves
    // differently per Area -- which is why the Area is asked for and not inferred.
    expect(mocks.scopes).toHaveBeenCalledWith(31, 2);
  });

  it("refuses a Page reference without an Area, and asks for no catalog at all", async () => {
    const { status } = await resolve({ references: [pageUri(18)] });
    expect(status).toBe(400);
    expect(mocks.scopes).not.toHaveBeenCalled();
  });

  it("refuses a malformed Page reference instead of resolving around it", async () => {
    for (const reference of ["v1.not-base64url!!", "v1.", "", 7, null, "/kontakt"]) {
      const { status } = await resolve({ area: "public", references: [reference] });
      expect(status, JSON.stringify(reference)).toBe(400);
    }
  });
});

describe("Resolving Asset references", () => {
  it("answers from the public Site Space projection", async () => {
    mocks.scopes.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([asset(9)]);
    const { body } = await resolve({ assets: [9] });
    expect(mocks.assets).toHaveBeenCalledWith(31, [9]);
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({ id: 9, deliveryRevision: 1 });
    // The rendering projection carries no storage key and no Space, so neither can leak into a page.
    expect(Object.keys(body.assets[0])).not.toContain("storageKey");
    expect(Object.keys(body.assets[0])).not.toContain("spaceId");
  });

  it("simply omits an Asset the projection does not return", async () => {
    mocks.scopes.mockResolvedValue([]);
    // Protected, not Ready, or outside the Site Space: the projection answers with nothing, and the
    // endpoint has no second mode that would report the difference to an unauthenticated render.
    mocks.assets.mockResolvedValue([]);
    const { status, body } = await resolve({ assets: [9, 10] });
    expect(status).toBe(200);
    expect(body.assets).toEqual([]);
  });

  it("does not need an Area, because Assets are Site scoped", async () => {
    mocks.scopes.mockResolvedValue([]);
    mocks.assets.mockResolvedValue([asset(9)]);
    const { status, body } = await resolve({ assets: [9] });
    expect(status).toBe(200);
    expect(body.area).toBeNull();
    expect(mocks.scopes).not.toHaveBeenCalled();
  });

  it("refuses an Asset id that is not one", async () => {
    for (const id of [0, -1, 1.5, "9", null]) {
      const { status } = await resolve({ assets: [id] });
      expect(status, JSON.stringify(id)).toBe(400);
    }
  });

  it("refuses more than one render's worth of references", async () => {
    const many = Array.from({ length: 257 }, () => pageUri(18));
    expect((await resolve({ area: "public", references: many })).status).toBe(400);
    expect((await resolve({ assets: Array.from({ length: 257 }, (_, index) => index + 1) })).status).toBe(400);
  });

  it("answers nothing at all without the internal token", async () => {
    mocks.guard.mockReturnValue(new Response(null, { status: 401 }));
    const response = await POST(request({ assets: [9] }));
    expect(response.status).toBe(401);
    expect(mocks.assets).not.toHaveBeenCalled();
  });
});
