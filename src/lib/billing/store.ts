import "server-only";

import { createHash } from "node:crypto";

import { ensureSiteMediaConfig, ensureSiteMediaSpace, getMediaStorageProfile, isMediaStorageProfileWritable } from "@/db/media-spaces";
import { bookPhisBillingStorage } from "@/db/billing.mts";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { getPool } from "@/lib/db";

/**
 * Core's private store of billing documents (PAYMENTS.md, billing documents): on the Site's Storage
 * Provider, under a prefix Core derives (`core/billing-documents/<site>/<year>/<id>`), never a Media Space's
 * and never an Add-on's, with no address anybody can reach but `open`'s signed one. The bytes are counted and
 * hashed on their way in, against the Site's largest object and the store's own ceiling (`billing_storage`).
 */

export class PhisBillingStoreError extends Error {}

class TooLarge extends Error {}

async function resolveStore(siteId: number, siteKey: string, intent: "read" | "write") {
  const { space } = await ensureSiteMediaSpace(siteId);
  const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
  if (!profile) throw new PhisBillingStoreError("This Site has no default Storage Profile.");
  if (intent === "write" && !isMediaStorageProfileWritable(profile)) throw new PhisBillingStoreError("This Site's Storage Profile takes no new objects.");
  return createPhisMediaStorageServiceForProfile(profile, siteKey);
}

/** The physical key of a document's file; derived, never given. */
export function phisBillingStorageKey(siteKey: string, year: number, documentId: string) {
  return `core/billing-documents/${siteKey}/${year}/${documentId}`;
}

/**
 * Streams a file into the store, hashing and counting it, and books it. `declared` (an issuer's attached
 * PDF) must match what arrives in size and digest; without it (a Provider's file) the bytes are what they
 * are, up to the Site's largest object. Answers what was stored; on any refusal nothing stays behind.
 */
export async function putPhisBillingFile(input: {
  siteId: number; siteKey: string; storageKey: string; contentType: "application/pdf" | "text/html"; body: ReadableStream<Uint8Array>;
  declared: { byteSize: number; sha256: string } | null;
}): Promise<{ byteSize: number; sha256: string }> {
  const maxBytes = (await ensureSiteMediaConfig(input.siteId)).maxObjectBytes;
  if (input.declared && (!Number.isInteger(input.declared.byteSize) || input.declared.byteSize <= 0 || input.declared.byteSize > maxBytes
    || !/^[0-9a-f]{64}$/u.test(input.declared.sha256))) {
    throw new PhisBillingStoreError(`A file states a size from 1 to ${maxBytes} bytes and a lowercase sha256.`);
  }
  const limit = input.declared?.byteSize ?? maxBytes;
  if (input.declared && await bookPhisBillingStorage(getPool(), input.siteId, input.declared.byteSize, 1) === "over-quota") {
    throw new PhisBillingStoreError("This Site's billing store is full.");
  }
  const hash = createHash("sha256");
  let seen = 0;
  const counted = input.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) throw new TooLarge();
      hash.update(chunk);
      controller.enqueue(chunk);
    },
  }));
  const service = await resolveStore(input.siteId, input.siteKey, "write");
  const giveBack = () => input.declared ? bookPhisBillingStorage(getPool(), input.siteId, -input.declared.byteSize, -1).catch(() => {}) : Promise.resolve();
  try {
    const head = await service.putObjectStream({ storageKey: input.storageKey, body: counted, contentType: input.contentType });
    const sha256 = hash.digest("hex");
    if (head.byteSize !== seen || seen === 0 || (input.declared && (seen !== input.declared.byteSize || sha256 !== input.declared.sha256))) {
      throw new PhisBillingStoreError(input.declared ? "The file is not the one declared: its size or digest differs." : "The file arrived empty or incomplete.");
    }
    if (!input.declared && await bookPhisBillingStorage(getPool(), input.siteId, seen, 1) === "over-quota") {
      throw new PhisBillingStoreError("This Site's billing store is full.");
    }
    return { byteSize: seen, sha256 };
  } catch (error) {
    await service.deleteObject(input.storageKey).catch(() => {});
    await giveBack();
    if (error instanceof TooLarge) throw new PhisBillingStoreError(`The file is larger than ${limit} bytes.`);
    throw error;
  }
}

/** The stored bytes of a document's file; `null` where the store does not have them. */
export async function readPhisBillingFile(siteId: number, siteKey: string, storageKey: string) {
  const service = await resolveStore(siteId, siteKey, "read");
  return service.getObjectStream(storageKey);
}

/** Removes a document's file and gives its booking back. */
export async function deletePhisBillingFile(siteId: number, siteKey: string, storageKey: string, byteSize: number) {
  const service = await resolveStore(siteId, siteKey, "read");
  await service.deleteObject(storageKey);
  await bookPhisBillingStorage(getPool(), siteId, -byteSize, -1).catch(() => {});
}
