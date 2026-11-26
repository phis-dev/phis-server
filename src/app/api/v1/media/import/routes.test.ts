import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({
  getPhisConfigSync: vi.fn(),
  site: vi.fn(),
  folder: vi.fn(),
  file: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/site-media-import", () => ({
  ensureSiteMediaImportFolder: mocks.folder,
  importSiteMediaFile: mocks.file,
}));

import { POST as importRoute } from "./route";
import { POST as folderRoute } from "./folder/route";

/*
 * `phis media import` writes the Site's library on the operator's word: internal token only, as the Module
 * media routes, checked before the Site is even looked up.
 */
describe("the media import routes' internal-token guard", () => {
  const routes = [
    ["POST /api/v1/media/import", (headers: HeadersInit) => importRoute(new Request("https://core.test/api/v1/media/import?name=a.png", { method: "POST", headers, body: "x" }))],
    ["POST /api/v1/media/import/folder", (headers: HeadersInit) => folderRoute(new Request("https://core.test/x", { method: "POST", headers, body: JSON.stringify({ path: ["A"] }) }))],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPhisConfigSync.mockReturnValue({ api: { internalToken: "internal-token", publicToken: "public-token", disableRateLimit: true } } as PhisConfig);
    mocks.site.mockResolvedValue({ id: 1, key: "acme" });
    mocks.folder.mockResolvedValue({ status: "ready", folderId: 3, path: ["A"], created: [] });
    mocks.file.mockResolvedValue({ status: "created", assetId: 9, name: "a.png", contentType: "image/png", bytes: 1, folderId: null });
  });

  for (const [name, call] of routes) {
    it(`${name} refuses no token and the public token, before anything else happens`, async () => {
      for (const headers of <Record<string, string>[]>[
        { "user-agent": "t", "x-phis-site-key": "acme" },
        { "user-agent": "t", "x-phis-site-key": "acme", "x-phis-token": "public-token" },
        { "user-agent": "t", "x-phis-site-key": "acme", "x-phis-token": "wrong" },
      ]) {
        expect((await call(headers)).status).toBe(403);
      }
      expect(mocks.site).not.toHaveBeenCalled();
      expect(mocks.folder).not.toHaveBeenCalled();
      expect(mocks.file).not.toHaveBeenCalled();
    });

    it(`${name} answers 404 for a Site it does not know, and runs with the internal token`, async () => {
      mocks.site.mockResolvedValueOnce(null);
      const headers = { "user-agent": "t", "x-phis-token": "internal-token", "x-phis-site-key": "acme", "content-length": "1" };
      expect((await call(headers)).status).toBe(404);
      const ok = await call(headers);
      expect(ok.status).toBe(200);
      expect((await ok.json()).result.status).toMatch(/ready|created/);
    });
  }
});
