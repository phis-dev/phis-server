import "server-only";

import { readPhiMediaStoragePolicyProfiles } from "@/db/media-storage-policies";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import type { PhisMediaStorageProviderId } from "@/lib/media-storage";
import { reconcilePhiMediaStoragePoliciesWith } from "@/lib/media-storage-policies-core";
import type { PhiMediaStoragePolicyGroup } from "@/lib/media-storage-policies-core";

export type { PhiMediaStoragePolicyGroup };

/**
 * The Server's way of reaching a Provider, handed to the shared reconciliation.
 *
 * The derivation, the grouping and the failure handling are in the core module, which the CLI uses too.
 * All that differs here is that the Server builds a Provider through its own resolver rather than
 * through the installed artifact.
 */
export async function reconcilePhiMediaStoragePolicies(): Promise<PhiMediaStoragePolicyGroup[]> {
  return reconcilePhiMediaStoragePoliciesWith(await readPhiMediaStoragePolicyProfiles(), async (profile) => {
    const service = await createPhisMediaStorageServiceForProfile(
      {
        providerId: profile.providerId as PhisMediaStorageProviderId,
        config: profile.config,
        secretReference: profile.secretReference,
        siteId: profile.siteId,
      },
      profile.siteKey,
    );
    return service;
  });
}
