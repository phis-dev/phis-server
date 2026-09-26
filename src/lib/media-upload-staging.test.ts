import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  service: vi.fn(),
}));

vi.mock("@/db/media-spaces", () => ({ getMediaStorageProfile: mocks.profile }));
vi.mock("@/lib/media-storage", () => ({ createPhisMediaStorageServiceForProfile: mocks.service }));

import { removePhiMediaUploadStagingObject } from "./media-upload-staging";

/**
 * Cleaning up after an upload the Client said did not happen.
 *
 * The three answers are the contract, and the one worth the file is the difference between `false` and
 * `null`. "There was nothing there" is the ordinary outcome of a presigned body that never arrived, and
 * "the Provider did not answer" means an object is still being paid for -- an operator reading the log
 * needs to tell those apart, so neither may collapse into the other and neither may throw.
 */
const SESSION = {
  siteId: 1,
  siteKey: "demo",
  storageProfileId: 7,
  stagingStorageKey: "sites/demo/uploads-temp/abc/clip.mp4",
};

describe("removing an abandoned upload's staging object", () => {
  beforeEach(() => {
    mocks.profile.mockReset();
    mocks.service.mockReset();
  });

  function withStorage(deleteObject: () => Promise<boolean>) {
    mocks.profile.mockResolvedValue({ id: 7, providerId: "@phis/server/local" });
    mocks.service.mockResolvedValue({ deleteObject });
    return deleteObject;
  }

  it("reports the removal, and asks the Provider for the session's own key", async () => {
    const deleteObject = vi.fn(async () => true);
    withStorage(deleteObject);

    expect(await removePhiMediaUploadStagingObject(SESSION)).toBe(true);
    expect(deleteObject).toHaveBeenCalledWith(SESSION.stagingStorageKey);
    expect(mocks.profile).toHaveBeenCalledWith(SESSION.siteId, SESSION.storageProfileId);
  });

  it("says false where there was nothing staged, which a presigned body that never arrived leaves", async () => {
    withStorage(vi.fn(async () => false));
    expect(await removePhiMediaUploadStagingObject(SESSION)).toBe(false);
  });

  it("says null where the Provider could not be reached, because the object may still be there", async () => {
    withStorage(vi.fn(async () => { throw new Error("connect ETIMEDOUT"); }));
    expect(await removePhiMediaUploadStagingObject(SESSION)).toBeNull();
  });

  it("says null where the Profile is gone, rather than reporting a removal it did not make", async () => {
    mocks.profile.mockResolvedValue(null);
    expect(await removePhiMediaUploadStagingObject(SESSION)).toBeNull();

    mocks.profile.mockRejectedValue(new Error("no pool"));
    expect(await removePhiMediaUploadStagingObject(SESSION)).toBeNull();
  });

  it("does not open a Provider for a session that staged nothing", async () => {
    expect(await removePhiMediaUploadStagingObject({ ...SESSION, stagingStorageKey: "  " })).toBe(false);
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
