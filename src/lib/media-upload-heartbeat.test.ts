import { describe, expect, it } from "vitest";

import {
  isPhiMediaUploadResumable,
  PHI_MEDIA_UPLOAD_HEARTBEAT_LAPSE_MS,
  PhiMediaUploadPlanKind,
  PhiMediaUploadSessionStatus,
} from "./media-upload-sessions";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MULTIPART = PhiMediaUploadPlanKind.MultipartPut;

/**
 * A crashed page reports nothing, so its session sits at Pending or Uploading. The heartbeat tells it apart
 * from one with a page sending into it right now.
 */
describe("which upload sessions may be carried on", () => {
  it("takes one that reported it stopped", () => {
    expect(isPhiMediaUploadResumable(MULTIPART, PhiMediaUploadSessionStatus.Interrupted, null, NOW)).toBe(true);
  });

  it("takes one still being delivered whose heartbeat has lapsed", () => {
    for (const status of [PhiMediaUploadSessionStatus.Pending, PhiMediaUploadSessionStatus.Uploading]) {
      expect(isPhiMediaUploadResumable(MULTIPART, status, ago(PHI_MEDIA_UPLOAD_HEARTBEAT_LAPSE_MS + 1), NOW)).toBe(true);
    }
  });

  it("leaves one whose page is still beating, or never beat at all", () => {
    expect(isPhiMediaUploadResumable(MULTIPART, PhiMediaUploadSessionStatus.Pending, ago(5_000), NOW)).toBe(false);
    expect(isPhiMediaUploadResumable(MULTIPART, PhiMediaUploadSessionStatus.Pending, null, NOW)).toBe(false);
  });

  it("never takes a single-request body, which leaves nothing to build on", () => {
    expect(isPhiMediaUploadResumable(PhiMediaUploadPlanKind.PresignedPut, PhiMediaUploadSessionStatus.Interrupted, null, NOW))
      .toBe(false);
  });
});
