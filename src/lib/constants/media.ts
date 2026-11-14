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

/**
 * The bits of `media_storage_profiles.flags`.
 *
 * `Disabled` stops new bytes, not old ones: what a disabled Profile holds keeps being delivered, and every
 * way of writing a new object into it -- a Media upload, an Add-on's storage `put`, an Add-on's Asset
 * reservation -- is refused. A Space can therefore be moved off a Profile without breaking a page that
 * shows what is already there. Derived bytes of an existing Asset (image variants, font subsets) still
 * follow their Asset, because they are not new content.
 */
export const PhiMediaStorageProfileFlags = {
  Disabled: 1 << 0,
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
