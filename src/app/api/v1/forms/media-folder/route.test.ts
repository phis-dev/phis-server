import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  clearCache: vi.fn(),
  createFolder: vi.fn(),
  ensureSiteSpace: vi.fn(),
  findPath: vi.fn(),
  guard: vi.fn(),
  locked: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/db/media", () => ({
  createMediaFolder: mocks.createFolder,
  findMediaFolderPathId: mocks.findPath,
  hasLockedMediaFolder: mocks.locked,
}));
vi.mock("@/db/site-config", () => ({ clearSiteConfigCache: mocks.clearCache }));
vi.mock("@/db/media-spaces", () => ({ ensureSiteMediaSpace: mocks.ensureSiteSpace }));
vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteMediaApiContext: mocks.guard }));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: mocks.log,
  normalizeLogThrowable: (error: unknown) => error,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("https://server.test/api/v1/forms/media-folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locked.mockResolvedValue(false);
  mocks.guard.mockResolvedValue({
    context: {
      site: { id: 7, key: "example" },
      session: { userId: 3 },
      siteRole: { enabled: true },
      tokenMode: "internal",
    },
    error: null,
  });
  mocks.findPath.mockResolvedValue(9);
  mocks.ensureSiteSpace.mockResolvedValue({ space: { id: 4, siteId: 7, kind: 1 } });
  mocks.createFolder.mockResolvedValue({ id: 12, siteId: 7, spaceId: 4, parentId: 9, name: "Campaign" });
});

describe("POST /api/v1/forms/media-folder", () => {
  it("requires the Site Builder context", async () => {
    mocks.guard.mockResolvedValueOnce({
      context: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const response = await POST(request({ name: "Campaign", parentPath: "/Products" }));
    expect(response.status).toBe(403);
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("creates a Folder below an existing parent path", async () => {
    const response = await POST(request({ name: " Campaign ", parentPath: "/Products/Summer" }));
    expect(response.status).toBe(200);
    expect(mocks.findPath).toHaveBeenCalledWith(7, 4, ["Products", "Summer"]);
    expect(mocks.createFolder).toHaveBeenCalledWith({
      siteId: 7,
      spaceId: 4,
      parentId: 9,
      name: "Campaign",
      sortOrder: 0,
      flags: 0,
    });
    expect(mocks.clearCache).toHaveBeenCalledWith(7);
  });

  it("creates nothing in a locked parent", async () => {
    mocks.locked.mockResolvedValueOnce(true);

    const response = await POST(request({ name: "Campaign", parentPath: "/Products/Summer" }));

    expect(response.status).toBe(409);
    expect(mocks.locked).toHaveBeenCalledWith(7, 4, [9]);
    expect(mocks.createFolder).not.toHaveBeenCalled();
  });

  it("supports the top level and rejects invalid or missing parents", async () => {
    const topLevel = await POST(request({ name: "Campaign", parentPath: "/" }));
    expect(topLevel.status).toBe(200);
    expect(mocks.createFolder).toHaveBeenLastCalledWith(expect.objectContaining({ spaceId: 4, parentId: null }));

    const invalidName = await POST(request({ name: "Nested/Group", parentPath: "/" }));
    expect(invalidName.status).toBe(400);

    mocks.findPath.mockResolvedValueOnce(null);
    const missingParent = await POST(request({ name: "Campaign", parentPath: "/Missing" }));
    expect(missingParent.status).toBe(404);
  });

  it("returns a conflict for duplicate sibling names and logs unexpected failures", async () => {
    mocks.createFolder.mockRejectedValueOnce({ code: "23505" });
    const duplicate = await POST(request({ name: "Campaign", parentPath: "/Products" }));
    expect(duplicate.status).toBe(409);
    expect(mocks.log).not.toHaveBeenCalled();

    mocks.createFolder.mockRejectedValueOnce(new Error("database unavailable"));
    const failure = await POST(request({ name: "Campaign", parentPath: "/Products" }));
    expect(failure.status).toBe(500);
    expect(mocks.log).toHaveBeenCalledWith(
      "error",
      "media.folder.form_create_failed",
      expect.objectContaining({ siteKey: "example", userId: 3 }),
    );
  });
});
