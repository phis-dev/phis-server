import { describe, expect, it } from "vitest";

import { validatePhisAddonManifest } from "./manifest.ts";

/**
 * What a manifest may say about when its jobs run and which events it emits (SERVER_ADDONS.md, Jobs
 * and Events). Both are read by Core at runtime with nobody there to report a typo, so the shape is
 * refused at install.
 */

function manifest(extra: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    addonId: "@acme/status",
    packageName: "@acme/status",
    packageVersion: "1.0.0",
    serverAbi: "^1",
    capabilities: [],
    serviceProviders: [],
    requiredCoreCapabilities: [],
    apiRoutes: [],
    hooks: [],
    jobs: [],
    schema: null,
    migrationVersion: 0,
    ...extra,
  };
}

describe("a job's schedule", () => {
  it("is optional, and admits every step of the catalogue", () => {
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync" }] })).issues).toEqual([]);
    for (const every of ["5m", "15m", "30m", "hourly"]) {
      expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every } }] })).issues).toEqual([]);
    }
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "daily", at: "04:15" } }] })).issues).toEqual([]);
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "weekly", at: "06:00", weekday: 7 } }] })).issues).toEqual([]);
  });

  it("refuses a step below five minutes, a time on a short step and a weekday on a daily one", () => {
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "1m" } }] })).issues)
      .toEqual([expect.stringContaining("jobs[0].schedule.every must be one of")]);
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "5m", at: "04:15" } }] })).issues)
      .toEqual(["jobs[0].schedule.at is only for the daily and weekly steps."]);
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "daily", weekday: 1 } }] })).issues)
      .toEqual(["jobs[0].schedule.weekday is only for the weekly step."]);
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: { every: "daily", at: "4:15" } }] })).issues)
      .toEqual(["jobs[0].schedule.at must be a time of day, HH:MM in UTC."]);
    expect(validatePhisAddonManifest(manifest({ jobs: [{ id: "sync", handler: "sync", schedule: "daily" }] })).issues)
      .toEqual(["jobs[0].schedule must be an object."]);
  });
});

describe("the events an Add-on emits and listens to", () => {
  it("admits an emitted event under the Add-on's own id, and a handler for another Add-on's", () => {
    const result = validatePhisAddonManifest(manifest({
      emits: [{ id: "@acme/status:status.changed", description: "The status moved.", audience: "stage" }],
      eventHandlers: [{ id: "orders", event: "@acme/shop:order.placed", handler: "onOrder" }],
    }));
    expect(result.issues).toEqual([]);
    expect(result.manifest?.emits?.[0]?.id).toBe("@acme/status:status.changed");
  });

  it("refuses an emitted event named under somebody else, a bare name, and an unknown audience", () => {
    expect(validatePhisAddonManifest(manifest({ emits: [{ id: "@acme/shop:order.placed" }] })).issues)
      .toEqual(["emits[0].id names @acme/shop as emitter, not this Add-on."]);
    expect(validatePhisAddonManifest(manifest({ emits: [{ id: "status.changed" }] })).issues)
      .toEqual([expect.stringContaining("emits[0].id must be this Add-on's id")]);
    expect(validatePhisAddonManifest(manifest({ emits: [{ id: "@acme/status:Status" }] })).issues)
      .toEqual([expect.stringContaining("emits[0].id must be this Add-on's id")]);
    expect(validatePhisAddonManifest(manifest({ emits: [{ id: "@acme/status:a", audience: "everyone" }] })).issues)
      .toEqual(['emits[0].audience must be "stage" or "self".']);
    expect(validatePhisAddonManifest(manifest({ emits: [{ id: "@acme/status:a" }, { id: "@acme/status:a" }] })).issues)
      .toEqual([expect.stringContaining("emits")]);
  });

  it("still refuses a handler for a name nobody emits", () => {
    expect(validatePhisAddonManifest(manifest({ eventHandlers: [{ id: "x", event: "status.changed", handler: "x" }] })).issues)
      .toEqual([expect.stringContaining("eventHandlers[0].event is neither")]);
  });
});
