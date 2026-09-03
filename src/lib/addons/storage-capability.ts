import "server-only";

import type { PhisStorageCapabilityV1 } from "./contract.ts";
import { ensureSiteMediaSpace, getMediaStorageProfile } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { phiServerAddonStoragePrefix } from "./schema-name.ts";
import {
  bookPhisAddonStorage,
  readPhisAddonStorageUsage,
} from "@/db/server-addon-storage-usage.mts";
import { getPool } from "@/lib/db";

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

export class PhisAddonStorageError extends Error {}

function requireKey(key: string) {
  const normalized = normalizeRelativeKey(key);
  if (!normalized) {
    throw new PhisAddonStorageError(`"${key}" is not a usable object key.`);
  }
  return normalized;
}

async function resolveStorage(siteId: number, siteKey: string, addonId: string) {
  // The Site Space carries the default Storage Profile, which is what "where this Site's bytes live"
  // means. An Add-on does not choose a Profile: that is the operator's decision for the whole Site.
  const { space } = await ensureSiteMediaSpace(siteId);
  const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
  if (!profile) {
    throw new PhisAddonStorageError("This Site has no default Storage Profile.");
  }
  const service = await createPhisMediaStorageServiceForProfile(profile, siteKey);
  return { service, prefix: phiServerAddonStoragePrefix(addonId, siteKey) };
}

export function buildPhisAddonStorageCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  readMaxObjectBytes: () => Promise<number>;
}): PhisStorageCapabilityV1 {
  const { addonId, siteId, siteKey, readMaxObjectBytes } = input;
  return Object.freeze({
    async put({ key, body, contentType }) {
      const relative = requireKey(key);
      // The Site's own ceiling, not one this file invents: an operator who raised it for Media raised
      // it here too, and one limit is easier to reason about than two.
      const maxObjectBytes = await readMaxObjectBytes();
      if (body.byteLength > maxObjectBytes) {
        throw new PhisAddonStorageError(
          `Object is ${body.byteLength} bytes; this Site allows ${maxObjectBytes}.`,
        );
      }
      const { service, prefix } = await resolveStorage(siteId, siteKey, addonId);
      const storageKey = `${prefix}/${relative}`;

      /*
       * What this write costs, which is not what it weighs.
       *
       * Writing over an existing key replaces it: the store grows by the difference and gains no object.
       * Counting the whole body every time would charge an Add-on that rewrites one file each hour as
       * though it kept every version, and the total would climb until the ceiling refused a store that
       * had never actually grown.
       */
      const existing = await service.headObject(storageKey).catch(() => null);
      const deltaBytes = body.byteLength - (existing?.byteSize ?? 0);
      const deltaObjects = existing ? 0 : 1;

      /*
       * Booked before the bytes are written, and given back if they are not.
       *
       * The other order would let two uploads racing each other both find room and both proceed. The
       * cost of this order is a booking left standing when the storage fails after accepting it, which
       * the release below returns -- capacity briefly overstated is a smaller fault than a ceiling that
       * does not hold.
       */
      const booked = await bookPhisAddonStorage(getPool(), {
        addonId, siteId, bytes: deltaBytes, objects: deltaObjects,
      });
      if (booked === "not-activated") {
        // Said plainly, because the alternative reads "0 of unlimited bytes" and sends whoever gets it
        // to raise a ceiling that was never the problem.
        throw new PhisAddonStorageError(
          `${addonId} is not activated for this Site, so it has no store here.`,
        );
      }
      if (booked === "over-quota") {
        const usage = await readPhisAddonStorageUsage(getPool(), { addonId, siteId });
        throw new PhisAddonStorageError(
          `This Add-on's store on this Site is full: ` +
          `${usage.bytes} of ${usage.quotaBytes ?? "unlimited"} bytes, ` +
          `${usage.objects} of ${usage.quotaObjects ?? "unlimited"} objects.`,
        );
      }

      try {
        await service.putObject({ storageKey, body: Buffer.from(body), contentType });
      } catch (error) {
        await bookPhisAddonStorage(getPool(), {
          addonId, siteId, bytes: -deltaBytes, objects: -deltaObjects,
        }).catch(() => {});
        throw error;
      }
      return { key: relative, byteSize: body.byteLength };
    },

    async usage() {
      return readPhisAddonStorageUsage(getPool(), { addonId, siteId });
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
      // Given back after the object is gone, not before: capacity briefly understated costs an Add-on
      // one refusal it could have avoided, while the other order would hand out room still occupied.
      await bookPhisAddonStorage(getPool(), {
        addonId, siteId, bytes: -existed.byteSize, objects: -1,
      }).catch(() => {});
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
  } satisfies PhisStorageCapabilityV1);
}
