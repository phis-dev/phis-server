import "server-only";

import type { PhisMediaObjectHead } from "@phis/contracts/addon";

import type {
  PhiServerAddonAssetView,
  PhiServerAddonSchemaDescriptor,
  PhiServerAssetsCapabilityV1,
} from "./contract.ts";
import {
  ensureSiteMediaConfig,
  ensureSiteMediaSpace,
  getMediaStorageProfile,
  mediaStorageProfileVerifiesSha256,
} from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import {
  abandonPhiServerAddonAsset,
  beginPhiServerAddonAsset,
  finalizePhiServerAddonAsset,
  phiServerAddonAssetKey,
  readPhiServerAddonAssets,
  removePhiServerAddonAsset,
  type PhiServerAddonAssetRow,
} from "@/db/server-addon-assets.mts";
import { bookPhiServerAddonStorage } from "@/db/server-addon-storage-usage.mts";
import { getPool } from "@/lib/db";
import { sniffPhiMediaContentType } from "@/lib/media-content-sniffer";

/**
 * Filling the slots a table declared.
 *
 * Everything an Add-on could get wrong here is a thing Core does instead. It does not name the object,
 * so no key it writes can reach outside its own prefix or collide with another row's. It does not say
 * how big the file turned out, so the ceiling is charged against what landed rather than what was
 * claimed. And it does not decide when the row becomes visible: a reservation is `pending` until Core
 * has looked at the object.
 *
 * A reservation costs its bytes the moment it is made, not when it is redeemed. Booking on finalize
 * would let a store be filled by uploads that are merely started -- the ceiling would hold on paper
 * while the objects accumulate underneath it. The cost is a reservation that expires with its bytes
 * still booked, which the sweep gives back.
 */

/** How long a client has to deliver a body, matching what the Media upload session allows. */
const RESERVATION_TTL_MS = 1000 * 60 * 60 * 24;

/** Enough to recognise a container. The Media finalize reads the same amount for the same reason. */
const SNIFF_BYTES = 4096;

export class PhiServerAddonAssetError extends Error {}

function view(row: PhiServerAddonAssetRow): PhiServerAddonAssetView {
  // The object key is absent on purpose: an Add-on that held one could pass it to `storage:v1`, and the
  // two key spaces have to stay apart for the sweep to be safe.
  return {
    id: row.id,
    slot: row.slot,
    ownerId: row.ownerId,
    byteSize: row.byteSize,
    contentType: row.contentType,
    checksumSha256: row.checksumSha256,
    createdAt: row.createdAt,
  };
}

export function buildPhiServerAddonAssetsCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  schema: PhiServerAddonSchemaDescriptor | null;
  /** The same row authority the data capability writes under: attaching a file changes the row. */
  mayActOnRow: (input: { table: string; id: unknown; intent: "update" }) => Promise<boolean>;
  /** Where Core receives a body for a Provider that cannot take one directly. */
  proxyUploadUrl: (input: { table: string; token: string }) => string;
}): PhiServerAssetsCapabilityV1 {
  const { addonId, siteId, siteKey, schema } = input;
  const schemaName = derivePhiServerAddonSchemaName(addonId);

  function requireSlot(table: string, slot: string) {
    const declared = schema?.tables.find((entry) => entry.name === table);
    if (!declared) {
      throw new PhiServerAddonAssetError(`"${table}" is not a table this Add-on declares.`);
    }
    const found = (declared.assets ?? []).find((entry) => entry.name === slot);
    if (!found) {
      throw new PhiServerAddonAssetError(`"${table}" declares no asset slot named "${slot}".`);
    }
    return found;
  }

  function requireTable(table: string) {
    const declared = schema?.tables.find((entry) => entry.name === table);
    if (!declared || (declared.assets ?? []).length === 0) {
      throw new PhiServerAddonAssetError(`"${table}" declares no asset slots.`);
    }
    return { schemaName, table };
  }

  async function resolveStorage() {
    const { space } = await ensureSiteMediaSpace(siteId);
    const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
    if (!profile) {
      throw new PhiServerAddonAssetError("This Site has no default Storage Profile.");
    }
    return {
      service: await createPhisMediaStorageServiceForProfile(profile, siteKey),
      profileId: profile.id,
    };
  }

  /** Gives back what a row's object was booked at, and never lets a failure here hide the real one. */
  async function release(row: PhiServerAddonAssetRow) {
    await bookPhiServerAddonStorage(getPool(), {
      addonId, siteId, bytes: -row.byteSize, objects: -1,
    }).catch(() => {});
  }

  async function removeObject(row: PhiServerAddonAssetRow) {
    const resolved = await resolveStorage().catch(() => null);
    await resolved?.service.deleteObject(row.storageKey).catch(() => {});
  }

  return Object.freeze({
    async begin({ table, ownerId, slot, contentType, sizeBytes }) {
      const location = requireTable(table);
      const declared = requireSlot(table, slot);

      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        throw new PhiServerAddonAssetError("A reservation must state a whole number of bytes above zero.");
      }
      if (sizeBytes > declared.maxBytes) {
        throw new PhiServerAddonAssetError(
          `Slot "${slot}" takes at most ${declared.maxBytes} bytes; this is ${sizeBytes}.`,
        );
      }
      // The Site's own ceiling as well, so an operator who lowered it lowered it for Add-ons too.
      const maxObjectBytes = (await ensureSiteMediaConfig(siteId)).maxObjectBytes;
      if (sizeBytes > maxObjectBytes) {
        throw new PhiServerAddonAssetError(
          `Object is ${sizeBytes} bytes; this Site allows ${maxObjectBytes}.`,
        );
      }
      if (!declared.contentTypes.includes(contentType)) {
        throw new PhiServerAddonAssetError(
          `Slot "${slot}" takes ${declared.contentTypes.join(", ")}; this is "${contentType}".`,
        );
      }
      /*
       * The row's authority, not the slot's. Putting a file on a row changes it, so whoever may change
       * it may put one there -- which keeps this from becoming a second, quieter way past the ladder.
       */
      if (!await input.mayActOnRow({ table, id: ownerId, intent: "update" })) {
        throw new PhiServerAddonAssetError(
          `Row ${String(ownerId)} of "${table}" is not this caller's to change.`,
        );
      }

      const booked = await bookPhiServerAddonStorage(getPool(), {
        addonId, siteId, bytes: sizeBytes, objects: 1,
      });
      if (booked === "not-activated") {
        throw new PhiServerAddonAssetError(
          `${addonId} is not activated for this Site, so it has no store here.`,
        );
      }
      if (booked === "over-quota") {
        throw new PhiServerAddonAssetError(
          "This Add-on's store on this Site has no room for a file of that size.",
        );
      }

      const storageKey = phiServerAddonAssetKey(table, slot);
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
      let reservation;
      try {
        reservation = await beginPhiServerAddonAsset(getPool(), {
          location, siteId, ownerId, slot, contentType, sizeBytes, storageKey, expiresAt,
        });
      } catch (error) {
        // The booking stands only for a row that exists. A refused insert -- a single-valued slot with a
        // reservation already open, an owner id naming no row -- must not leave its bytes charged.
        await bookPhiServerAddonStorage(getPool(), {
          addonId, siteId, bytes: -sizeBytes, objects: -1,
        }).catch(() => {});
        throw error;
      }

      const { service } = await resolveStorage();
      const plan = await service.createUploadPlan({
        token: reservation.token,
        storageKey,
        contentType,
        sizeBytes,
        expiresAt: reservation.expiresAt,
        proxyUploadUrl: input.proxyUploadUrl({ table, token: reservation.token }),
      });
      return { id: reservation.id, plan, expiresAt: reservation.expiresAt };
    },

    async finalize({ table, id, completion }) {
      const location = requireTable(table);
      const { service, profileId } = await resolveStorage();
      const pool = getPool();

      const { rows } = await pool.query<{
        storage_key: string; byte_size: string; content_type: string; slot: string;
      }>(
        `SELECT storage_key, byte_size, content_type, slot
           FROM "${schemaName}"."${table}_assets"
          WHERE id = $1 AND site_id = $2 AND status = 1`,
        [id, siteId],
      );
      const pending = rows[0];
      if (!pending) {
        throw new PhiServerAddonAssetError(`Reservation ${id} is not open.`);
      }

      /*
       * What is actually there, asked of the storage rather than of the caller.
       *
       * A Provider that assembles parts does it in `completeUpload`; one that received the whole body
       * simply looks. Either way the answer is the object, and `null` is how an unfinished upload tells
       * itself apart from a finished one.
       */
      const stored: PhisMediaObjectHead | null = await service
        .completeUpload({ storageKey: pending.storage_key, completion })
        .catch(() => null);
      if (!stored) {
        throw new PhiServerAddonAssetError(
          `Nothing has been delivered for reservation ${id}, so there is no file to finish.`,
        );
      }
      const reserved = Number(pending.byte_size);
      if (stored.byteSize !== reserved) {
        /*
         * The size was agreed before any bytes moved, and this is where it is held to. Accepting a
         * different one would make the ceiling advisory: a client could reserve a kilobyte, deliver a
         * gigabyte, and have the store charged for the kilobyte.
         */
        throw new PhiServerAddonAssetError(
          `Reservation ${id} was made for ${reserved} bytes and ${stored.byteSize} arrived.`,
        );
      }

      /*
       * What the bytes say they are, against what the slot was told they would be.
       *
       * A content type in a header is a claim; the first kilobytes are evidence. This is a floor and not
       * a roof -- text formats carry no signature, so bytes nothing recognises are accepted rather than
       * treated as proof of a lie. What it does catch is the one that matters here: an executable
       * delivered into a slot that said it takes images.
       */
      const head = await service.readObjectHead(pending.storage_key, SNIFF_BYTES).catch(() => null);
      const sniffed = head ? sniffPhiMediaContentType(head, pending.content_type) : null;
      if (sniffed?.evidence === "signature" && sniffed.contentType !== pending.content_type) {
        throw new PhiServerAddonAssetError(
          `Reservation ${id} was made for "${pending.content_type}" and the bytes are a ` +
          `"${sniffed.contentType}".`,
        );
      }

      const declared = requireSlot(table, pending.slot);
      const verifies = await mediaStorageProfileVerifiesSha256(siteId, profileId);
      const client = await pool.connect();
      let result;
      try {
        await client.query("BEGIN");
        result = await finalizePhiServerAddonAsset(client, {
          location, id, byteSize: stored.byteSize,
          /*
           * A digest only where the endpoint was found to check one.
           *
           * `etag` is an HTTP header, not a content hash: the Local adapter happens to fill it with a
           * real streaming SHA-256, S3 fills it with an MD5, and a multipart object gets a composite
           * that is no hash of anything. Recording whichever of those turned up would put a column
           * called `checksum_sha256` in front of somebody who would reasonably compare against it.
           *
           * So the Profile's probe decides, and a Profile nobody probed answers no. Absent is a truthful
           * "not established"; a wrong digest is worse than none.
           */
          checksumSha256: verifies && /^[0-9a-f]{64}$/.test(stored.etag) ? stored.etag : null,
          single: declared.cardinality === "one",
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      if (!result) {
        throw new PhiServerAddonAssetError(`Reservation ${id} is not open.`);
      }
      // The replaced file's object, removed after its row is gone: the other order hands the space back
      // while something still points at it.
      if (result.superseded) {
        await removeObject(result.superseded);
        await release(result.superseded);
      }
      return view(result.asset);
    },

    async abandon({ table, id }) {
      const location = requireTable(table);
      const row = await abandonPhiServerAddonAsset(getPool(), location, { id, siteId });
      if (!row) {
        return false;
      }
      await removeObject(row);
      await release(row);
      return true;
    },

    async list({ table, ownerId, slot }) {
      const location = requireTable(table);
      if (slot !== undefined) {
        requireSlot(table, slot);
      }
      const rows = await readPhiServerAddonAssets(getPool(), location, { siteId, ownerId, slot });
      return rows.map(view);
    },

    async remove({ table, id }) {
      const location = requireTable(table);
      const row = await removePhiServerAddonAsset(getPool(), location, { id, siteId });
      if (!row) {
        return false;
      }
      await removeObject(row);
      await release(row);
      return true;
    },
  } satisfies PhiServerAssetsCapabilityV1);
}
