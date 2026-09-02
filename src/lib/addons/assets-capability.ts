import "server-only";

import { randomUUID } from "node:crypto";

import type {
  PhiServerAddonAssetSlotDescriptor,
  PhiServerAddonAssetView,
  PhiServerAddonSchemaDescriptor,
  PhiServerAssetsCapabilityV1,
} from "./contract.ts";
import {
  PhiMediaDeliveryPolicy,
  PhiMediaSpaceKind,
  ensureAddonMediaSpace,
  ensureSiteMediaConfig,
  getMediaStorageProfile,
  mediaStorageProfileVerifiesSha256,
  releaseMediaSpaceReservation,
  reserveMediaSpaceQuota,
} from "@/db/media-spaces";
import {
  abortMediaUploadSessionByToken,
  createMediaAsset,
  createMediaUploadSession,
  deleteMediaAssetBySite,
  getMediaUploadSessionByToken,
  updateMediaUploadSessionByToken,
} from "@/db/media";
import {
  PhiMediaUploadPurpose,
  PhiMediaUploadSessionStatus,
  createPhiMediaUploadSessionToken,
  resolvePhiMediaUploadPlanKind,
  resolvePhiMediaUploadSessionKind,
} from "@/lib/media-upload-sessions";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { sniffPhiMediaContentType } from "@/lib/media-content-sniffer";
import { derivePhiServerAddonSchemaName } from "./schema-name.ts";
import {
  linkPhiServerAddonAsset,
  readPhiServerAddonAsset,
  readPhiServerAddonAssets,
  unlinkPhiServerAddonAsset,
  type PhiServerAddonAssetRow,
} from "@/db/server-addon-assets.mts";
import { getPool } from "@/lib/db";

/**
 * Filling the slots a table declared.
 *
 * Nothing here is a second upload lifecycle. Core reserves, receives, measures and hashes without
 * knowing who asked; this capability states the purpose at the start and reads it back at the end,
 * where the finished object becomes a row in the Add-on's table. What an Add-on says is which row and
 * which slot; where the object goes, what it is called and whether it arrived are Core's answers.
 *
 * The files live in the Add-on's own Media Space, so the Space's quota **is** the Add-on's quota. One
 * account over one set of bytes, rather than two that drift apart -- and the delivery Media already has
 * serves them, because they are Media Assets like any other.
 */

/** How long a client has to deliver a body, matching what the Media upload session allows. */
const RESERVATION_TTL_MS = 1000 * 60 * 60 * 24;

/** Enough to recognise a container. The Media finalize reads the same amount for the same reason. */
const SNIFF_BYTES = 4096;

const DELIVERY_POLICIES = {
  public: PhiMediaDeliveryPolicy.Public,
  authenticated: PhiMediaDeliveryPolicy.Authenticated,
  internal: PhiMediaDeliveryPolicy.Internal,
} as const;

export class PhiServerAddonAssetError extends Error {}

