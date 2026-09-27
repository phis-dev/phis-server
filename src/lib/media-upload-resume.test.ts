import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  abort: vi.fn(),
  update: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/db/media", () => ({
  findResumableMediaUploadSession: mocks.find,
  abortMediaUploadSessionByToken: mocks.abort,
  updateMediaUploadSessionByToken: mocks.update,
}));
vi.mock("@/lib/log", () => ({
  logRuntimeEvent: mocks.log,
  normalizeLogThrowable: (error: unknown) => ({ message: String(error) }),
}));

import { findPhiMediaUploadToResume } from "./media-upload-resume";
import { PhiMediaUploadSessionStatus } from "./media-upload-sessions";
import type { PhisMediaStorageService } from "./media-storage";

/**
 * Taking over an upload a page stopped delivering, and the four ways that must not happen.
 *
 * The prize is not speed. It is that the parts already at the Provider are bytes somebody asserted once,
 * and joining them to anything other than the same file assembles an object out of two files -- whose
 * digest is then recorded as true of the result, and whose duplicate detection is wrong from then on. So
 * every guard here is about identity or about authority, and each is silent if it goes.
 *
 * The other half is the reservation. A session being carried on is still holding one, which is why nothing
 * reserves again; and a session whose parts have gone is holding one for nothing, which is why that row is
 * torn down rather than left to expire.
 */

const COMPOSITE = { algorithm: "sha256-composite", value: `${"a".repeat(64)}-2-16777216` };
const PART_DIGESTS = ["b".repeat(64), "c".repeat(64)];

function session(overrides: Record<string, unknown> = {}) {
  return {
    token: "tok-resume",
    siteId: 1,
    spaceId: 7,
    actorUserId: 42,
    storageProfileId: 3,
    stagingStorageKey: "sites/dev/_uploads/tok-resume/clip.mp4",
    providerUploadId: "upload-1",
    contentType: "video/mp4",
    sizeBytes: 20 * 1024 * 1024,
    expiresAt: "2026-09-28T00:00:00.000Z",
    filename: "clip.mp4",
    status: PhiMediaUploadSessionStatus.Interrupted,
    ...overrides,
  };
}

function storage(resume: PhisMediaStorageService["resumeUploadPlan"]) {
  return { resumeUploadPlan: resume } as unknown as PhisMediaStorageService;
}

const resumption = {
  plan: {
    kind: "multipart-put" as const,
    method: "PUT" as const,
    uploadId: "upload-1",
    partSizeBytes: 16 * 1024 * 1024,
    parts: [{ partNumber: 2, url: "https://s3.invalid/part-2" }],
    expiresAt: "2026-09-28T00:00:00.000Z",
  },
  uploaded: [{ partNumber: 1, eTag: '"tag-1"', sizeBytes: 16 * 1024 * 1024 }],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 1,
    siteKey: "dev",
    spaceId: 7,
    actorUserId: 42,
    filename: "clip.mp4",
    sizeBytes: 20 * 1024 * 1024,
    storageProfileId: 3,
    checksum: COMPOSITE,
    partChecksums: PART_DIGESTS,
    storage: storage(vi.fn(async () => resumption)),
    folderId: 9,
    presentationFlags: 0,
    meta: null,
    ...overrides,
  } as Parameters<typeof findPhiMediaUploadToResume>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockResolvedValue(session());
  mocks.update.mockImplementation(async () => session({ status: PhiMediaUploadSessionStatus.Uploading }));
});

