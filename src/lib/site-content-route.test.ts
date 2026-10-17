import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  publisher: vi.fn(),
  save: vi.fn(),
  publish: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/guards/site-admin-api", () => ({
  requireSiteReviewApiContext: async () => ({
    context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
    error: null,
  }),
  requireSitePublisherApiContext: mocks.publisher,
}));
vi.mock("@/db/media", () => ({ getMediaAssetBySiteAndId: vi.fn() }));
vi.mock("@/db/site-widget-content", async () => {
  class SiteContentConflictError extends Error {
    contentId: number;
    currentVersionId: number | null;
    constructor(contentId: number, currentVersionId: number | null) {
      super("conflict");
      this.contentId = contentId;
      this.currentVersionId = currentVersionId;
    }
  }
  return {
    SiteContentConflictError,
    isSiteWidgetContentStorage: (value: unknown) => ["text", "html", "markdown", "asset"].includes(value as string),
    saveSiteWidgetContent: mocks.save,
    publishSiteWidgetContent: mocks.publish,
    submitSiteWidgetContent: mocks.submit,
    withdrawSiteWidgetContent: vi.fn(),
    withdrawSiteWidgetContentSubmission: vi.fn(),
    readSiteWidgetContentRowsWithDb: vi.fn(),
  };
});

import { SiteContentConflictError } from "@/db/site-widget-content";
import {
  handleSiteEditorContentPublish,
  handleSiteEditorContentWrite,
} from "./site-content-route";

const INSTANCE_ID = "EgIAAAAAAAcAAAAC";

function request(method: string, path: string, body?: unknown) {
  return new NextRequest(`https://server.test${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

/** Widget content through the Editor (CONTENT.md): drafts for reviewers, publishing for Publishers. */
describe("Widget content routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.publisher.mockResolvedValue({
      context: { site: { id: 1, key: "acme" }, session: { userId: 7 } },
      error: null,
    });
  });

  it("saves a draft on the version it builds on", async () => {
    mocks.save.mockResolvedValue({ contentId: 3, versionId: 11, written: true, value: "Hallo" });
    const response = await handleSiteEditorContentWrite(request("PUT", "/api/site/editor/content", {
      instanceId: INSTANCE_ID,
      storage: "text",
      value: "Hallo",
      baseVersionId: 10,
      area: "public",
    }));
    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1,
      instanceId: INSTANCE_ID,
      storage: "text",
      baseVersionId: 10,
      referenceAreaId: 1,
      createdByUserId: 7,
    }));
  });

  it("answers 409 with the current version when somebody saved in between", async () => {
    mocks.save.mockRejectedValue(new SiteContentConflictError(3, 12));
    const response = await handleSiteEditorContentWrite(request("PUT", "/api/site/editor/content", {
      instanceId: INSTANCE_ID,
      storage: "markdown",
      value: "# Neu",
      baseVersionId: 10,
    }));
    const body = await response.json();
    expect(body).toMatchObject({ contentId: 3, currentVersionId: 12 });
    expect(response.status).toBe(409);
  });

  it("refuses an instance id that is not one, and a storage that is not one", async () => {
    for (const body of [
      { instanceId: "nope", storage: "text", value: "x" },
      { instanceId: INSTANCE_ID, storage: "json", value: "x" },
    ]) {
      expect((await handleSiteEditorContentWrite(request("PUT", "/api/site/editor/content", body))).status).toBe(400);
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("publishes only for a Publisher", async () => {
    mocks.publisher.mockResolvedValue({
      context: null,
      error: NextResponse.json({ error: "Site publisher, developer, or admin role required." }, { status: 403 }),
    });
    const response = await handleSiteEditorContentPublish(request("POST", "/api/site/editor/content/publish", {
      contentId: 3,
      versionId: 11,
    }));
    expect(response.status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("publishes the named version", async () => {
    mocks.publish.mockResolvedValue({ ok: true, contentId: 3, publishedVersionId: 11 });
    const response = await handleSiteEditorContentPublish(request("POST", "/api/site/editor/content/publish", {
      contentId: 3,
      versionId: 11,
    }));
    expect(response.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith({ siteId: 1, contentId: 3, versionId: 11 });
  });

  it("answers 409 for a version that is not the content's", async () => {
    mocks.publish.mockResolvedValue({ ok: false, reason: "version_mismatch" });
    const response = await handleSiteEditorContentPublish(request("POST", "/api/site/editor/content/publish", {
      contentId: 3,
      versionId: 99,
    }));
    expect(response.status).toBe(409);
  });
});
