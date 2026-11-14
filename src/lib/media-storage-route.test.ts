import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ open: async (): Promise<unknown> => ({}) }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/media-storage", () => ({ createPhisMediaStorageServiceForProfile: () => state.open() }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: () => undefined }));

const { PhiServiceProviderUnavailableError } = await import("@/lib/addons/services");
const { openPhisMediaStorageForRoute } = await import("./media-storage-route");

const profile = { providerId: "@phis/storage-s3/s3", config: null, siteId: 1 } as const;

describe("opening a Storage Profile for a route", () => {
  it("answers a named 503 when this Instance lacks the Provider", async () => {
    state.open = async () => {
      throw new PhiServiceProviderUnavailableError("media-storage", profile.providerId, "no installed Add-on declares it");
    };
    const opened = await openPhisMediaStorageForRoute(profile, "phis");
    expect(opened.storage).toBeNull();
    expect(opened.refusal?.status).toBe(503);
    await expect(opened.refusal?.json()).resolves.toMatchObject({ error: "storage_provider_unavailable" });
  });

  it("lets any other failure through, which is not this refusal's to name", async () => {
    state.open = async () => {
      throw new Error("boom");
    };
    await expect(openPhisMediaStorageForRoute(profile, "phis")).rejects.toThrow("boom");
  });

  it("hands over the Service when it opens", async () => {
    const service = {};
    state.open = async () => service;
    await expect(openPhisMediaStorageForRoute(profile, "phis")).resolves.toEqual({ storage: service, refusal: null });
  });
});
