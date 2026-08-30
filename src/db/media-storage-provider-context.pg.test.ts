import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPhisMediaStorageServiceContext } from "@/lib/media-storage";
import { writePhiServerSecretWithDb } from "./server-secrets-store.mts";
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
    await writePhiServerSecretWithDb(pool, {
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

  it("links the Local Provider directly, without consulting a build", async () => {
    const { resolvePhisMediaStorageProviderFactory, PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } =
      await import("@/lib/media-storage");

    expect(typeof await resolvePhisMediaStorageProviderFactory(PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID))
      .toBe("function");
  });
});
