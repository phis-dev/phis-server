import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  publish: vi.fn(),
  withdraw: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSitePublisherApiContext: mocks.guard,
}));
vi.mock("@/db/site-content", () => ({
  publishSiteContentNews: mocks.publish,
  withdrawSiteContentNews: mocks.withdraw,
}));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: vi.fn() }));

import { DELETE, POST } from "./route";

const SITE = { id: 4, key: "example", sourceLocale: "en" };

function request(method: string, body?: unknown, query = "") {
  return new NextRequest(`https://server.test/api/site/editor/news/publish${query}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ context: { site: SITE, session: { userId: 9 } }, error: null });
  mocks.publish.mockResolvedValue({
    contentId: 12, status: 1, publishedAt: "2026-09-30T10:00:00.000Z", expiresAt: null,
  });
  mocks.withdraw.mockResolvedValue(true);
});

describe("POST /api/site/editor/news/publish", () => {
  it("publishes with no dates at all, which means now and forever", async () => {
    const response = await POST(request("POST", { contentId: 12 }));

    expect(response.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith({
      siteId: 4, contentId: 12, publishedAt: null, expiresAt: null,
    });
  });

  it("carries both dates through as instants", async () => {
    const publishedAt = "2026-10-01T08:00:00.000Z";
    const expiresAt = "2026-10-08T08:00:00.000Z";
    await POST(request("POST", { contentId: 12, publishedAt, expiresAt }));

    expect(mocks.publish).toHaveBeenCalledWith({
      siteId: 4, contentId: 12, publishedAt, expiresAt,
    });
  });

  it("refuses an entry that would expire before it appeared", async () => {
    const response = await POST(request("POST", {
      contentId: 12,
      publishedAt: "2026-10-08T08:00:00.000Z",
      expiresAt: "2026-10-01T08:00:00.000Z",
    }));

    expect(response.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses an expiry that has already passed, without a publication date to lean on", async () => {
    const response = await POST(request("POST", { contentId: 12, expiresAt: "2020-01-01T00:00:00.000Z" }));

    expect(response.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses a date that is not one", async () => {
    const response = await POST(request("POST", { contentId: 12, publishedAt: "next tuesday" }));

    expect(response.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("answers 404 for an entry with nothing to publish", async () => {
    mocks.publish.mockResolvedValueOnce(null);
    expect((await POST(request("POST", { contentId: 12 }))).status).toBe(404);
  });

  it("needs the publishing role, not the authoring one", async () => {
    mocks.guard.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Forbidden." }, { status: 403 }),
    });
    expect((await POST(request("POST", { contentId: 12 }))).status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/site/editor/news/publish", () => {
  it("withdraws the publication and answers 404 for an entry nobody has", async () => {
    expect((await DELETE(request("DELETE", undefined, "?contentId=12"))).status).toBe(200);
    expect(mocks.withdraw).toHaveBeenCalledWith({ siteId: 4, contentId: 12 });

    mocks.withdraw.mockResolvedValueOnce(false);
    expect((await DELETE(request("DELETE", undefined, "?contentId=12"))).status).toBe(404);
  });

  it("needs an id to withdraw anything", async () => {
    expect((await DELETE(request("DELETE"))).status).toBe(400);
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});
