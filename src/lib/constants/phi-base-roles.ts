export const PhiBaseRole = {
  Admin: 1 << 0,
  Builder: 1 << 1,
  Publisher: 1 << 2,
  Author: 1 << 3,
  Developer: 1 << 4,
  Supporter: 1 << 5,
  Accountant: 1 << 6,
} as const;

/**
 * Stable role keys as accepted by admin section payloads (mirrors the shared UI's
 * PHI_BASE_ROLE_OPTIONS values). The bitmask derivation is server-authoritative.
 */
export const PHI_BASE_ROLE_FLAGS_BY_KEY = {
  admin: PhiBaseRole.Admin,
  builder: PhiBaseRole.Builder,
  publisher: PhiBaseRole.Publisher,
  author: PhiBaseRole.Author,
  developer: PhiBaseRole.Developer,
  supporter: PhiBaseRole.Supporter,
  accountant: PhiBaseRole.Accountant,
} as const;

export function buildPhiBaseRoleFlags(roleKeys: readonly string[]): number | null {
  let flags = 0;
  for (const roleKey of roleKeys) {
    const flag = PHI_BASE_ROLE_FLAGS_BY_KEY[roleKey as keyof typeof PHI_BASE_ROLE_FLAGS_BY_KEY];
    if (flag === undefined) {
      return null;
    }
    flags |= flag;
  }
  return flags;
}

export function readPhiBaseRoleKeys(flags: number): string[] {
  return Object.entries(PHI_BASE_ROLE_FLAGS_BY_KEY)
    .filter(([, flag]) => (flags & flag) !== 0)
    .map(([roleKey]) => roleKey);
}
