import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * `HEAD` on an Add-on's route or hook: no descriptor declares it, so it is answered by the `GET` of the
 * same path. The handler is told `HEAD`, so it can leave out what a `GET` does besides answering, and the
 * body it answers with is dropped.
 */

const state = vi.hoisted(() => ({ seen: [] as Array<{ kind: string; method: string }> }));
const entry = vi.hoisted(() => {
  const manifest = {
    addonId: "@acme/files",
    requiredCoreCapabilities: [],
    apiRoutes: [
      { id: "download", method: "GET", path: "download/:file", handler: "download", auth: "internal", siteScoped: true },
      { id: "upload", method: "POST", path: "upload", handler: "upload", auth: "internal", siteScoped: true },
    ],
    hooks: [{ id: "catalogue", method: "GET", path: "catalogue", handler: "catalogue", siteScoped: true }],
    jobs: [],
    commands: [],
  };
  const respond = (kind: string) => (context: { method: string }) => {
    state.seen.push({ kind, method: context.method });
    return new Response(JSON.stringify({ moved: true }), {
      status: 302,
      headers: { location: "https://files.example.com/a.deb", "cache-control": "no-store", "content-type": "application/json" },
    });
  };
  const phisAddon = {
    manifest,
    apiHandlers: { download: respond("request"), upload: respond("upload") },
    hookHandlers: { catalogue: respond("hook") },
  };
  return { enabled: true, manifest, manifestDigest: "digest", load: async () => ({ phisAddon }) };
});

vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: () => ({ "@acme/files": entry }),
  readPhisAddonServability: () => "ok",
  isPhisAddonRuntimeManifestCurrent: () => true,
}));
vi.mock("@/lib/addons/registry-state", () => ({ verifyPhisAddonRegistryState: async () => "ready" }));
vi.mock("@/lib/addons/capabilities", () => ({ buildPhisAddonCapabilities: () => ({}) }));
vi.mock("@/lib/addons/core-capabilities", () => ({ isPhisAddonCapabilityDeliverable: () => true }));
vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => null, getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/site-context", () => ({
  requireSiteFromRequest: async () => ({
    id: 3, key: "files", name: "Files", sourceLocale: "en", defaultLocale: "en", flags: 1,
    publicBaseUrl: "https://files.example", timeZone: "UTC",
  }),
}));

import { dispatchPhisAddonRequest } from "./dispatcher";

const headers = { "x-phis-site-key": "files" };
const params = (path: string[]) => ({ scope: "acme", name: "files", path });

describe("HEAD on an Add-on's routes and hooks", () => {
  beforeEach(() => {
    state.seen.length = 0;
  });

  it("answers a route's HEAD from its GET handler, told HEAD, with the same status and headers and no body", async () => {
    const get = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/v1/addons/acme/files/download/a.deb", { method: "GET", headers }),
      "api",
      params(["download", "a.deb"]),
    );
    const head = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/v1/addons/acme/files/download/a.deb", { method: "HEAD", headers }),
      "api",
      params(["download", "a.deb"]),
    );
    expect(state.seen).toEqual([{ kind: "request", method: "GET" }, { kind: "request", method: "HEAD" }]);
    expect(await get.text()).toBe(JSON.stringify({ moved: true }));
    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe("https://files.example.com/a.deb");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("x-request-id")).toBeTruthy();
    expect(head.body).toBeNull();
  });

  it("answers a hook's HEAD from its GET handler", async () => {
    const head = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/v1/hooks/acme/files/catalogue", { method: "HEAD", headers }),
      "hook",
      params(["catalogue"]),
    );
    expect(head.status).toBe(302);
    expect(head.body).toBeNull();
    expect(state.seen).toEqual([{ kind: "hook", method: "HEAD" }]);
  });

  it("does not reach a route declared for another method, and answers a miss without a body", async () => {
    const head = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/v1/addons/acme/files/upload", { method: "HEAD", headers }),
      "api",
      params(["upload"]),
    );
    expect(head.status).toBe(404);
    expect(head.body).toBeNull();
    expect(state.seen).toEqual([]);
  });
});
