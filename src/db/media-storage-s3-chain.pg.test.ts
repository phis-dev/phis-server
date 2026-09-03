import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
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

/**
 * The whole chain, from a Storage Profile row to bytes in a bucket.
 *
 * Every piece has its own test; this one asks whether they meet. The Add-on has to be installed,
 * enabled and reconciled for it to run, which is the point -- a Provider that resolves without those
 * would mean the checks are not where they claim to be.
 */
const endpoint = process.env.PHIS_S3_TEST_ENDPOINT;
const bucket = process.env.PHIS_S3_TEST_BUCKET;
const accessKeyId = process.env.PHIS_S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.PHIS_S3_TEST_SECRET_ACCESS_KEY;
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const S3_PROVIDER_KEY = "@phis/storage-s3/s3";

describe.skipIf(!configured)("a Storage Profile that names the S3 Add-on", () => {
  let site: PhiTestSite;
  let profile: {
    providerId: typeof S3_PROVIDER_KEY;
    siteId: number;
    config: Record<string, unknown>;
    secretReference: string;
  };

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("s3-chain");
    const reference = buildPhiSecretReference({
      owner: { kind: "addon", addonId: "@phis/storage-s3" },
      siteKey: site.key,
      name: "secret-access-key",
    });
    await writePhisSecretWithDb(pool, {
      reference,
      value: secretAccessKey!,
      key: readPhiSecretEncryptionKey(),
      siteId: site.id,
    });
    profile = {
      providerId: S3_PROVIDER_KEY,
      siteId: site.id,
      config: {
        endpoint,
        region: "garage",
        bucket,
        accessKeyId,
        prefix: `pgtest/${site.key}`,
        forcePathStyle: true,
      },
      secretReference: reference,
    };
  });

  afterAll(async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.server_secrets WHERE reference LIKE '%pgtest-%'`);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("resolves the Add-on's Provider out of the build manifest", async () => {
    const storage = await createPhisMediaStorageServiceForProfile(profile, site.key);

    expect(storage.providerId).toBe(S3_PROVIDER_KEY);
  });

  it("writes, reads and removes an object with the credential from the store", async () => {
    const storage = await createPhisMediaStorageServiceForProfile(profile, site.key);

    const head = await storage.putObject({
      storageKey: "chain/end-to-end.txt",
      body: Buffer.from("through the whole chain"),
      contentType: "text/plain",
      metadata: { probe: "chain" },
    });
    expect(head.byteSize).toBe(23);
    expect(head.contentType).toBe("text/plain");

    expect((await storage.getObject("chain/end-to-end.txt"))?.toString())
      .toBe("through the whole chain");
    expect(await storage.deleteObject("chain/end-to-end.txt")).toBe(true);
  });

  it("settles a staged object the way finalize does", async () => {
    const storage = await createPhisMediaStorageServiceForProfile(profile, site.key);
    await storage.putObject({
      storageKey: "chain/staging.bin",
      body: Buffer.from("\x89PNG\r\n\x1a\n staged"),
      contentType: "application/octet-stream",
      metadata: {},
    });

    // finalize measures the bytes and settles under the measured type, not the declared one.
    const settled = await storage.copyObject({
      sourceKey: "chain/staging.bin",
      targetKey: "chain/settled.png",
      contentType: "image/png",
      metadata: { assetId: "1" },
    });

    expect(settled?.contentType).toBe("image/png");
    await storage.deleteObject("chain/staging.bin");
    await storage.deleteObject("chain/settled.png");
  });

  it("refuses a Provider no build declares", async () => {
    await expect(createPhisMediaStorageServiceForProfile(
      { ...profile, providerId: "@acme/storage/nowhere" },
      site.key,
    )).rejects.toThrow(/no installed Add-on declares it/u);
  });
});
