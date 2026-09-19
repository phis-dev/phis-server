import { PhiUserAccountFlag } from "@/lib/constants/user-account-flags";

export const USER_ACCOUNT_FLAG_DISABLED = PhiUserAccountFlag.Disabled;
export { PhiUserAccountFlag };

export function hasUserAccountFlag(flags: number | null | undefined, flag: number) {
  return ((flags ?? 0) & flag) === flag;
}

export function isUserAccountEnabled(flags: number | null | undefined) {
  return !hasUserAccountFlag(flags, USER_ACCOUNT_FLAG_DISABLED);
}

export function resolveUserAccountFlagTags(flags: number | null | undefined) {
  const normalized = Number.isInteger(flags) ? (flags as number) : 0;
  const tags: string[] = [];

  if (hasUserAccountFlag(normalized, USER_ACCOUNT_FLAG_DISABLED)) {
    tags.push("disabled");
  }
  return tags;
}

/** The three names an account's Theme choice travels under; the bit positions never leave this service. */
export type PhiUserThemeModeName = "light" | "dark" | "system";

/**
 * Which half the account asked for, or `system` where it asked for neither.
 *
 * Both bits set is read as `system` for the same reason an unknown value would be: a contradiction is
 * not a choice, and answering one of the two halves would be inventing a decision nobody made.
 */
export function resolveUserThemeModeName(flags: number | null | undefined): PhiUserThemeModeName {
  const light = hasUserAccountFlag(flags, PhiUserAccountFlag.ThemeLight);
  const dark = hasUserAccountFlag(flags, PhiUserAccountFlag.ThemeDark);
  if (light === dark) {
    return "system";
  }
  return light ? "light" : "dark";
}

/**
 * The flag update a name asks for, or `null` for a name that is not one of the three.
 *
 * Every answer clears both bits and then sets at most one, so `system` needs no special case: it is
 * the update that sets nothing. A name nobody offers is refused rather than stored as `system`, which
 * would look like the person had asked to follow their browser.
 */
export function resolveUserThemeModeFlagUpdate(
  value: unknown,
): { setFlags: number; clearFlags: number } | null {
  const clearFlags = PhiUserAccountFlag.ThemeLight | PhiUserAccountFlag.ThemeDark;
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "light":
      return { setFlags: PhiUserAccountFlag.ThemeLight, clearFlags };
    case "dark":
      return { setFlags: PhiUserAccountFlag.ThemeDark, clearFlags };
    case "system":
      return { setFlags: 0, clearFlags };
    default:
      return null;
  }
}
