/*
 * The bits of `media_assets.presentation_flags`, from the contract both sides validate against rather
 * than from a copy here -- the copy that used to stand here had drifted. Display only: access is
 * `delivery_policy` and `lifecycle_status`.
 */
export { PhiMediaAssetFlags } from "@phis/contracts/media";
export type { PhiMediaAssetFlag } from "@phis/contracts/media";

/**
 * Availability of the non-Site Media Space kinds, per `GROUPS_AND_STORAGE.md` section 7.
 *
 * Availability is a capability and is deliberately separate from quota: `0` means the Space kind does
 * not exist for this Site, which is rejected distinguishably from an exhausted quota. The Site Space is
 * never governed by these flags.
 */
export const PhiSiteMediaFlags = {
  UserSpacesEnabled: 1 << 0,
  GroupSpacesEnabled: 1 << 1,
} as const;

/*
 * Kind names, Folder flags and the image variant vocabulary are the contract, not this file's own:
 * they are carried through from `@phis/contracts/media`, where phis reads the same values. What stays
 * below is phis's own: the public URL shape a Storage Provider is addressed through.
 */
export {
  PhiImageAssetVariantKey,
  PhiImageAssetVariantKeyName,
  PhiMediaFolderFlags,
  PhiMediaKind,
  normalizePhiImageAssetVariantKey,
  normalizePhiMediaKind,
  resolvePhiImageAssetVariantKeyName,
  resolvePhiImageAssetVariantSpec,
  resolvePhiMediaKindFromContentType,
} from "@phis/contracts/media";
export type { PhiImageAssetVariantSpec } from "@phis/contracts/media";

export function buildPhiImageAssetVariantPublicUrl(
  publicUrl: string,
  variantKey: number | null | undefined,
  variantVersion: number | null | undefined = 0,
) {
  const normalizedUrl = (publicUrl ?? "").trim();
  if (!normalizedUrl || typeof variantKey !== "number" || !Number.isInteger(variantKey)) {
    return null;
  }

  const normalizedVersion =
    typeof variantVersion === "number" && Number.isInteger(variantVersion) && variantVersion >= 0
      ? variantVersion
      : 0;

  if (/^https?:\/\//i.test(normalizedUrl)) {
    const url = new URL(normalizedUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/variant/${variantKey}/v/${normalizedVersion}`;
    return url.toString();
  }

  return `${normalizedUrl.replace(/\/+$/, "")}/variant/${variantKey}/v/${normalizedVersion}`;
}
