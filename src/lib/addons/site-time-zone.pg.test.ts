import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { PhisAddonManifestV1 } from "@phis/contracts/addon";

import {
  activatePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../../test/pg/harness";

/**
 * Every context an Add-on handler receives names the Site's zone, read from the Site's own row.
 *
 * The rows are real -- one Site in Europe/Zurich, one that never named a zone and is therefore UTC by
 * the column's default -- and so are the readers each context is built from: `getSiteByKey` for a
 * request and a hook, `getSiteIdentityById` for an event and a job, `getPhiCliSiteByKey` for a command.
 * Only the loaded build, the registry's verdict and the capabilities are stood in for, because none of
 * them has anything to say about a zone.
 */

const ADDON_ID = "@pgtest/time-zone";
const EMITTED_EVENT = `${ADDON_ID}:day.closed`;

const seen = vi.hoisted(() => [] as Array<{ kind: string; site: unknown }>);
const entry = vi.hoisted(() => {
  const manifest = {
    manifestVersion: 1,
    addonId: "@pgtest/time-zone",
    packageName: "@pgtest/time-zone",
    packageVersion: "0.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [{ id: "day", method: "GET", path: "day", handler: "day", auth: "internal", siteScoped: true }],
    hooks: [{
      id: "ping", method: "POST", path: "ping", handler: "ping", bodyLimitBytes: 1024, rateLimitClass: "hook",
      timeoutMs: 5_000, siteScoped: true,
    }],
    jobs: [{ id: "close-day", handler: "closeDay" }],
    commands: [{ id: "day.show", handler: "showDay", description: "Shows the Site's day." }],
    eventHandlers: [{ id: "closed", event: "@pgtest/time-zone:day.closed", handler: "closed" }],
    schema: null,
    migrationVersion: 0,
  } as unknown as PhisAddonManifestV1;
  const record = (kind: string) => (context: { site: unknown }) => {
    seen.push({ kind, site: context.site });
  };
  const phisAddon = {
    manifest,
    apiHandlers: { day: (context: { site: unknown }) => { record("request")(context); return Response.json({ ok: true }); } },
    hookHandlers: { ping: (context: { site: unknown }) => { record("hook")(context); return Response.json({ ok: true }); } },
    jobHandlers: { closeDay: record("job") },
    commandHandlers: { showDay: (context: { site: unknown }) => { record("command")(context); return { ok: true }; } },
    eventHandlers: { closed: record("event") },
  };
  return { flags: 1, manifest, manifestDigest: "pgtest", load: async () => ({ phisAddon }) };
});

vi.mock("@/lib/addons/installed", () => ({
  getPhisAddonInstalledManifest: () => ({ [entry.manifest.addonId]: entry }),
  readPhisAddonServability: () => "ok",
  isPhisAddonRuntimeManifestCurrent: () => true,
}));
vi.mock("@/lib/addons/registry-state", () => ({ verifyPhisAddonRegistryState: async () => "ready" }));
vi.mock("@/lib/addons/capabilities", () => ({ buildPhisAddonCapabilities: () => ({}) }));
vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => null, getClientIp: () => "127.0.0.1" }));

import { dispatchPhisAddonRequest } from "./dispatcher";
import { deliverPhisAddonEvents } from "./event-delivery";
import { runPhiJobNow } from "@/lib/jobs/scheduler";
import { POST as runCommand } from "@/app/api/v1/addons/commands/route";

describe("the Site's zone in every Add-on context", () => {
  let zurich: PhiTestSite;
  let unnamed: PhiTestSite;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    zurich = await createPhiTestSite("tz-zurich");
    unnamed = await createPhiTestSite("tz-unnamed");
    // A request resolves only an active Site (flag 1); the zone of the second is the column's default.
    await pool.query(`UPDATE phis.sites SET flags = flags | 1 WHERE id = ANY($1::int[])`, [[zurich.id, unnamed.id]]);
    await pool.query(`UPDATE phis.sites SET time_zone = 'Europe/Zurich' WHERE id = $1`, [zurich.id]);
    await activatePhiTestAddonForSite(zurich, ADDON_ID);
    await activatePhiTestAddonForSite(unnamed, ADDON_ID);
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.job_states WHERE owner = $1`, [ADDON_ID]);
    await dropPhiTestSites();
    await pool.query(`DELETE FROM phis.server_addons WHERE addon_id = $1`, [ADDON_ID]);
    await closePhiTestPool();
  });

  const cases = [
    { label: "a Site in Europe/Zurich", site: () => zurich, timeZone: "Europe/Zurich" },
    { label: "a Site that never named a zone", site: () => unnamed, timeZone: "UTC" },
  ];

  function lastSeen(kind: string) {
    const found = seen.filter((entry) => entry.kind === kind).at(-1);
    expect(found, `no ${kind} handler ran`).toBeDefined();
    return found!.site as { id: number; key: string; timeZone: string };
  }

  it.each(cases)("reaches a request and a hook handler on $label", async ({ site, timeZone }) => {
    const headers = { "x-phis-site-key": site().key };
    const request = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/addons/pgtest/time-zone/day", { method: "GET", headers }),
      "api",
      { scope: "pgtest", name: "time-zone", path: ["day"] },
    );
    expect(request.status).toBe(200);
    expect(lastSeen("request")).toEqual({ id: site().id, key: site().key, publicBaseUrl: `https://${site().key}.invalid`, timeZone, sourceLocale: "en" });

    const hook = await dispatchPhisAddonRequest(
      new NextRequest("http://localhost/api/hooks/pgtest/time-zone/ping", { method: "POST", headers, body: "{}" }),
      "hook",
      { scope: "pgtest", name: "time-zone", path: ["ping"] },
    );
    expect(hook.status).toBe(200);
    expect(lastSeen("hook")).toEqual({ id: site().id, key: site().key, publicBaseUrl: `https://${site().key}.invalid`, timeZone, sourceLocale: "en" });
  });

  it.each(cases)("reaches an event handler on $label", async ({ site, timeZone }) => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.addon_event_outbox (site_id, addon_id, event, subject_kind, emitter, payload)
       VALUES ($1, $2, $3, 'emitted', $2, '{"facts":{}}'::jsonb)`,
      [site().id, ADDON_ID, EMITTED_EVENT],
    );
    expect(await deliverPhisAddonEvents({ addonId: ADDON_ID, siteId: site().id })).toEqual({ delivered: 1, failed: 0 });
    expect(lastSeen("event")).toEqual({ id: site().id, key: site().key, timeZone });
  });

  it.each(cases)("reaches a job handler on $label, through the scheduler's ledger", async ({ site, timeZone }) => {
    const outcome = await runPhiJobNow({ owner: ADDON_ID, jobId: "close-day", siteId: site().id });
    expect(outcome).toMatchObject({ ok: true, error: null });
    expect(lastSeen("job")).toEqual({ id: site().id, key: site().key, timeZone });
  });

  it.each(cases)("reaches a command handler on $label, through the internal route", async ({ site, timeZone }) => {
    const userId = await createPhiTestUser(site());
    const response = await runCommand(new NextRequest("http://localhost/api/v1/addons/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addonId: ADDON_ID, commandId: "day.show", siteKey: site().key, as: String(userId) }),
    }));
    expect(response.status).toBe(200);
    expect(lastSeen("command")).toEqual({ id: site().id, key: site().key, publicBaseUrl: `https://${site().key}.invalid`, timeZone, sourceLocale: "en" });
  });
});
