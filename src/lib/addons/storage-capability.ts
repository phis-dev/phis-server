import "server-only";

import type { PhiServerStorageCapabilityV1 } from "./contract.ts";
import { ensureSiteMediaSpace, getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";

/**
 * A private object store for one Add-on on one Site.
 *
 * The prefix is derived, never given. An Add-on hands in a relative key and gets a relative key back;
 * the physical one exists only inside this file, so there is no address an Add-on could store, guess,
 * or be tricked into passing. That is the same rule the install root follows, and it is what makes the
 * isolation structural rather than a check somebody has to keep writing.
 *
 * The bytes go through the Site's configured Storage Provider, so an operator who moved a Site to S3
 * moved its Add-ons with it and did not have to be asked twice.
 */

/** `addons/<derived addon name>/<site key>/` -- the schema-name derivation, reused for a path. */
function derivePrefix(addonId: string, siteKey: string) {
  return `addons/${derivePhiServerAddonSchemaName(addonId)}/${siteKey}`;
}

/**
 * A key an Add-on may use, or nothing.
 *
 * Segment-wise rather than by pattern: `..` is rejected as a segment, not searched for as a substring,
 * so a name that merely contains two dots stays usable while one that traverses cannot be spelled.
 */
function normalizeRelativeKey(key: string) {
  const segments = key.split("/").map((segment) => segment.trim());
  if (segments.length === 0 || segments.length > 8) {
    return null;
  }
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > 128 || segment === "." || segment === "..") {
      return null;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment)) {
      return null;
    }
  }
  return segments.join("/");
}

export class PhiServerAddonStorageError extends Error {}

function requireKey(key: string) {
  const normalized = normalizeRelativeKey(key);
  if (!normalized) {
    throw new PhiServerAddonStorageError(`"${key}" is not a usable object key.`);
  }
  return normalized;
}

async function resolveStorage(siteId: number, siteKey: string, addonId: string) {
  // The Site Space carries the default Storage Profile, which is what "where this Site's bytes live"
  // means. An Add-on does not choose a Profile: that is the operator's decision for the whole Site.
  const { space } = await ensureSiteMediaSpace(siteId);
  const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
  if (!profile) {
    throw new PhiServerAddonStorageError("This Site has no default Storage Profile.");
  }
  const service = await createPhisMediaStorageServiceForProfile(profile, siteKey);
  return { service, prefix: derivePrefix(addonId, siteKey) };
}

export function buildPhiServerAddonStorageCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  readMaxObjectBytes: () => Promise<number>;
}): PhiServerStorageCapabilityV1 {
  const { addonId, siteId, siteKey, readMaxObjectBytes } = input;
  return Object.freeze({
    async put({ key, body, contentType }) {
      const relative = requireKey(key);
      // The Site's own ceiling, not one this file invents: an operator who raised it for Media raised
      // it here too, and one limit is easier to reason about than two.
      const maxObjectBytes = await readMaxObjectBytes();
      if (body.byteLength > maxObjectBytes) {
        throw new PhiServerAddonStorageError(
          `Object is ${body.byteLength} bytes; this Site allows ${maxObjectBytes}.`,
        );
      }
      const { service, prefix } = await resolveStorage(siteId, siteKey, addonId);
      await service.putObject({
        storageKey: `${prefix}/${relative}`,
        body: Buffer.from(body),
        contentType,
      });
      return { key: relative, byteSize: body.byteLength };
    },

    async get(key) {
      const relative = requireKey(key);
      const { service, prefix } = await resolveStorage(siteId, siteKey, addonId);
      const storageKey = `${prefix}/${relative}`;
      // The head carries the content type; the object is only bytes. Both or nothing, so a caller never
      // has to guess what it was handed.
      const head = await service.headObject(storageKey).catch(() => null);
      const body = head ? await service.getObject(storageKey).catch(() => null) : null;
      return head && body
        ? { body: new Uint8Array(body), contentType: head.contentType }
        : null;
    },

    async head(key) {
      const relative = requireKey(key);
      const { service, prefix } = await resolveStorage(siteId, siteKey, addonId);
      const head = await service.headObject(`${prefix}/${relative}`).catch(() => null);
      return head
        ? { key: relative, byteSize: head.byteSize, contentType: head.contentType }
        : null;
    },

    async remove(key) {
      const relative = requireKey(key);
      const { service, prefix } = await resolveStorage(siteId, siteKey, addonId);
      const existed = await service.headObject(`${prefix}/${relative}`).catch(() => null);
      if (!existed) {
        return false;
      }
      await service.deleteObject(`${prefix}/${relative}`);
      return true;
    },

    async list(prefix) {
      const relative = prefix == null || prefix === "" ? "" : requireKey(prefix);
      const { service, prefix: root } = await resolveStorage(siteId, siteKey, addonId);
      const heads = await service.listPrefix(relative ? `${root}/${relative}` : root);
      // Handed back relative, so what an Add-on receives is what it may pass in again.
      return heads
        .map((head) => head.storageKey.slice(root.length + 1))
        .filter((key) => key.length > 0);
    },
  } satisfies PhiServerStorageCapabilityV1);
}
