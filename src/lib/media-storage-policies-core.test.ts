import { describe, expect, it, vi } from "vitest";

import type { PhisMediaLifecyclePolicy } from "@phis/contracts/addon";

import {
  PHI_MEDIA_STORAGE_LIFECYCLE_DAYS,
  PHI_MEDIA_UPLOAD_SESSION_TTL_MS,
  buildPhiMediaUploadStagingKeyPrefix,
  reconcilePhiMediaStoragePoliciesWith,
  type PhiMediaStoragePolicyProfile,
} from "./media-storage-policies-core";
import { buildPhisMediaUploadTempStorageKey } from "./media-storage";

/**
 * What a storage is told when a Profile is written.
 *
 * The lifecycle half is the one worth a test file. It is the only thing that ever stops paying for an upload
 * nobody completed -- such an upload appears in no object listing, so no sweep could find it and the Client
 * that could have named it is what went away -- and its one catastrophic failure mode is an expiry rule with
 * a prefix that matches more than staging. Both of those are pinned here.
 */
const PROFILE: PhiMediaStoragePolicyProfile = {
  id: 7,
  siteId: 1,
  siteKey: "demo",
  providerId: "@phis/storage-s3/s3",
  config: {},
  secretReference: null,
  publicBaseUrl: "https://demo.example",
  storageKeyPrefix: "sites",
};

function adapter(identity = "s3:one|bucket") {
  // Typed parameters, so the recorded calls can be read back rather than being an empty tuple.
  const applyCorsPolicy = vi.fn(async (_origins: readonly string[]) => {});
  const applyLifecyclePolicy = vi.fn(async (_policy: PhisMediaLifecyclePolicy) => {});
  return { storageIdentity: () => identity, applyCorsPolicy, applyLifecyclePolicy };
}

describe("the staging key prefix", () => {
  it("is the prefix of the keys Core actually writes", () => {
    const prefix = buildPhiMediaUploadStagingKeyPrefix({ storageKeyPrefix: "sites", siteKey: "demo" });
    const key = buildPhisMediaUploadTempStorageKey({
      siteKey: "demo", token: "t0ken", originalName: "clip.mp4", storageKeyPrefix: "sites",
    });
    // The point of sharing the helper: a rule pointing anywhere else would never fire, and say nothing.
    expect(key.startsWith(prefix)).toBe(true);
    expect(prefix).toBe("sites/uploads-temp/demo/");
  });

  it("normalises the way the key builder does, so the two cannot drift apart", () => {
    const prefix = buildPhiMediaUploadStagingKeyPrefix({ storageKeyPrefix: "/Sites/", siteKey: "Demo Site" });
    const key = buildPhisMediaUploadTempStorageKey({
      siteKey: "Demo Site", token: "t0ken", originalName: "clip.mp4", storageKeyPrefix: "/Sites/",
    });
    expect(key.startsWith(prefix)).toBe(true);
  });

  it("falls back to the same default prefix rather than to an empty one", () => {
    // An empty prefix would put staging at the root of the key space, which an expiry rule then covers.
    expect(buildPhiMediaUploadStagingKeyPrefix({ storageKeyPrefix: "", siteKey: "demo" }))
      .toBe("sites/uploads-temp/demo/");
    expect(buildPhiMediaUploadStagingKeyPrefix({ storageKeyPrefix: "../..", siteKey: "demo" }))
      .toBe("sites/uploads-temp/demo/");
  });

  it("refuses a prefix without a Site, rather than one matching every Site", () => {
    expect(() => buildPhiMediaUploadStagingKeyPrefix({ storageKeyPrefix: "sites", siteKey: "  " }))
      .toThrow(/site key/iu);
  });
});

