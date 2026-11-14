import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { ensureUserMediaSpace } from "./media-spaces";
import {
  listSiteMediaSpacesForAdmin,
  readSiteMediaStorageSettings,
  setSiteMediaSpaceStorageProfile,
  updateSiteMediaStorageSettings,
} from "./media-storage-settings";

/*
 * Where a Site's Spaces write, as an administrator sets it. Pointing moves no bytes: only the Site Space is
 * re-pointed, and the defaults decide for the Spaces made afterwards.
 */
describe("Media storage settings against PostgreSQL", () => {
  let site: PhiTestSite;
  let s3: number;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("storage-settings");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, config)
       VALUES ($1, 'pgtest-s3', '@phis/storage-s3/s3', '{}'::jsonb) RETURNING id`,
      [site.id],
    );
    s3 = rows[0]!.id;
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("reads the Site's Profiles and where its Spaces point", async () => {
    const settings = await readSiteMediaStorageSettings(site.id);
    expect(settings.siteSpaceProfileId).toBe(site.storageProfileId);
    expect(settings.defaultUserProfileId).toBeNull();
    expect(settings.profiles.map((profile) => profile.key)).toEqual(expect.arrayContaining(["pgtest-local", "pgtest-s3"]));
    expect(settings.profiles.find((profile) => profile.id === site.storageProfileId)?.spaces).toBe(1);
  });

  it("starts a new User Space on the default and leaves an existing one where it is", async () => {
    const before = await ensureUserMediaSpace(site.id, await createPhiTestUser(site));
    await updateSiteMediaStorageSettings(site.id, { defaultUserProfileId: s3 });
    const born = await ensureUserMediaSpace(site.id, await createPhiTestUser(site));
    expect(born.defaultStorageProfileId).toBe(s3);
    expect((await ensureUserMediaSpace(site.id, before.userId!)).defaultStorageProfileId).toBe(before.defaultStorageProfileId);
  });

  it("lists the User Spaces that exist, and re-points one without touching the others", async () => {
    const listed = await listSiteMediaSpacesForAdmin(site.id, "user", { limit: 50, offset: 0 });
    expect(listed.total).toBeGreaterThanOrEqual(2);
    expect(listed.rows.every((row) => row.kind === "user")).toBe(true);
    const target = listed.rows.find((row) => row.storageProfileId !== s3)!;
    expect(await setSiteMediaSpaceStorageProfile(site.id, target.id, s3)).toBe(true);
    const after = await listSiteMediaSpacesForAdmin(site.id, "user", { limit: 50, offset: 0 });
    expect(after.rows.find((row) => row.id === target.id)?.storageProfileId).toBe(s3);
    // The Site Space is not a row of this table and cannot be pointed through it.
    expect(await setSiteMediaSpaceStorageProfile(site.id, site.siteSpaceId, s3)).toBe(false);
  });

  it("re-points the Site Space and sets the disabled Profiles as one set", async () => {
    const written = await updateSiteMediaStorageSettings(site.id, {
      siteSpaceProfileId: s3,
      allowedProfileIds: [s3, site.storageProfileId],
      disabledProfileIds: [site.storageProfileId],
    });
    expect(written.siteSpaceProfileId).toBe(s3);
    expect(written.allowedProfileIds.sort()).toEqual([s3, site.storageProfileId].sort());
    expect(written.profiles.find((profile) => profile.id === site.storageProfileId)?.disabled).toBe(true);
    const cleared = await updateSiteMediaStorageSettings(site.id, { disabledProfileIds: [] });
    expect(cleared.profiles.every((profile) => !profile.disabled)).toBe(true);
  });
});
