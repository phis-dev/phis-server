import { NextResponse, type NextRequest } from "next/server";

import { requireSiteFromRequest } from "@/lib/site-context";
import { isPhiServerAddonEnabledForSite } from "@/db/server-addons";
import {
  PHI_SERVER_ADDON_ID_PATTERN,
  composePhiServerAddonAssetTableName,
  derivePhiServerAddonSchemaName,
} from "@/lib/addons/schema-name";
import { getMediaStorageProfile, ensureSiteMediaSpace } from "@/db/media-spaces";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import {
  abandonPhiServerAddonAsset,
  readPhiServerAddonAssetReservation,
} from "@/db/server-addon-assets.mts";
import { bookPhiServerAddonStorage } from "@/db/server-addon-storage-usage.mts";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";

/**
 * The body of one Add-on asset, streamed through Core.
 *
 * This exists for the Provider that cannot take a body from a browser. Where one can -- a `presigned-put`
 * plan -- the bytes never come here at all, and that is the point of the plan being the Provider's answer
 * rather than Core's: a large release artifact should not be paid for twice.
 *
 * **The token is the authority.** It is high-entropy, single-use, expires, and names exactly one object
 * key at exactly one size, which is precisely what a presigned PUT grants. Requiring a session cookie
 * here as well would make the same reservation safe against S3 and unsafe against local storage, which
 * is not a distinction anything downstream could act on.
 *
 * The body is a stream and is never held. Route Handlers impose no size limit of their own -- the
 * one-megabyte default lives in the Server Actions handler and applies to nothing here -- so what bounds
 * this request is the reservation's own size, checked against what actually landed.
 */

/** The same shape a declared table name has, so nothing else is ever composed into a relation name. */
const OBJECT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ scope: string; name: string; table: string; token: string }>;
};

function refuse(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { scope, name, table, token } = await context.params;
  const site = await requireSiteFromRequest(request);
  if (!site) {
    return refuse(404, "No Site here.");
  }

  const addonId = `@${scope}/${name}`;
  if (!PHI_SERVER_ADDON_ID_PATTERN.test(addonId)) {
    return refuse(404, "No such Add-on.");
  }
  if (!await isPhiServerAddonEnabledForSite(addonId, site.id)) {
    // The same answer for "no such Add-on" and "not on this Site", because the two together are what a
    // caller would otherwise use this route to tell apart.
    return refuse(404, "No such Add-on on this Site.");
  }

  /*
   * The table is checked against the catalog rather than against the build manifest.
   *
   * Reading the manifest here would mean loading the install root, which is a filesystem walk this
   * route has no other use for -- and one request for a large body should not pay for it. The database
   * knows the same thing more directly: a table that declares no slots has no asset table, so asking
   * whether the relation exists is asking whether the slot declaration does.
   */
  const schemaName = derivePhiServerAddonSchemaName(addonId);
  const location = { schemaName, table };
  const pool = getPool();
  if (!OBJECT_NAME_PATTERN.test(table)) {
    return refuse(404, "That table carries no files.");
  }
  const { rows: relation } = await pool.query<{ found: string | null }>(
    `SELECT to_regclass($1) AS found`,
    [`${schemaName}.${composePhiServerAddonAssetTableName(table)}`],
  );
  if (!relation[0]?.found) {
    return refuse(404, "That table carries no files.");
  }
  const reservation = await readPhiServerAddonAssetReservation(pool, location, token);
  /*
   * Not found and expired are one answer. A reservation that has run out is not a reservation an extra
   * branch rejects -- it is simply not one, the same as a token that was never issued, and there is no
   * path here on which a stale token writes anything.
   */
  if (!reservation || reservation.siteId !== site.id) {
    return refuse(404, "No open reservation.");
  }
  if (!request.body) {
    return refuse(400, "No body.");
  }

  const { space } = await ensureSiteMediaSpace(site.id);
  const profile = await getMediaStorageProfile(site.id, space.defaultStorageProfileId);
  if (!profile) {
    return refuse(503, "This Site has no default Storage Profile.");
  }
  const service = await createPhisMediaStorageServiceForProfile(profile, site.key);

  try {
    const stored = await service.putObjectStream({
      storageKey: reservation.storageKey,
      body: request.body,
      contentType: reservation.contentType,
      metadata: { addonId, siteKey: site.key, slot: reservation.slot },
    });
    if (stored.byteSize !== reservation.byteSize) {
      /*
       * The size was agreed before any bytes moved. A body that does not match it is not stored: both
       * the object and the reservation go, because the alternative is a store charged for one figure
       * holding another.
       *
       * The object first and the row second, which is the order that cannot lose data -- a row removed
       * before its object leaves bytes nothing names.
       */
      const removed = await service.deleteObject(reservation.storageKey).catch(() => false);
      const dropped = await abandonPhiServerAddonAsset(
        pool, location, { id: reservation.id, siteId: site.id },
      );
      /*
       * And the space goes back, which is the whole reason this branch cannot simply drop the row.
       *
       * The bytes were charged when the place was made. Removing the row and the object without also
       * releasing them leaves the booking with nothing left that describes it -- the sweep compares
       * objects against rows and there is now neither, so only a `--recount` would ever find it. A
       * client that mismatches its size on purpose could then spend an Add-on's whole store, repeatedly,
       * on nothing, with a token it was legitimately given.
       *
       * Released only where the object actually went. One the storage refused to remove is an orphan
       * the sweep will find and release then, and releasing here as well would release it twice.
       */
      if (dropped && removed) {
        await bookPhiServerAddonStorage(pool, {
          addonId, siteId: site.id, bytes: -reservation.byteSize, objects: -1,
        }).catch(() => {});
      }
      return refuse(400, `The reservation was made for ${reservation.byteSize} bytes.`);
    }
    // Still pending. What makes it a file is finalize, which is the Add-on's call and not the client's:
    // the row becomes visible when the Add-on says the upload it asked for is the upload it got.
    return NextResponse.json({ ok: true, id: reservation.id, byteSize: stored.byteSize });
  } catch (error) {
    logRuntimeEvent("error", "addon.asset.upload_failed", {
      error,
      meta: { addonId, siteKey: site.key, slot: reservation.slot },
    });
    await service.deleteObject(reservation.storageKey).catch(() => {});
    return refuse(502, "The storage did not accept the body.");
  }
}
