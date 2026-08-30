export function hasPhiFlag(flags: number | null | undefined, flag: number) {
  return ((flags ?? 0) & flag) === flag;
}