function view(row: PhiServerAddonAssetRow): PhiServerAddonAssetView {
  // No object key. A key an Add-on holds is a key it could pass to `storage:v1`, and the two spaces are
  // meant to stay apart -- what it gets instead is the Media Asset id, which the delivery route takes.
  return {
    id: row.id,
    slot: row.slot,
    ownerId: row.ownerId,
    mediaAssetId: row.mediaAssetId,
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
  actorUserId: number | null;
  schema: PhiServerAddonSchemaDescriptor | null;
  /** The same row authority the data capability writes under: attaching a file changes the row. */
  mayActOnRow: (input: { table: string; id: unknown; intent: "update" }) => Promise<boolean>;
  /** Where Core receives a body for a Provider that cannot take one directly. */
  proxyUploadUrl: (input: { token: string }) => string;
}): PhiServerAssetsCapabilityV1 {
  const { addonId, siteId, siteKey, schema } = input;
  const schemaName = derivePhiServerAddonSchemaName(addonId);

  function requireTable(table: string) {
    const declared = schema?.tables.find((entry) => entry.name === table);
    if (!declared || (declared.assets ?? []).length === 0) {
      throw new PhiServerAddonAssetError(`"${table}" declares no asset slots.`);
    }
    return { schemaName, table };
  }

  function requireSlot(table: string, slot: string): PhiServerAddonAssetSlotDescriptor {
    const declared = schema?.tables.find((entry) => entry.name === table);
    const found = (declared?.assets ?? []).find((entry) => entry.name === slot);
    if (!found) {
      throw new PhiServerAddonAssetError(`"${table}" declares no asset slot named "${slot}".`);
    }
    return found;
  }

  async function resolveSpace() {
    const space = await ensureAddonMediaSpace(siteId, addonId);
    const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
    if (!profile) {
      throw new PhiServerAddonAssetError("This Site has no default Storage Profile.");
    }
    return {
      space,
      profile,
      service: await createPhisMediaStorageServiceForProfile(profile, siteKey),
    };
  }

  /** Reads the session and proves it is this Add-on's, on this Site, in this slot. */
  async function requireSession(token: string, table: string) {
    const session = await getMediaUploadSessionByToken(token);
    const ref = session?.purposeRef as
      { addonId?: string; table?: string; ownerId?: string; slot?: string } | null | undefined;
    if (
      !session
      || session.siteId !== siteId
      || session.purpose !== PhiMediaUploadPurpose.AddonAsset
      || ref?.addonId !== addonId
      || ref?.table !== table
    ) {
      // One answer for "no such reservation" and "not yours", because the two together are what a
      // caller would otherwise use this to tell apart.
      throw new PhiServerAddonAssetError(`Reservation ${token} is not open.`);
    }
    return { session, ref: ref as { ownerId: string; slot: string } };
  }

  return Object.freeze({
    async begin({ table, ownerId, slot, contentType, sizeBytes, sha256, filename }) {
      requireTable(table);
      const declared = requireSlot(table, slot);

      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        throw new PhiServerAddonAssetError("A reservation must state a whole number of bytes above zero.");
      }
      if (sizeBytes > declared.maxBytes) {
        throw new PhiServerAddonAssetError(
          `Slot "${slot}" takes at most ${declared.maxBytes} bytes; this is ${sizeBytes}.`,
        );
      }
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
      if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new PhiServerAddonAssetError("A stated digest must be 64 lowercase hex characters.");
      }
      if (input.actorUserId == null) {
        // Every upload is somebody's. A file with no actor behind it has nobody to answer for it, and
        // the Space's own records are built around there being one.
        throw new PhiServerAddonAssetError("An upload needs an authenticated actor.");
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

      const { space, profile, service } = await resolveSpace();
      /*
       * Reserving IS the check, in one conditional statement.
       *
       * Read the total, find room, then write, and two uploads arriving together both read the same
       * figure and both proceed. And it happens now rather than at the end because the ceiling exists to
       * bound what the store holds: deciding at the end would let ten clients write a gigabyte apiece
       * and then refuse the bookkeeping for five of them, with the bytes already paid for.
       */
      if (!await reserveMediaSpaceQuota({ spaceId: space.id, bytes: sizeBytes })) {
        throw new PhiServerAddonAssetError(
          "This Add-on's store on this Site has no room for a file of that size.",
        );
      }

      const token = createPhiMediaUploadSessionToken();
      const originalName = filename?.trim() || `${slot}-${randomUUID()}`;
      const storageKey = service.createUploadTempStorageKey({ siteKey, token, originalName });
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();

      try {
        /*
         * The plan is the Provider's answer, and the digest is what decides which one it may give.
         *
         * Where the endpoint verifies a stated SHA-256, the bytes may go straight to it: a wrong digest
         * is refused there and never becomes an object, so Core can take the client's figure as true
         * without ever having seen a byte. Where it does not, the body comes through Core, which hashes
         * it in flight. Either way the digest is established rather than asserted.
         */
        const verifies = await mediaStorageProfileVerifiesSha256(siteId, profile.id);
        const plan = await service.createUploadPlan({
          token,
          storageKey,
          contentType,
          sizeBytes,
          expiresAt,
          proxyUploadUrl: input.proxyUploadUrl({ token }),
          ...(verifies && sha256 ? { checksumSha256: sha256 } : {}),
        });

        await createMediaUploadSession({
          token,
          siteId,
          actorUserId: input.actorUserId,
          spaceId: space.id,
          storageProfileId: profile.id,
          status: PhiMediaUploadSessionStatus.Pending,
          filename: originalName,
          contentType,
          sizeBytes,
          kind: resolvePhiMediaUploadSessionKind(contentType),
          uploadPlanKind: resolvePhiMediaUploadPlanKind(plan.kind),
          checksumSha256: sha256 ?? null,
          stagingStorageKey: storageKey,
          expiresAt,
          purpose: PhiMediaUploadPurpose.AddonAsset,
          purposeRef: { addonId, table, ownerId: String(ownerId), slot },
        });
        return { token, plan, expiresAt };
      } catch (error) {
        // A reservation with no session behind it is held by nothing and released by nothing, so it goes
        // back here rather than waiting for an expiry that has no row to expire.
        await releaseMediaSpaceReservation({ spaceId: space.id, bytes: sizeBytes }).catch(() => {});
        throw error;
      }
    },

    async finalize({ table, token, completion }) {
      const location = requireTable(table);
      const { session, ref } = await requireSession(token, table);
      const declared = requireSlot(table, ref.slot);

      if (session.status === PhiMediaUploadSessionStatus.Completed) {
        /*
         * Already done, so say so again rather than fail.
         *
         * A client whose answer was lost cannot tell a successful upload from a failed one, and the
         * only safe thing it can do is repeat itself. Answering with an error there would report a
         * finished file as a broken one.
         */
        const existing = await readPhiServerAddonAssets(getPool(), location, {
          siteId, ownerId: ref.ownerId, slot: ref.slot,
        });
        // Matched on the object, because that is the one thing the session and the finished row share.
        const done = existing.find((row) => row.originalName === session.filename);
        if (done) {
          return view(done);
        }
      }

      const { space, profile, service } = await resolveSpace();
      /*
       * What actually landed, asked of the storage rather than of the caller.
       *
       * A Provider that assembles parts does it in `completeUpload`; one that received the whole body
       * simply looks. `null` is how an unfinished upload tells itself apart from a finished one.
       */
      const stored = await service
        .completeUpload({ storageKey: session.stagingStorageKey, completion })
        .catch(() => null);
      if (!stored) {
        throw new PhiServerAddonAssetError(
          `Nothing has been delivered for reservation ${token}, so there is no file to finish.`,
        );
      }
      if (stored.byteSize !== session.sizeBytes) {
        /*
         * The size was agreed before any bytes moved, and this is where it is held to. Accepting a
         * different one would make the ceiling advisory: reserve a kilobyte, deliver a gigabyte, be
         * charged for the kilobyte.
         */
        await service.deleteObject(session.stagingStorageKey).catch(() => {});
        await abortMediaUploadSessionByToken(token);
        throw new PhiServerAddonAssetError(
          `Reservation ${token} was made for ${session.sizeBytes} bytes and ${stored.byteSize} arrived.`,
        );
      }

      /*
       * What the bytes say they are, against what the slot was told they would be.
       *
       * A floor and not a roof: text carries no signature, so bytes nothing recognises are accepted
       * rather than treated as proof of a lie. What it catches is the one that matters -- an executable
       * delivered into a slot that said it takes images.
       */
      const head = await service.readObjectHead(session.stagingStorageKey, SNIFF_BYTES).catch(() => null);
      const sniffed = head ? sniffPhiMediaContentType(head, session.contentType) : null;
      if (sniffed?.evidence === "signature" && sniffed.contentType !== session.contentType) {
        await service.deleteObject(session.stagingStorageKey).catch(() => {});
        await abortMediaUploadSessionByToken(token);
        throw new PhiServerAddonAssetError(
          `Reservation ${token} was made for "${session.contentType}" and the bytes are a ` +
          `"${sniffed.contentType}".`,
        );
      }

      const client = await getPool().connect();
      let linked: { id: string; supersededMediaAssetId: number | null };
      try {
        await client.query("BEGIN");
        // Reservation becomes usage in the same act that creates the row it paid for.
        const { rows: committed } = await client.query<{ id: number }>(
          `UPDATE phis.media_spaces
              SET reserved_bytes = GREATEST(0, reserved_bytes - $2),
                  used_bytes = used_bytes + $2, updated_at = NOW()
            WHERE id = $1 RETURNING id`,
          [space.id, session.sizeBytes],
        );
        if (!committed[0]) {
          throw new PhiServerAddonAssetError("The Space reservation is no longer available.");
        }
        const asset = await createMediaAsset({
          siteId,
          spaceId: space.id,
          spaceKind: PhiMediaSpaceKind.Addon,
          createdByUserId: input.actorUserId,
          storageProfileId: profile.id,
          storageKey: session.stagingStorageKey,
          originalName: session.filename,
          contentType: session.contentType,
          bytes: stored.byteSize,
          /*
           * The digest, established rather than asserted.
           *
           * Where the endpoint verifies, the client's figure is true because a wrong one would have been
           * refused. Where Core streamed the body, Core hashed it. Where neither holds, nothing is
           * recorded: `etag` is an HTTP header and not a content hash, and a column called
           * `checksum_sha256` holding an MD5 is worse than one holding nothing.
           */
          checksumSha256: session.checksumSha256 ?? null,
          deliveryPolicy: DELIVERY_POLICIES[declared.delivery ?? "public"],
        }, client);
        if (!asset) {
          throw new PhiServerAddonAssetError("The Media Asset could not be created.");
        }
        linked = await linkPhiServerAddonAsset(client, {
          location, siteId, ownerId: ref.ownerId, slot: ref.slot,
          mediaAssetId: asset.id,
          single: declared.cardinality === "one",
        });
        await client.query(
          `UPDATE phis.media_upload_sessions
              SET status = $2, finalized_at = NOW(), final_storage_key = staging_storage_key,
                  updated_at = NOW()
            WHERE token = $1`,
          [token, PhiMediaUploadSessionStatus.Completed],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      // The displaced file, removed after the row that pointed at it is gone. Media's own delete takes
      // the object and the Space's figures with it.
      if (linked.supersededMediaAssetId != null) {
        await deleteMediaAssetBySite(siteId, space.id, linked.supersededMediaAssetId).catch(() => {});
      }
      const row = await readPhiServerAddonAsset(getPool(), location, { siteId, id: linked.id });
      if (!row) {
        throw new PhiServerAddonAssetError(`Asset ${linked.id} vanished between writing and reading it.`);
      }
      return view(row);
    },

    async abandon({ table, token }) {
      requireTable(table);
      /*
       * Giving up something that is already gone is not an error.
       *
       * A client that abandons twice, or abandons what has expired, has arrived at the state it asked
       * for. Answering with a failure there would make the tidy path less safe to take than not taking
       * it, which is the wrong way round for the call that exists to keep things tidy.
       */
      const session = await getMediaUploadSessionByToken(token);
      const ref = session?.purposeRef as { addonId?: string; table?: string } | null | undefined;
      if (
        !session
        || session.siteId !== siteId
        || session.purpose !== PhiMediaUploadPurpose.AddonAsset
        || ref?.addonId !== addonId
        || ref?.table !== table
        || session.status === PhiMediaUploadSessionStatus.Completed
      ) {
        return false;
      }
      const { service } = await resolveSpace();
      await service.deleteObject(session.stagingStorageKey).catch(() => {});
      // Removes the row and gives its reservation back in one statement.
      return abortMediaUploadSessionByToken(token);
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
      // The link first, the file second: a failure there leaves a file nobody points at, which is
      // findable, rather than a row pointing at nothing, which is not.
      const mediaAssetId = await unlinkPhiServerAddonAsset(getPool(), location, { siteId, id });
      if (mediaAssetId == null) {
        return false;
      }
      const space = await ensureAddonMediaSpace(siteId, addonId);
      await deleteMediaAssetBySite(siteId, space.id, mediaAssetId).catch(() => {});
      return true;
    },
  } satisfies PhiServerAssetsCapabilityV1);
}
