import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

/**
 * A request, a hook and a command hand the handler the Site's zone as the Site's record holds it.
 *
 * The record is stood in for here; that the readers fill it from `phis.sites.time_zone`, with `UTC` for
 * a Site that never named one, is `site-time-zone.pg.test.ts`'s to show.
 */

const state = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  seen: [] as Array<{ kind: string; site: unknown }>,
}));
const entry = vi.hoisted(() => {
  const manifest = {
    addonId: "@acme/days",
    requiredCoreCapabilities: [],
    apiRoutes: [{ id: "day", method: "GET", path: "day", handler: "day", auth: "internal", siteScoped: true }],
    hooks: [{ id: "ping", method: "POST", path: "ping", handler: "ping", bodyLimitBytes: 1024, rateLimitClass: "hook", timeoutMs: 5_000, siteScoped: true }],
    jobs: [],
    commands: [{ id: "day.show", handler: "showDay", description: "Shows the Site's day." }],
  };
  const respond = (kind: string) => (context: { site: unknown }) => {
    state.seen.push({ kind, site: context.site });
    return Response.json({ ok: true });
  };
  const phisAddon = {
    manifest,
    apiHandlers: { day: respond("request") },
    hookHandlers: { ping: respond("hook") },
    commandHandlers: { showDay: (context: { site: unknown }) => { state.seen.push({ kind: "command", site: context.site }); return null; } },
  };
  return { enabled: true, manifest, manifestDigest: "digest", load: async () => ({ phisAddon }) };
});

vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: () => ({ "@acme/days": entry }),
  readPhisAddonServability: () => "ok",
  isPhisAddonRuntimeManifestCurrent: () => true,
}));
vi.mock("@/lib/addons/registry-state", () => ({ verifyPhisAddonRegistryState: async () => "ready" }));
vi.mock("@/lib/addons/capabilities", () => ({ buildPhisAddonCapabilities: () => ({}) }));
vi.mock("@/lib/addons/core-capabilities", () => ({ isPhisAddonCapabilityDeliverable: () => true }));
vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => null, getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/site-context", () => ({ requireSiteFromRequest: async () => state.site }));

import { dispatchPhisAddonRequest } from "./dispatcher";
import { runPhisAddonCommand } from "./commands";

const cases = [
  { label: "Europe/Zurich", timeZone: "Europe/Zurich" },
  { label: "UTC", timeZone: "UTC" },
];

function lastSeen(kind: string) {
  return state.seen.filter((entry) => entry.kind === kind).at(-1)?.site;
}

describe("the Site's zone on a request, a hook and a command", () => {
  beforeEach(() => {
    state.seen.length = 0;
  });

  it.each(cases)("reaches a request and a hook handler ($label)", async ({ timeZone }) => {
    state.site = {
      id: 3, key: "days", name: "Days", sourceLocale: "en", defaultLocale: "en", flags: 1,
      publicBaseUrl: "https://days.example", timeZone,
    };
    const headers = { "x-phis-site-key": "days" };
    const request = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/addons/acme/days/day", { method: "GET", headers }),
      "api",
      { scope: "acme", name: "days", path: ["day"] },
    );
    expect(request.status).toBe(200);
    // Exactly these four: the rest of the Site's record is Core's, not the handler's.
    expect(lastSeen("request")).toEqual({ id: 3, key: "days", publicBaseUrl: "https://days.example", timeZone });

    const hook = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/hooks/acme/days/ping", { method: "POST", headers, body: "{}" }),
      "hook",
      { scope: "acme", name: "days", path: ["ping"] },
    );
    expect(hook.status).toBe(200);
    expect(lastSeen("hook")).toEqual({ id: 3, key: "days", publicBaseUrl: "https://days.example", timeZone });
  });

  it.each(cases)("reaches a command handler ($label)", async ({ timeZone }) => {
    const site = { id: 3, key: "days", publicBaseUrl: "https://days.example", timeZone };
    const outcome = await runPhisAddonCommand({ addonId: "@acme/days", commandId: "day.show", site, actorUserId: 9, input: null });
    expect(outcome.ok).toBe(true);
    expect(lastSeen("command")).toEqual(site);
  });
});
