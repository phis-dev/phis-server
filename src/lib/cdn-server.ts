import "server-only";

import { NextResponse } from "next/server";

import type { PhisCdnAdminFileV1, PhisCdnUploadStateV1 } from "@phis/contracts/addon";
import { resolvePhiMediaUploadPartCount } from "@phis/contracts/addon";

import { readSiteCdn, readSiteCdnFile, readSiteCdnProfile, readSiteKey, type SiteCdnUploadRecord } from "@/db/site-cdn.mts";
import { ensureSiteMediaConfig, ensureSiteMediaSpace } from "@/db/media-spaces";
import { PhiServiceProviderUnavailableError } from "@/lib/addons/services";
import { namePhisCdnUploadStatus, PhisCdnUploadStatusCode, presentPhisCdnAdminFile } from "@/lib/cdn-core";
import {
  listPhisCdnUploadedParts,
  PHIS_CDN_UPLOAD_HEARTBEAT_INTERVAL_MS,
  PhisCdnBodyLengthError,
  PhisCdnPublishRefusal,
  PhisCdnStorageRefusal,
  type PhisCdnStorage,
  type PhisCdnTarget,
} from "@/lib/cdn-publish.mts";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";
import { createPhisMediaStorageServiceForProfile, type PhisMediaStorageProviderId } from "@/lib/media-storage";

/*
 * The Server's side of a Site's CDN: opening it for the pipeline through the Provider registry, and what
 * the CDN page's routes (`/api/site/admin/cdn`) share -- their refusals and the upload state they answer.
 */

/** The storage is opened on first use, so a list or a link never needs the Provider. */
function lazyStorage(open: () => Promise<PhisCdnStorage>): PhisCdnStorage {
  let opened: Promise<PhisCdnStorage> | null = null;
  const storage = () => (opened ??= open());
  return {
    createUploadPlan: async (input) => (await storage()).createUploadPlan(input),
    resumeUploadPlan: async (input) => (await storage()).resumeUploadPlan(input),
    completeUpload: async (input) => (await storage()).completeUpload(input),
    headObject: async (key) => (await storage()).headObject(key),
    getObjectStream: async (key) => (await storage()).getObjectStream(key),
    getObjectRangeStream: async (key, range) => (await storage()).getObjectRangeStream(key, range),
    deleteObject: async (key) => (await storage()).deleteObject(key),
    listPrefix: async (prefix) => (await storage()).listPrefix(prefix),
  };
}

export class PhisCdnStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhisCdnStorageUnavailableError";
  }
}

/**
 * A Site's CDN opened for the pipeline, or null where it has none. The Site Space it counts copies in
 * and the Site's Media settings are made here if they are not yet, as any Media request makes them.
 */
export async function openPhisCdnTarget(siteId: number, siteKey?: string | null): Promise<PhisCdnTarget | null> {
  const pool = getPool();
  const cdn = await readSiteCdn(pool, siteId);
  if (!cdn) return null;
  const key = siteKey ?? await readSiteKey(pool, siteId);
  const profile = await readSiteCdnProfile(pool, siteId, { id: cdn.storageProfileId });
  if (!key || !profile) return null;
  return {
    siteId,
    siteKey: key,
    cdn,
    profile,
    storage: lazyStorage(async () => {
      try {
        return await createPhisMediaStorageServiceForProfile({
          providerId: profile.providerId as PhisMediaStorageProviderId,
          config: profile.config,
          secretReference: profile.secretReference,
          siteId,
        }, key);
      } catch (error) {
        if (error instanceof PhiServiceProviderUnavailableError) {
          logRuntimeEvent("error", "media.storage.provider_unavailable", {
            message: `Storage Provider ${profile.providerId} of the CDN cannot be opened on this Instance: ${error.reason}.`,
            siteKey: key,
            meta: { siteId, providerId: profile.providerId, reason: error.reason },
          });
          throw new PhisCdnStorageUnavailableError("The CDN's storage is not available on this server.");
        }
        throw error;
      }
    }),
  };
}