describe("finding an upload to carry on", () => {
  it("hands back what is missing, what is there, and marks the session taken over", async () => {
    const resumed = await findPhiMediaUploadToResume(input());

    expect(resumed?.token).toBe("tok-resume");
    // The parts already stored travel on, because their tags exist nowhere else: the page that read them
    // is gone, and a completion has to name every part.
    expect(resumed?.uploaded).toEqual(resumption.uploaded);
    expect(resumed?.remainingParts).toBe(1);
    // Out of "interrupted", so a second attempt at the same file finds nothing to take over and opens its
    // own upload rather than writing the same part numbers into this one.
    expect(mocks.update).toHaveBeenCalledWith("tok-resume", expect.objectContaining({
      status: PhiMediaUploadSessionStatus.Uploading,
      folderId: 9,
    }));
    expect(mocks.abort).not.toHaveBeenCalled();
  });

  it("looks the session up by the digest, and never by name and size alone", async () => {
    await findPhiMediaUploadToResume(input());
    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({
      checksumAlgorithm: COMPOSITE.algorithm,
      checksumValue: COMPOSITE.value,
      actorUserId: 42,
      spaceId: 7,
    }));
  });

  /*
   * The destination is this attempt's, not the first one's. The parts are the only thing being reused --
   * a person who drops the same file into another Folder means that Folder.
   */
  it("takes the Folder and the flags from the attempt that is carrying on", async () => {
    await findPhiMediaUploadToResume(input({ folderId: null, presentationFlags: 4 }));
    expect(mocks.update).toHaveBeenCalledWith("tok-resume", expect.objectContaining({
      folderId: null,
      presentationFlags: 4,
    }));
  });

  it("offers nothing without a digest, because nothing else proves it is the same file", async () => {
    expect(await findPhiMediaUploadToResume(input({ checksum: null }))).toBeNull();
    // Not even asked: a match on name and size would be a guess about whose bytes those parts are.
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("offers nothing for a whole-object digest, which describes a body that is one request", async () => {
    expect(await findPhiMediaUploadToResume(input({
      checksum: { algorithm: "sha256", value: "d".repeat(64) },
      partChecksums: [],
    }))).toBeNull();
    expect(mocks.find).not.toHaveBeenCalled();
  });

  /*
   * A session naming another Storage Profile is left alone, for the reason the expiry sweep gives: reaching
   * it means opening a storage, and reading its secret, on behalf of an upload that has nothing to do with
   * the one being asked for.
   */
  it("leaves a session on another Storage Profile to a fresh upload", async () => {
    mocks.find.mockResolvedValue(session({ storageProfileId: 99 }));
    const resume = vi.fn(async () => resumption);

    expect(await findPhiMediaUploadToResume(input({ storage: storage(resume) }))).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("asks the storage about the assembly the session named, and nothing else", async () => {
    const resume = vi.fn(async () => resumption);
    await findPhiMediaUploadToResume(input({ storage: storage(resume) }));
    expect(resume).toHaveBeenCalledWith({
      storageKey: "sites/dev/_uploads/tok-resume/clip.mp4",
      uploadId: "upload-1",
      contentType: "video/mp4",
      sizeBytes: 20 * 1024 * 1024,
      expiresAt: "2026-09-28T00:00:00.000Z",
      partChecksums: PART_DIGESTS,
    });
  });

  /*
   * The parts are gone, so the row is holding a reservation for bytes that do not exist and nothing will
   * ever come back for it. Torn down here rather than left to expire, and before the caller reserves --
   * which is what lets a Space at its limit still take the retry.
   */
  it("tears down a session whose parts the storage no longer holds", async () => {
    expect(await findPhiMediaUploadToResume(input({
      storage: storage(vi.fn(async () => null)),
    }))).toBeNull();
    expect(mocks.abort).toHaveBeenCalledWith("tok-resume");
  });

  /*
   * "Could not ask" is not "is not there", and treating them alike would abort an assembly that is
   * perfectly intact the moment a storage has a bad minute. The upload starts over either way; only the
   * parts' fate differs, and they are the expensive half.
   */
  it("keeps the session when the storage could not be asked at all", async () => {
    const resume = vi.fn(async () => {
      throw new Error("endpoint unreachable");
    });

    expect(await findPhiMediaUploadToResume(input({ storage: storage(resume) }))).toBeNull();
    expect(mocks.abort).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("warn", "media.upload.resume_unavailable", expect.anything());
  });

  it("offers nothing where there is no interrupted session for this file", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await findPhiMediaUploadToResume(input())).toBeNull();
  });

  /** Without the Provider's own name for the assembly nothing could be continued or aborted later. */
  it("offers nothing for a session the Provider never named", async () => {
    mocks.find.mockResolvedValue(session({ providerUploadId: null }));
    expect(await findPhiMediaUploadToResume(input())).toBeNull();
  });
});
