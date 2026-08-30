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
