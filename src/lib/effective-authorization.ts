import "server-only";

import { buildPhisCapabilitySnapshot } from "@/lib/addons/capability-snapshot";
import {
  PHI_CORE_ROLE_PROVIDER_ID,
  type PhiViewerRoleClaim,
} from "@/lib/authorization";

export async function resolveEffectivePhiViewerRoleClaims(
  siteId: number,
  persistedClaims: readonly PhiViewerRoleClaim[],
) {
  const snapshot = await buildPhisCapabilitySnapshot(siteId);
  const availableProviders = new Set(
    snapshot.providers
      .filter((provider) => provider.state === "available")
      .map((provider) => provider.providerId),
  );
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