/** What a publish into this Site is measured against: its largest object, and the Site Space made. */
export async function readPhisCdnSiteLimits(siteId: number) {
  const [config] = await Promise.all([ensureSiteMediaConfig(siteId), ensureSiteMediaSpace(siteId)]);
  return { maxObjectBytes: config.maxObjectBytes };
}

/** `{ error, message }`, as `nextMediaError` answers. */
export function nextCdnError(error: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, message, ...(extra ?? {}) }, { status });
}

const REFUSAL_RESPONSES: Record<string, { error: string; status: number }> = {
  "invalid-key": { error: "invalid_key", status: 422 },
  "key-taken": { error: "key_taken", status: 409 },
  "object-present": { error: "object_present", status: 409 },
  busy: { error: "busy", status: 409 },
  "content-type-refused": { error: "content_type_refused", status: 415 },
  "too-large": { error: "too_large", status: 413 },
  "quota-exceeded": { error: "quota_exceeded", status: 413 },
  "part-digests": { error: "part_digests", status: 400 },
  "no-public-endpoint": { error: "no_public_endpoint", status: 503 },
  "storage-failed": { error: "storage_unavailable", status: 503 },
};

/** The answer to an error the pipeline threw, or null where it is not one it names. */
export function respondToPhisCdnError(error: unknown) {
  if (error instanceof PhisCdnPublishRefusal) {
    const response = REFUSAL_RESPONSES[error.code] ?? { error: "storage_unavailable", status: 503 };
    return nextCdnError(response.error, error.message, response.status, error.detail);
  }
  if (error instanceof PhisCdnStorageUnavailableError) return nextCdnError("storage_unavailable", error.message, 503);
  if (error instanceof PhisCdnBodyLengthError) return nextCdnError("part_length", error.message, 400);
  if (error instanceof PhisCdnStorageRefusal) {
    return error.digestMismatch
      ? nextCdnError("part_rejected", "The storage refused the part: its bytes do not match the digest sent for it.", 422)
      : nextCdnError("storage_failed", error.message, 502);
  }
  return null;
}

/** The upload as every upload route answers it (`PhisCdnUploadStateV1`). */
export async function presentPhisCdnUploadState(target: PhisCdnTarget, upload: SiteCdnUploadRecord): Promise<PhisCdnUploadStateV1> {
  const partCount = resolvePhiMediaUploadPartCount(upload.sizeBytes);
  let uploaded: number[] = [];
  let file: PhisCdnAdminFileV1 | null = null;
  if (upload.status === PhisCdnUploadStatusCode.Pending || upload.status === PhisCdnUploadStatusCode.Uploading) {
    uploaded = (await listPhisCdnUploadedParts(target, upload)).uploaded;
  } else if (upload.status === PhisCdnUploadStatusCode.Hashing || upload.status === PhisCdnUploadStatusCode.Published) {
    uploaded = Array.from({ length: partCount }, (_unused, index) => index + 1);
  }
  if (upload.status === PhisCdnUploadStatusCode.Published) {
    const row = await readSiteCdnFile(getPool(), target.siteId, upload.key, { includeWithdrawn: true });
    file = row ? presentPhisCdnAdminFile(row, target.cdn.publicBaseUrl) : null;
  }
  return {
    token: upload.token,
    state: namePhisCdnUploadStatus(upload.status),
    key: upload.key,
    partSizeBytes: upload.partSizeBytes,
    partCount,
    uploaded,
    expiresAt: upload.expiresAt,
    heartbeatIntervalMs: PHIS_CDN_UPLOAD_HEARTBEAT_INTERVAL_MS,
    file,
    error: upload.errorCode ? { code: upload.errorCode, message: upload.errorMessage ?? "" } : null,
  };
}