describe("the lifecycle figures", () => {
  it("wait longer than a session may live", () => {
    const sessionDays = PHI_MEDIA_UPLOAD_SESSION_TTL_MS / (1000 * 60 * 60 * 24);
    /*
     * Strictly longer, and by a whole day. Lifecycle rules take whole days and are evaluated
     * asynchronously, so a rule equal to the session length can fire on an upload that still has hours to
     * run -- and aborting a body somebody is sending is worse than paying for it a little longer.
     */
    expect(PHI_MEDIA_STORAGE_LIFECYCLE_DAYS).toBeGreaterThan(sessionDays);
    expect(PHI_MEDIA_STORAGE_LIFECYCLE_DAYS).toBe(Math.ceil(sessionDays) + 1);
  });
});

describe("writing both rules for one storage", () => {
  it("names the abort, the staging prefixes and the same waiting period for both", async () => {
    const one = adapter();
    const groups = await reconcilePhiMediaStoragePoliciesWith([PROFILE], async () => one);

    expect(one.applyCorsPolicy).toHaveBeenCalledWith(["https://demo.example"]);
    expect(one.applyLifecyclePolicy).toHaveBeenCalledWith({
      abortIncompleteMultipartUploadAfterDays: PHI_MEDIA_STORAGE_LIFECYCLE_DAYS,
      stagingKeyPrefixes: ["sites/uploads-temp/demo/"],
      expireStagedObjectsAfterDays: PHI_MEDIA_STORAGE_LIFECYCLE_DAYS,
    });
    expect(groups[0]).toMatchObject({ applied: true, lifecycleApplied: true, error: null, lifecycleError: null });
  });

  it("gives two Sites on one storage one rule carrying both prefixes", async () => {
    const one = adapter();
    const second = { ...PROFILE, id: 8, siteId: 2, siteKey: "other", publicBaseUrl: "https://other.example" };
    await reconcilePhiMediaStoragePoliciesWith([PROFILE, second], async () => one);

    // One storage, one rule: applying each Site's in turn would leave whichever went last.
    expect(one.applyLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect(one.applyLifecyclePolicy.mock.calls[0]![0]).toMatchObject({
      stagingKeyPrefixes: ["sites/uploads-temp/demo/", "sites/uploads-temp/other/"],
    });
  });

  it("reports the two halves apart, because a storage may take one and refuse the other", async () => {
    const one = adapter();
    one.applyLifecyclePolicy.mockRejectedValueOnce(new Error("lifecycle is not supported here\nsecond line"));
    const [group] = await reconcilePhiMediaStoragePoliciesWith([PROFILE], async () => one);

    expect(group).toMatchObject({ applied: true, error: null, lifecycleApplied: false });
    expect(group!.lifecycleError).toBe("lifecycle is not supported here");
  });

  it("still writes the lifecycle rule where CORS failed, and the other way round", async () => {
    const one = adapter();
    one.applyCorsPolicy.mockRejectedValueOnce(new Error("no permission for CORS"));
    const [group] = await reconcilePhiMediaStoragePoliciesWith([PROFILE], async () => one);

    expect(one.applyLifecyclePolicy).toHaveBeenCalledTimes(1);
    expect(group).toMatchObject({ applied: false, lifecycleApplied: true });
  });

  it("skips a Provider that needs neither rule", async () => {
    const groups = await reconcilePhiMediaStoragePoliciesWith([PROFILE], async () => null);
    expect(groups).toEqual([]);
  });

  it("steps over a Profile whose Provider cannot be built, and says which", async () => {
    const one = adapter();
    const broken = { ...PROFILE, id: 9, siteKey: "broken" };
    const groups = await reconcilePhiMediaStoragePoliciesWith(
      [broken, PROFILE],
      async (profile) => {
        if (profile.id === 9) throw new Error("the Add-on offering this Provider is gone");
        return one;
      },
    );

    // One broken Profile must not leave every other storage unreconciled.
    expect(groups[0]).toMatchObject({
      identity: "profile:9", applied: false, lifecycleApplied: false,
      error: "the Add-on offering this Provider is gone",
    });
    expect(groups[1]).toMatchObject({ applied: true, lifecycleApplied: true });
  });
});
