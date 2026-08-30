import { randomBytes } from "node:crypto";

import { resolvePhiMediaKindFromContentType } from "./constants/media";
import type { PhiMediaUploadPlanKindKey } from "./media-storage";

export const PhiMediaUploadSessionStatus = {
  Pending: 0,
  Uploading: 1,
  Uploaded: 2,
  Finalizing: 3,
  Completed: 4,
  Failed: 5,
  Expired: 6,
  Aborted: 7,
} as const;

export type PhiMediaUploadSessionStatusValue =
  (typeof PhiMediaUploadSessionStatus)[keyof typeof PhiMediaUploadSessionStatus];

/**
 * Which plan a session was issued, persisted so the rest of the flow can read it.
 *
 * It decides two things no later request can work out on its own: whether Core is entitled to receive
 * this body at all, and whether "the body has arrived" is a status Core set itself or something only
 * the stored object can attest. A Provider may issue different plans for different bodies, so this is
 * a property of the session and not of the Storage Profile.
 */
export const PhiMediaUploadPlanKind = {
  ProxyStream: 1,
  PresignedPut: 2,
} as const;

export type PhiMediaUploadPlanKindValue =
  (typeof PhiMediaUploadPlanKind)[keyof typeof PhiMediaUploadPlanKind];

export function resolvePhiMediaUploadPlanKind(kind: PhiMediaUploadPlanKindKey): PhiMediaUploadPlanKindValue {
  return kind === "presigned-put" ? PhiMediaUploadPlanKind.PresignedPut : PhiMediaUploadPlanKind.ProxyStream;
}

/** Core receives the body itself only on the plan that says so. */
export function isPhiMediaUploadBodyProxied(planKind: number) {
  return planKind === PhiMediaUploadPlanKind.ProxyStream;
}

export function createPhiMediaUploadSessionToken() {
  return randomBytes(32).toString("hex");
}

export function resolvePhiMediaUploadSessionKind(contentType: string) {
  return resolvePhiMediaKindFromContentType(contentType);
}

