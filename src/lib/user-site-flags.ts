export const USER_SITE_FLAG_DISABLED = 1 << 0;
export const USER_SITE_FLAG_NEWSLETTER_OPT_IN = 1 << 1;

export function hasUserSiteFlag(flags: number | null | undefined, flag: number) {
  return ((flags ?? 0) & flag) === flag;
}

export function isUserSiteEnabled(flags: number | null | undefined) {
  return !hasUserSiteFlag(flags, USER_SITE_FLAG_DISABLED);
}
