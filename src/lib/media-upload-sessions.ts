import { randomBytes } from "node:crypto";

import { resolvePhiMediaKindFromContentType } from "./constants/media";
import type { PhiMediaUploadPlanKindKey } from "./media-storage";

/**
 * What an upload becomes once the bytes are there.
 *
 * One lifecycle, several endings. Core reserves, receives, measures and hashes without knowing who
 * asked; this is read at the last step to decide what row the finished object turns into. A closed
 * vocabulary and not a free label, so the ending is a decision somebody made rather than a string that
 * happened to be there.
 */
export const PhiMediaUploadPurpose = { Media: 1, AddonAsset: 2 } as const;

export type PhiMediaUploadPurposeValue =
  (typeof PhiMediaUploadPurpose)[keyof typeof PhiMediaUploadPurpose];

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
  MultipartPut: 3,
} as const;

export type PhiMediaUploadPlanKindValue =
  (typeof PhiMediaUploadPlanKind)[keyof typeof PhiMediaUploadPlanKind];

/**
 * A total map and not a ternary with a default.
 *
 * The default used to be `ProxyStream`, which is the one answer that must never be reached by accident:
 * it is what entitles Core to receive the body, and a plan kind that fell through to it would open the
 * proxy route for an upload the Provider is taking directly. A kind nobody has mapped is a throw.
 */
const PHI_MEDIA_UPLOAD_PLAN_KIND_VALUES: Readonly<Record<PhiMediaUploadPlanKindKey, PhiMediaUploadPlanKindValue>> = {
  "proxy-stream": PhiMediaUploadPlanKind.ProxyStream,
  "presigned-put": PhiMediaUploadPlanKind.PresignedPut,
  "multipart-put": PhiMediaUploadPlanKind.MultipartPut,
};

export function resolvePhiMediaUploadPlanKind(kind: PhiMediaUploadPlanKindKey): PhiMediaUploadPlanKindValue {
  const value = PHI_MEDIA_UPLOAD_PLAN_KIND_VALUES[kind];
  if (!value) {
    throw new Error(`Unknown upload plan kind "${kind}".`);
  }
  return value;
}

/** Whether the Provider is assembling this body out of several requests. */
export function isPhiMediaUploadAssembledFromParts(planKind: number) {
  return planKind === PhiMediaUploadPlanKind.MultipartPut;
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

