import "server-only";

import {
  PHI_CORE_ROLE_PROVIDER_ID,
  type PhiViewerRoleClaim,
} from "@/lib/authorization";

export function resolveEffectivePhiViewerRoleClaims(
  persistedClaims: readonly PhiViewerRoleClaim[],
  /** The providers available on the Site, as `readAvailablePhisProviderIds` answers it. */
  availableProviders: ReadonlySet<string>,
) {
  const effective = persistedClaims.filter((claim) =>
    claim.providerId === PHI_CORE_ROLE_PROVIDER_ID ||
    availableProviders.has(claim.providerId),
  );
  if (!effective.some((claim) => claim.providerId === PHI_CORE_ROLE_PROVIDER_ID)) {
    effective.unshift({
      providerId: PHI_CORE_ROLE_PROVIDER_ID,
      flags: 0,
    });
  }
  return effective;
}
