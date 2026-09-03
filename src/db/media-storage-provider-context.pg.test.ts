import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPhisMediaStorageServiceContext } from "@/lib/media-storage";
import { writePhisSecretWithDb } from "./server-secrets-store.mts";
import { buildPhiSecretReference } from "@/lib/secrets/reference";
import { readPhiSecretEncryptionKey } from "@/lib/secrets/resolver";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

const PROBE_PROVIDER_ID = "@pgtest/storage-probe" as const;

describe("what a Storage Provider factory is handed", () => {
  let site: PhiTestSite;
  let reference: string;

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("provider-context");
    reference = buildPhiSecretReference({
      owner: { kind: "core" },
      siteKey: site.key,
      name: "provider-probe",
    });
    await writePhisSecretWithDb(pool, {
      reference,
      value: "the-provider-credential",
      key: readPhiSecretEncryptionKey(),
      siteId: site.id,
    });
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("resolves the secret its own profile names", async () => {
    const context = buildPhisMediaStorageServiceContext(
      { providerId: PROBE_PROVIDER_ID, secretReference: reference },
      site.key,
    );

    expect(await context.readSecret()).toBe("the-provider-credential");
    expect(context.siteKey).toBe(site.key);
    expect(context.providerId).toBe(PROBE_PROVIDER_ID);
  });

  it("answers null for a profile that names no secret", async () => {
    const context = buildPhisMediaStorageServiceContext(
      { providerId: PROBE_PROVIDER_ID, secretReference: null },
      site.key,
    );

    expect(await context.readSecret()).toBeNull();
  });

  it("hands over no way to name another secret", () => {
    const context = buildPhisMediaStorageServiceContext(
      { providerId: PROBE_PROVIDER_ID, secretReference: reference },
      site.key,
    );

    // The whole surface: one nullary reader bound to this profile, and two labels. A Provider cannot
    // reach another profile's secret because there is no argument to reach with.
    expect(Object.keys(context).sort()).toEqual(["providerId", "readSecret", "siteKey"]);
    expect(context.readSecret).toHaveLength(0);
  });

  it("refuses a Provider that no build declares", async () => {
    const { resolvePhisMediaStorageProviderFactory } = await import("@/lib/media-storage");

    await expect(resolvePhisMediaStorageProviderFactory(PROBE_PROVIDER_ID))
      .rejects.toThrow(/no installed Add-on declares it/u);
  });

  /*
   * The check that an Add-on runs only where a Site asked for it.
   *
   * It has been in `services.ts` all along and could never fire: it is skipped when no Site is passed,
   * and every Media caller passed none -- which was the only thing keeping uploads alive, because the
   * row it reads was written by nothing. Now that the row can be written, the check has to be shown to
   * work in both directions, or "enabled for this Site" is decoration.
   */
  it("refuses an installed Provider for a Site that never asked for it", async () => {
    const { getPhisAddonInstalledManifest } = await import("@/lib/addons/installed");
    const installedHere = (() => {
      try {
        return getPhisAddonInstalledManifest();
      } catch {
        return {};
      }
    })();
    if (!installedHere["@phis/storage-s3"]?.enabled) {
      return;
    }
    const { resolvePhisServiceProvider } = await import("@/lib/addons/services");
    const { PHIS_SERVICE_KINDS } = await import("@/lib/addons/core-services");
    const pool = await requirePhiTestDatabase();
    const stranger = await createPhiTestSite("provider-unasked");

    await expect(resolvePhisServiceProvider(
      PHIS_SERVICE_KINDS.mediaStorage,
      "@phis/storage-s3/s3",
      { siteId: stranger.id },
    )).rejects.toThrow(/not enabled for this Site/u);

    const { setPhisAddonSiteEnabled } = await import("./server-addon-sites.mts");
    await setPhisAddonSiteEnabled(pool, {
      addonId: "@phis/storage-s3",
      siteId: stranger.id,
      enabled: true,
      configurationStatus: "ready",
    });
    const resolved = await resolvePhisServiceProvider(
      PHIS_SERVICE_KINDS.mediaStorage,
      "@phis/storage-s3/s3",
      { siteId: stranger.id },
    );
    expect(resolved.addonId).toBe("@phis/storage-s3");
  });

  it("links the Local Provider directly, without consulting a build", async () => {
    const { resolvePhisMediaStorageProviderFactory, PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } =
      await import("@/lib/media-storage");

    expect(typeof await resolvePhisMediaStorageProviderFactory(PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID))
      .toBe("function");
  });
});
