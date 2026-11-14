import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getPool: vi.fn(), withTransaction: vi.fn() }));
vi.mock("@/db/media-spaces", () => ({ ensureSiteMediaConfig: vi.fn(), ensureSiteMediaSpace: vi.fn() }));

const { checkSiteMediaStorageSettingsUpdate } = await import("./media-storage-settings");

const current = {
  profiles: [
    { id: 1, key: "local", providerId: "@phis/server/storage-local", local: true, disabled: false, spaces: 3 },
    { id: 2, key: "s3", providerId: "@phis/storage-s3/s3", local: false, disabled: false, spaces: 0 },
    { id: 3, key: "old", providerId: "@phis/storage-s3/s3", local: false, disabled: true, spaces: 1 },
  ],
  siteSpaceProfileId: 1,
  defaultUserProfileId: null,
  defaultGroupProfileId: null,
  allowedProfileIds: [],
};

describe("what a Site administrator may point Spaces at", () => {
  it("takes any Profile of the Site while no list restricts it", () => {
    expect(checkSiteMediaStorageSettingsUpdate(current, { siteSpaceProfileId: 2, defaultUserProfileId: 2 })).toEqual([]);
  });

  it("refuses a Profile of another Site, or one outside the allowed list", () => {
    expect(checkSiteMediaStorageSettingsUpdate(current, { siteSpaceProfileId: 9 }).join(" ")).toMatch(/does not belong/);
    expect(checkSiteMediaStorageSettingsUpdate(current, { allowedProfileIds: [1], defaultGroupProfileId: 2 }).join(" "))
      .toMatch(/not among the allowed/);
  });

  it("refuses to point a Space at a disabled Profile, but lets the Profile in use be disabled", () => {
    expect(checkSiteMediaStorageSettingsUpdate(current, { siteSpaceProfileId: 3 }).join(" ")).toMatch(/disabled/);
    // Pausing uploads into the Profile the Site Space writes to is what disabling is for.
    expect(checkSiteMediaStorageSettingsUpdate(current, { disabledProfileIds: [1, 3] })).toEqual([]);
  });

  it("refuses to restrict the list so that what a Space points at falls outside it", () => {
    expect(checkSiteMediaStorageSettingsUpdate(current, { allowedProfileIds: [2] }).join(" "))
      .toMatch(/siteSpaceProfileId: .*not among the allowed/);
  });
});
