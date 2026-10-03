import "server-only";

import { randomUUID } from "node:crypto";

import type {
  PhisAddonAssetSlotDescriptor,
  PhisAddonAssetView,
  PhisAddonSchemaDescriptor,
  PhisAssetsCapabilityV1,
  PhisRowIntent,
} from "./contract.ts";
import {
  PhiMediaDeliveryPolicy,
  PhisMediaSpaceKind,
  commitMediaSpaceReservationWithDb,
  ensureAddonMediaSpace,
  ensureSiteMediaConfig,
  getMediaStorageProfile,
  releaseMediaSpaceReservation,
  reserveMediaSpaceQuota,
  resolveEffectiveMediaQuotaBytes,
} from "@/db/media-spaces";
import { resolvePhiMediaDeliveryUrl } from "@/lib/media-response";
import {
  abortMediaUploadSessionByToken,
  deleteMediaUploadSessionWithDb,
  createMediaAsset,
  createMediaUploadSession,
  getMediaAssetBySiteAndChecksum,
  getMediaAssetBySiteAndId,
  getMediaUploadSessionByToken,
} from "@/db/media";
import {
  PhiMediaUploadPurpose,
  PhiMediaUploadSessionStatus,
  createPhiMediaUploadSessionToken,
  resolvePhiMediaUploadPlanKind,
  resolvePhiMediaUploadSessionKind,
} from "@/lib/media-upload-sessions";
import { deleteStoredPhiMediaAsset } from "@/lib/media-asset-delete";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import { PHI_MEDIA_UPLOAD_SESSION_TTL_MS } from "@/lib/media-storage-policies-core";
import { phiMediaStorageProfileChecksumAlgorithm } from "@/lib/media-storage-profile-probe";
import { sniffPhiMediaContentType } from "@/lib/media-content-sniffer";
import { derivePhisAddonSchemaName } from "./schema-name.ts";
import {
  linkPhisAddonAsset,
  writePhisAddonAssetMirror,
  readPhisAddonAsset,
  readPhisAddonAssets,
  unlinkPhisAddonAsset,
  type PhisAddonAssetRow,
} from "@/db/server-addon-assets.mts";
import { getPool, withTransaction } from "@/lib/db";

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

/*
 * How long a client has to deliver a body: the same figure the Media upload routes use, read from where the
 * storage lifecycle rules are derived from it. Two copies of this number would mean a storage cleaning up
 * after sessions that are still running, or long after they are gone.
 */
const RESERVATION_TTL_MS = PHI_MEDIA_UPLOAD_SESSION_TTL_MS;

/** Enough to recognise a container. The Media finalize reads the same amount for the same reason. */
const SNIFF_BYTES = 4096;

const DELIVERY_POLICIES = {
  public: PhiMediaDeliveryPolicy.Public,
  authenticated: PhiMediaDeliveryPolicy.Authenticated,
  internal: PhiMediaDeliveryPolicy.Internal,
} as const;

export class PhisAddonAssetError extends Error {}

function view(row: PhisAddonAssetRow): PhisAddonAssetView {
  // No object key. A key an Add-on holds is a key it could pass to `storage:v1`, and the two spaces are
  // meant to stay apart -- what it gets instead is Core's own address for the file.
  return {
    id: row.id,
    slot: row.slot,
    ownerId: row.ownerId,
    mediaAssetId: row.mediaAssetId,
    // Built here rather than described in the contract: the route and its cache revision are Core's,
    // and a path composed without the revision is one that revalidates forever and looks fine doing it.
    contentPath: resolvePhiMediaDeliveryUrl({
      id: row.mediaAssetId,
      deliveryRevision: row.deliveryRevision,
    }),
    byteSize: row.byteSize,
    contentType: row.contentType,
    checksum: row.checksumAlgorithm && row.checksumValue
      ? { algorithm: row.checksumAlgorithm, value: row.checksumValue }
      : null,
    createdAt: row.createdAt,
  };
}

export function buildPhisAddonAssetsCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  actorUserId: number | null;
  schema: PhisAddonSchemaDescriptor | null;
  /** The same row authority the data capability writes under: attaching a file changes the row. */
  mayActOnRow: (input: { table: string; id: unknown; intent: PhisRowIntent }) => Promise<boolean>;
  /** Where Core receives a body for a Provider that cannot take one directly. */
  proxyUploadUrl: (input: { token: string }) => string;
}): PhisAssetsCapabilityV1 {
  const { addonId, siteId, siteKey, schema } = input;
  const schemaName = derivePhisAddonSchemaName(addonId);

  function requireTable(table: string) {
    const declared = schema?.tables.find((entry) => entry.name === table);
    if (!declared || (declared.assets ?? []).length === 0) {
      throw new PhisAddonAssetError(`"${table}" declares no asset slots.`);
    }
    return { schemaName, table };
  }

  /** The column `owner_id` points at: the asset table's foreign key names it, so the mirror must too. */
  function ownerKeyColumn(table: string) {
    return schema!.tables.find((entry) => entry.name === table)!.primaryKey[0]!;
  }

  function requireSlot(table: string, slot: string): PhisAddonAssetSlotDescriptor {
    const declared = schema?.tables.find((entry) => entry.name === table);
    const found = (declared?.assets ?? []).find((entry) => entry.name === slot);
    if (!found) {
      throw new PhisAddonAssetError(`"${table}" declares no asset slot named "${slot}".`);
    }
    return found;
  }

  /**
   * The row's authority, not the slot's -- and asked in every direction, not only where a file arrives.
   *
   * A file is part of the row it hangs off. Putting one there changes the row, taking one away changes
   * it too, and asking what a row carries is reading the row. Checking only the arriving file would
   * leave the other two as a quieter way past the same ladder, which is the thing this check exists to
   * prevent. The slot's `delivery` cannot stand in for it either: a file whose id, name and size are
   * readable by anyone has already given up most of what `internal` was keeping.
   */
  async function requireRowAuthority(table: string, ownerId: unknown, intent: PhisRowIntent) {
    if (!await input.mayActOnRow({ table, id: ownerId, intent })) {
      throw new PhisAddonAssetError(
        `Row ${String(ownerId)} of "${table}" is not this caller's to ` +
        `${intent === "read" ? "read" : "change"}.`,
      );
    }
  }

  async function resolveSpace() {
    const space = await ensureAddonMediaSpace(siteId, addonId);
    const profile = await getMediaStorageProfile(siteId, space.defaultStorageProfileId);
    if (!profile) {
      throw new PhisAddonAssetError("This Site has no default Storage Profile.");
    }
    return {
      space,
      profile,
      service: await createPhisMediaStorageServiceForProfile(profile, siteKey),
    };
  }

  /**
   * Gives a file up entirely: the object, the variants derived from it, the row and the Space's figures.
   *
   * Best effort by construction. Both callers have already removed what pointed at the file, and the
   * link is the part that had to succeed -- a file nobody points at is findable and can be swept, where
   * a row pointing at nothing is neither.
   *
   * The Space is checked rather than assumed. The id comes out of this Add-on's own link table, so a
   * file from anywhere else would be a fault in Core; but the argument reaches a delete either way, and
   * a delete that ranges further than the caller can address is not one to leave standing on an
   * argument about who could have written the id.
   */
  async function release(spaceId: number, mediaAssetId: number) {
    const asset = await getMediaAssetBySiteAndId(siteId, mediaAssetId);
    if (!asset || asset.spaceId !== spaceId) {
      return;
    }
    await deleteStoredPhiMediaAsset(asset, siteKey).catch(() => {});
  }

  /**
   * Reads the session and proves it is this Add-on's, on this Site, in this slot, and this caller's.
   *
   * The actor is checked here for the reason the delivery route checks it there: a reservation names
   * who it was made for, and only they may redeem it. Without it the row authority `begin` established
   * would hold for one call and be spendable by whoever else came to hold the token.
   */
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
      || session.actorUserId !== input.actorUserId
    ) {
      // One answer for "no such reservation" and "not yours", because the two together are what a
      // caller would otherwise use this to tell apart.
      throw new PhisAddonAssetError(`Reservation ${token} is not open.`);
    }
    return { session, ref: ref as { ownerId: string; slot: string } };
  }

  return Object.freeze({
    async begin({ table, ownerId, slot, contentType, sizeBytes, sha256, filename }) {
      requireTable(table);
      const declared = requireSlot(table, slot);

      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
        throw new PhisAddonAssetError("A reservation must state a whole number of bytes above zero.");
      }
      if (sizeBytes > declared.maxBytes) {
        throw new PhisAddonAssetError(
          `Slot "${slot}" takes at most ${declared.maxBytes} bytes; this is ${sizeBytes}.`,
        );
      }
      const maxObjectBytes = (await ensureSiteMediaConfig(siteId)).maxObjectBytes;
      if (sizeBytes > maxObjectBytes) {
        throw new PhisAddonAssetError(
          `Object is ${sizeBytes} bytes; this Site allows ${maxObjectBytes}.`,
        );
      }
      if (!declared.contentTypes.includes(contentType)) {
        throw new PhisAddonAssetError(
          `Slot "${slot}" takes ${declared.contentTypes.join(", ")}; this is "${contentType}".`,
        );
      }
      if (sha256 !== undefined && !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new PhisAddonAssetError("A stated digest must be 64 lowercase hex characters.");
      }
      if (input.actorUserId == null) {
        // Every upload is somebody's. A file with no actor behind it has nobody to answer for it, and
        // the Space's own records are built around there being one.
        throw new PhisAddonAssetError("An upload needs an authenticated actor.");
      }
      // Putting a file on a row changes it, so whoever may change it may put one there.
      await requireRowAuthority(table, ownerId, "update");

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
        throw new PhisAddonAssetError(
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
         * Where the endpoint verifies a digest the client states, the bytes may go straight to it: a
         * wrong one is refused there and never becomes an object, so Core can take the client's figure
         * as true without ever having seen a byte. Where it does not, the body comes through Core,
         * which hashes it in flight. Either way the digest is established rather than asserted.
         *
         * Which algorithm was settled for this Profile when it was probed. The Add-on states a SHA-256,
         * so a Profile that verifies something else cannot use the client's figure at all -- the body
         * takes the proxied path and Core hashes it, which is the same answer under the same name.
         */
        const algorithm = await phiMediaStorageProfileChecksumAlgorithm(profile, siteKey);
        const verifies = algorithm === "sha256";
        const plan = await service.createUploadPlan({
          token,
          storageKey,
          contentType,
          sizeBytes,
          expiresAt,
          proxyUploadUrl: input.proxyUploadUrl({ token }),
          ...(verifies && sha256 ? { checksum: { algorithm: "sha256" as const, value: sha256 } } : {}),
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
          // Recorded only where something will verify it; otherwise it is the client's claim, and
          // finalize would have no way to tell it apart from an established digest.
          checksumAlgorithm: verifies && sha256 ? "sha256" : null,
          checksumValue: verifies && sha256 ? sha256 : null,
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

      /*
       * No "already done" answer: the row goes with the commit below, so a repeated call finds no
       * reservation and is refused like any other token that names none. It used to stay behind,
       * marked complete, so that a client whose answer was lost could ask again -- and every expiry
       * release read that row as a reservation still held and gave its bytes back a second time,
       * while the sweep took its key for a staged remain and deleted the finished file. A client
       * that lost the answer asks `list` whether the file is there, which is what the finished row
       * is for.
       */
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
        throw new PhisAddonAssetError(
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
        throw new PhisAddonAssetError(
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
        throw new PhisAddonAssetError(
          `Reservation ${token} was made for "${session.contentType}" and the bytes are a ` +
          `"${sniffed.contentType}".`,
        );
      }

      /*
       * The digest, settled the same way the upload route settles it.
       *
       * The session's own first: it was signed into the request, so the endpoint refused anything that did
       * not match, or Core hashed the body as it streamed. Failing that, whatever the Provider can attest
       * about the stored object -- an MD5 from a single-request ETag is evidence of an intact transfer and
       * is recorded as that, never compared. Where neither holds, nothing is recorded.
       */
      const settledChecksum = session.checksumAlgorithm && session.checksumValue
        ? { algorithm: session.checksumAlgorithm, value: session.checksumValue }
        : stored.checksum ?? null;
      if (
        session.checksumAlgorithm && session.checksumValue && stored.checksum &&
        (stored.checksum.algorithm !== session.checksumAlgorithm ||
          stored.checksum.value !== session.checksumValue)
      ) {
        await service.deleteObject(session.stagingStorageKey).catch(() => {});
        await abortMediaUploadSessionByToken(token);
        throw new PhisAddonAssetError(
          `Reservation ${token} was signed for ${session.checksumAlgorithm}:${session.checksumValue} and the ` +
          `stored object carries ${stored.checksum.algorithm}:${stored.checksum.value}.`,
        );
      }

      /*
       * Duplicate detection, which this path did not do.
       *
       * The upload route refuses a body whose digest already names an Asset in the same Space, and there is
       * no reason an Add-on's upload should be the exception: it would mean the same file stored twice,
       * charged twice against the Space, with nothing able to tell the two rows apart. Scoped to this
       * Space, as the route's is, and only for digests strong enough to answer the question --
       * `getMediaAssetBySiteAndChecksum` decides that.
       *
       * The existing Asset is named rather than reused. Pointing this slot at an Asset the Add-on did not
       * upload is a decision about custody, not a saving.
       */
      if (settledChecksum) {
        const existing = await getMediaAssetBySiteAndChecksum(siteId, space.id, settledChecksum);
        if (existing) {
          await service.deleteObject(session.stagingStorageKey).catch(() => {});
          await abortMediaUploadSessionByToken(token);
          throw new PhisAddonAssetError(
            `What was delivered for reservation ${token} is already stored in this Space as Asset ` +
            `${existing.id}.`,
          );
        }
      }

      const linked = await withTransaction(async (client) => {
        // Reservation becomes usage in the same act that creates the row it paid for.
        const committed = await commitMediaSpaceReservationWithDb(client, {
          spaceId: space.id,
          bytes: session.sizeBytes,
        });
        if (!committed) {
          throw new PhisAddonAssetError("The Space reservation is no longer available.");
        }
        const asset = await createMediaAsset({
          siteId,
          spaceId: space.id,
          spaceKind: PhisMediaSpaceKind.Addon,
          createdByUserId: input.actorUserId,
          storageProfileId: profile.id,
          storageKey: session.stagingStorageKey,
          originalName: session.filename,
          contentType: session.contentType,
          bytes: stored.byteSize,
          // Settled above, where it is also compared against what is already in the Space.
          checksumAlgorithm: settledChecksum?.algorithm ?? null,
          checksumValue: settledChecksum?.value ?? null,
          deliveryPolicy: DELIVERY_POLICIES[declared.delivery ?? "public"],
        }, client);
        if (!asset) {
          throw new PhisAddonAssetError("The Media Asset could not be created.");
        }
        const link = await linkPhisAddonAsset(client, {
          location, siteId, ownerId: ref.ownerId, slot: ref.slot,
          mediaAssetId: asset.id,
          single: declared.cardinality === "one",
        });
        if (declared.mirrorColumn) {
          // In the same transaction as the link, because they say the same thing. The path carries the
          // cache revision, which is why it is the path and not the id that is kept.
          await writePhisAddonAssetMirror(client, location, {
            siteId,
            ownerId: ref.ownerId,
            keyColumn: ownerKeyColumn(table),
            column: declared.mirrorColumn,
            path: resolvePhiMediaDeliveryUrl({
              id: asset.id,
              deliveryRevision: asset.deliveryRevision,
            }),
          });
        }
        // While the row exists its bytes are reserved, and while it is gone they are used: never both.
        await deleteMediaUploadSessionWithDb(client, token);
        return link;
      });

      // The displaced file, removed after the row that pointed at it is gone. Media's own delete takes
      // the object and the Space's figures with it.
      if (linked.supersededMediaAssetId != null) {
        await release(space.id, linked.supersededMediaAssetId);
      }
      const row = await readPhisAddonAsset(getPool(), location, { siteId, id: linked.id });
      if (!row) {
        throw new PhisAddonAssetError(`Asset ${linked.id} vanished between writing and reading it.`);
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
        || session.actorUserId !== input.actorUserId
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
      await requireRowAuthority(table, ownerId, "read");
      const rows = await readPhisAddonAssets(getPool(), location, { siteId, ownerId, slot });
      return rows.map(view);
    },

    async remove({ table, id }) {
      const location = requireTable(table);
      /*
       * A file is addressed by a generated key, so anything that is not one names nothing.
       *
       * Answered here rather than by the database, which would raise on the type instead: an Add-on
       * passing a path segment straight through would then get an error about bigint syntax where the
       * contract promises "not there is not an error".
       */
      if (!/^\d+$/u.test(String(id))) {
        return false;
      }
      /*
       * The row is found before it is judged, because the argument names the file and the authority is
       * the row's. Absent answers `false` the way it always has: "may I" about something that is not
       * there has no other honest answer, and reporting it as a refusal would say that it exists.
       */
      const existing = await readPhisAddonAsset(getPool(), location, { siteId, id });
      if (!existing) {
        return false;
      }
      // Taking a file out of a slot changes the row, the same act `begin` is measured against.
      await requireRowAuthority(table, existing.ownerId, "update");
      // The link first, the file second: a failure there leaves a file nobody points at, which is
      // findable, rather than a row pointing at nothing, which is not.
      const mediaAssetId = await unlinkPhisAddonAsset(getPool(), location, { siteId, id });
      if (mediaAssetId == null) {
        return false;
      }
      const mirror = requireSlot(table, existing.slot).mirrorColumn;
      if (mirror) {
        // Cleared before the file goes, so no moment shows a row pointing at something already removed.
        await writePhisAddonAssetMirror(getPool(), location, {
          siteId, ownerId: existing.ownerId, keyColumn: ownerKeyColumn(table), column: mirror, path: null,
        });
      }
      const space = await ensureAddonMediaSpace(siteId, addonId);
      await release(space.id, mediaAssetId);
      return true;
    },

    async usage() {
      const space = await ensureAddonMediaSpace(siteId, addonId);
      const config = await ensureSiteMediaConfig(siteId);
      return {
        bytes: space.usedBytes,
        /*
         * The live figure, discounting reservations that have lapsed -- the same one the reserve
         * statement compares against. Reporting the raw column would show an Add-on as full on the
         * strength of transfers nobody is still making, and the next `begin` would then succeed
         * against a ceiling this said there was no room under.
         */
        reservedBytes: space.reservedBytes,
        // The effective ceiling after inheritance, because that is the one that gets applied. `null`
        // is no limit; an explicit `0` is a revocation and stays a `0`.
        quotaBytes: resolveEffectiveMediaQuotaBytes(space, config),
      };
    },
  } satisfies PhisAssetsCapabilityV1);
}
