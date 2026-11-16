import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PhisConfig } from "@/lib/config-core";

const mocks = vi.hoisted(() => ({
  getPhisConfigSync: vi.fn(),
  site: vi.fn(),
  folder: vi.fn(),
  file: vi.fn(),
  bind: vi.fn(),
}));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getPhisConfigSync: mocks.getPhisConfigSync,
}));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: mocks.site }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/site-module-media", () => ({
  listSiteModuleMediaFiles: async () => [],
  listSiteModuleMediaFolders: async () => [],
  isSiteModuleMediaBound: () => false,
}));
vi.mock("@/lib/module-media-import", () => ({
  importModuleMediaFolder: mocks.folder,
  importModuleMediaFile: mocks.file,
  bindModuleMedia: mocks.bind,
}));

import { GET as operatorMapping } from "./route";
import { POST as folderRoute } from "./folder/route";
import { POST as fileRoute } from "./file/route";
import { POST as bindRoute } from "./bind/route";
import { GET as siteMapping } from "../site/module-media/route";

/*
 * Every Module media route is the operator's or the Site's server's, never a browser's and never the public
 * token's: the same guard as `/api/v1/addons/jobs`, checked before the Site is even looked up.
 */
describe("the Module media routes' internal-token guard", () => {
  const routes = [
    ["GET /api/v1/module-media", (headers: HeadersInit) => operatorMapping(new Request("https://core.test/api/v1/module-media", { headers }))],
    ["POST /api/v1/module-media/folder", (headers: HeadersInit) => folderRoute(new Request("https://core.test/x", { method: "POST", headers, body: "{}" }))],
    ["POST /api/v1/module-media/file", (headers: HeadersInit) => fileRoute(new Request("https://core.test/x", { method: "POST", headers, body: "x" }))],
    ["POST /api/v1/module-media/bind", (headers: HeadersInit) => bindRoute(new Request("https://core.test/x", { method: "POST", headers, body: "{}" }))],
    ["GET /api/v1/site/module-media", (headers: HeadersInit) => siteMapping(new Request("https://core.test/api/v1/site/module-media", { headers }))],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPhisConfigSync.mockReturnValue({ api: { internalToken: "internal-token", publicToken: "public-token", disableRateLimit: true } } as PhisConfig);
    mocks.site.mockResolvedValue({ id: 1, key: "acme" });
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
      expect(mocks.bind).not.toHaveBeenCalled();
    });

    it(`${name} answers 404 for a Site it does not know, with the internal token`, async () => {
      mocks.site.mockResolvedValue(null);
      expect((await call({ "user-agent": "t", "x-phis-token": "internal-token", "x-phis-site-key": "nobody" })).status).toBe(404);
    });
  }

  it("passes the internal token on to the import, and takes only what it declares: no path in the file route", async () => {
    mocks.folder.mockResolvedValue({ kind: "folder", packageName: "@a/b", key: "k", status: "created" });
    const headers = { "user-agent": "t", "x-phis-token": "internal-token", "x-phis-site-key": "acme", "content-type": "application/json" };
    const ok = await folderRoute(new Request("https://core.test/x", {
      method: "POST", headers, body: JSON.stringify({ package: "@a/b", key: "k", name: "K" }),
    }));
    expect(ok.status).toBe(200);
    expect(mocks.folder).toHaveBeenCalledWith({ id: 1, key: "acme" }, { packageName: "@a/b", key: "k", name: "K", parentKey: null });

    // A file route that is not multipart with a `file` part is a bad request, whatever path it names.
    const bad = await fileRoute(new Request("https://core.test/x", {
      method: "POST", headers, body: JSON.stringify({ package: "@a/b", key: "k", path: "/etc/passwd" }),
    }));
    expect(bad.status).toBe(400);
    expect(mocks.file).not.toHaveBeenCalled();
  });
});
