import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  service: vi.fn(),
}));

vi.mock("@/db/media-spaces", () => ({ getMediaStorageProfile: mocks.profile }));
vi.mock("@/lib/media-storage", () => ({ createPhisMediaStorageServiceForProfile: mocks.service }));

import { discardPhiMediaUploadStaging } from "./media-upload-staging";

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

  function withStorage(deleteObject: () => Promise<boolean>, completeUpload = vi.fn(async () => null)) {
    mocks.profile.mockResolvedValue({ id: 7, providerId: "@phis/server/local" });
    mocks.service.mockResolvedValue({ deleteObject, completeUpload });
    return { deleteObject, completeUpload };
  }

  it("reports the removal, and asks the Provider for the session's own key", async () => {
    const deleteObject = vi.fn(async () => true);
    withStorage(deleteObject);

    expect(await discardPhiMediaUploadStaging(SESSION)).toBe(true);
    expect(deleteObject).toHaveBeenCalledWith(SESSION.stagingStorageKey);
    expect(mocks.profile).toHaveBeenCalledWith(SESSION.siteId, SESSION.storageProfileId);
  });

  it("says false where there was nothing staged, which a presigned body that never arrived leaves", async () => {
    withStorage(vi.fn(async () => false));
    expect(await discardPhiMediaUploadStaging(SESSION)).toBe(false);
  });

  it("says null where the Provider could not be reached, because the object may still be there", async () => {
    withStorage(vi.fn(async () => { throw new Error("connect ETIMEDOUT"); }));
    expect(await discardPhiMediaUploadStaging(SESSION)).toBeNull();
  });

  it("says null where the Profile is gone, rather than reporting a removal it did not make", async () => {
    mocks.profile.mockResolvedValue(null);
    expect(await discardPhiMediaUploadStaging(SESSION)).toBeNull();

    mocks.profile.mockRejectedValue(new Error("no pool"));
    expect(await discardPhiMediaUploadStaging(SESSION)).toBeNull();
  });

  it("does not open a Provider for a session that staged nothing", async () => {
    expect(await discardPhiMediaUploadStaging({ ...SESSION, stagingStorageKey: "  " })).toBe(false);
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});

describe("throwing away a multipart upload nobody completed", () => {
  beforeEach(() => {
    mocks.profile.mockReset();
    mocks.service.mockReset();
  });

  const MULTIPART = { ...SESSION, providerUploadId: "2~aBcDeF" };

  function withStorage(completeUpload: () => Promise<null>) {
    const deleteObject = vi.fn(async () => true);
    mocks.profile.mockResolvedValue({ id: 7, providerId: "@phis/storage-s3/s3" });
    mocks.service.mockResolvedValue({ deleteObject, completeUpload });
    return { deleteObject, completeUpload };
  }

  it("aborts the assembly instead of deleting an object that does not exist yet", async () => {
    const completeUpload = vi.fn(async () => null);
    const { deleteObject } = withStorage(completeUpload);

    expect(await discardPhiMediaUploadStaging(MULTIPART)).toBe(true);
    // A completion naming no parts is how the contract spells "abort".
    expect(completeUpload).toHaveBeenCalledWith({
      storageKey: MULTIPART.stagingStorageKey,
      completion: { uploadId: "2~aBcDeF", parts: [] },
    });
    // There is no object until the parts are assembled, so deleting one would be asking for nothing.
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("reads the contract's null as the abort having happened, not as a failure", async () => {
    withStorage(vi.fn(async () => null));
    expect(await discardPhiMediaUploadStaging(MULTIPART)).toBe(true);
  });

  it("says null where the Provider refused, because the parts are still being paid for", async () => {
    withStorage(vi.fn(async () => { throw new Error("connect ETIMEDOUT"); }));
    expect(await discardPhiMediaUploadStaging(MULTIPART)).toBeNull();
  });

  it("deletes rather than aborts where no assembly was ever opened", async () => {
    const completeUpload = vi.fn(async () => null);
    const { deleteObject } = withStorage(completeUpload);

    await discardPhiMediaUploadStaging({ ...MULTIPART, providerUploadId: null });
    expect(completeUpload).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledWith(MULTIPART.stagingStorageKey);
  });
});
