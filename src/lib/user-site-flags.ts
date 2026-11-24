export const USER_SITE_FLAG_DISABLED = 1 << 0;
/*
 * `1 << 1` is free. It was the newsletter opt-in until 2026-11-24: Core keeps no consent for circulars,
 * and the Add-on that sends one holds it (design/ADDONS_PLANNED.md section 6).
 */

export function hasUserSiteFlag(flags: number | null | undefined, flag: number) {
  return ((flags ?? 0) & flag) === flag;
}

export function isUserSiteEnabled(flags: number | null | undefined) {
  return !hasUserSiteFlag(flags, USER_SITE_FLAG_DISABLED);
}
