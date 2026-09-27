import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  service: vi.fn(),
}));

vi.mock("@/db/media-spaces", () => ({ getMediaStorageProfile: mocks.profile }));
vi.mock("@/lib/media-storage", () => ({ createPhisMediaStorageServiceForProfile: mocks.service }));

import {
  discardPhiMediaUploadStaging,
  discardReleasedPhiMediaUploadStaging,
} from "./media-upload-staging";

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

/**
 * Cleaning up after the sessions an expiry sweep just released.
 *
 * This is the case the sweep used to leave behind entirely: it deletes the rows, because that is what frees
 * the reservation, and the row is the only record of where the remains are. So they are handed here while
 * the request still has the Space's Provider open -- which is the whole reason a request may do this at all.
 */
describe("cleaning up after an expiry sweep", () => {
  beforeEach(() => {
    mocks.profile.mockReset();
    mocks.service.mockReset();
  });

  const PROFILE = { id: 7, providerId: "@phis/storage-s3/s3" };
  const session = (overrides: Partial<{
    storageProfileId: number; stagingStorageKey: string; providerUploadId: string | null;
  }> = {}) => ({
    storageProfileId: 7,
    stagingStorageKey: "sites/uploads-temp/demo/abc/clip.mp4",
    providerUploadId: null,
    ...overrides,
  });

  function withStorage() {
    const deleteObject = vi.fn(async () => true);
    const completeUpload = vi.fn(async () => null);
    mocks.service.mockResolvedValue({ deleteObject, completeUpload });
    return { deleteObject, completeUpload };
  }

  it("opens the Provider once for however many sessions it removes", async () => {
    const { deleteObject } = withStorage();
    const outcome = await discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session(), session({ stagingStorageKey: "sites/uploads-temp/demo/def/other.bin" })],
    });

    expect(outcome).toEqual({ discarded: 2, skipped: 0, failed: 0 });
    // One resolution, not one per session: reading the secret twice buys nothing.
    expect(mocks.service).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  it("aborts an unfinished assembly rather than deleting an object that does not exist", async () => {
    const { deleteObject, completeUpload } = withStorage();
    await discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session({ providerUploadId: "2~aBcDeF" })],
    });

    expect(completeUpload).toHaveBeenCalledWith({
      storageKey: "sites/uploads-temp/demo/abc/clip.mp4",
      completion: { uploadId: "2~aBcDeF", parts: [] },
    });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  /*
   * A session can name another Profile, but only for as long as a session may live after an operator moved
   * the Space -- and its objects are then in another storage, whose own lifecycle rule reaches them.
   * Resolving that Provider here would mean reading a second secret for an upload unrelated to it.
   */
  it("leaves a session on another Profile to that storage's own rule", async () => {
    const { deleteObject } = withStorage();
    const outcome = await discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session({ storageProfileId: 9 }), session()],
    });

    expect(outcome).toEqual({ discarded: 1, skipped: 1, failed: 0 });
    expect(deleteObject).toHaveBeenCalledTimes(1);
  });

  it("skips a session that staged nothing, without opening a Provider", async () => {
    withStorage();
    const outcome = await discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session({ stagingStorageKey: "   " })],
    });

    expect(outcome).toEqual({ discarded: 0, skipped: 1, failed: 0 });
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("counts what the Provider refused and never throws, because it runs after the response", async () => {
    const deleteObject = vi.fn(async () => { throw new Error("connect ETIMEDOUT"); });
    mocks.service.mockResolvedValue({ deleteObject, completeUpload: vi.fn(async () => null) });

    await expect(discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session(), session()],
    })).resolves.toEqual({ discarded: 0, skipped: 0, failed: 2 });
  });

  it("reports every session as failed where the Provider could not be built at all", async () => {
    mocks.service.mockRejectedValue(new Error("no secret"));
    await expect(discardReleasedPhiMediaUploadStaging({
      siteKey: "demo",
      storageProfileId: 7,
      profile: PROFILE as never,
      sessions: [session()],
    })).resolves.toEqual({ discarded: 0, skipped: 0, failed: 1 });
  });
});
