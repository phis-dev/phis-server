import "server-only";

import { PHIS_MEDIA_GET_MAX_IDS, type PhisMediaAssetV1, type PhisMediaCapabilityV1 } from "./contract.ts";
import { listAddonReachMediaAssetsByIds, type MediaAssetRecord } from "@/db/media";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@/db/media-spaces";
import { resolvePhiMediaDeliveryUrl } from "@/lib/media-response";

/**
 * `media:v1`: Assets of the Site's Media library by id, read-only (SERVER_ADDONS.md, media:v1).
 *
 * Bound to the Site and to the calling Add-on. What is in reach is what `products:v1` takes as a
 * picture -- the Site's Space and this Add-on's own Add-on Space -- and the reader asks for exactly that,
 * so an Asset out of reach is absent rather than refused. `servable` is the rest of that check: ready and
 * delivered publicly. The path is Core's one Media address, the builder `products:v1` uses for `imagePath`.
 *
 * An unverified hook is answered the servable Assets only: what a visitor is not served is not public,
 * and neither are its facts.
 */

export class PhisAddonMediaError extends Error {}

function present(asset: MediaAssetRecord): PhisMediaAssetV1 {
  const servable = asset.lifecycleStatus === PhiMediaLifecycleStatus.Ready
    && asset.deliveryPolicy === PhiMediaDeliveryPolicy.Public;
  return {
    id: asset.id,
    contentType: asset.contentType,
    byteSize: asset.bytes,
    width: asset.width,
    height: asset.height,
    alt: asset.altText,
    servable,
    path: servable ? resolvePhiMediaDeliveryUrl(asset) : null,
  };
}

export function buildPhisAddonMediaCapability(input: {
  addonId: string;
  siteId: number;
  /** True when nobody authenticated and no signature stood in for them -- an unverified hook. */
  unauthenticated?: boolean;
}): PhisMediaCapabilityV1 {
  const { addonId, siteId } = input;

  return Object.freeze({
    async get(request: { ids: readonly number[] }): Promise<PhisMediaAssetV1[]> {
      const ids = request?.ids;
      if (
        !Array.isArray(ids)
        || ids.length > PHIS_MEDIA_GET_MAX_IDS
        || !ids.every((id) => Number.isSafeInteger(id) && id > 0)
      ) {
        throw new PhisAddonMediaError(`ids is a list of at most ${PHIS_MEDIA_GET_MAX_IDS} positive integer Asset ids.`);
      }
      const order = [...new Set(ids)];
      if (order.length === 0) return [];
      const found = new Map(
        (await listAddonReachMediaAssetsByIds(siteId, addonId, order)).map((asset) => [asset.id, present(asset)]),
      );
      return order.flatMap((id) => {
        const asset = found.get(id);
        return asset && (asset.servable || input.unauthenticated !== true) ? [asset] : [];
      });
    },
  } satisfies PhisMediaCapabilityV1);
}
