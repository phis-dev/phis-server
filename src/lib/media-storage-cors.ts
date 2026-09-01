import "server-only";

import { getPool } from "@/lib/db";
import { createPhisMediaStorageServiceForProfile } from "@/lib/media-storage";
import type { PhisMediaStorageProviderId } from "@/lib/media-storage";
import { reconcilePhiMediaStorageCorsWith } from "@/lib/media-storage-cors-core";
import type { PhiMediaStorageCorsGroup } from "@/lib/media-storage-cors-core";

export type { PhiMediaStorageCorsGroup };

/**
 * The Server's way of reaching a Provider, handed to the shared reconciliation.
 *
 * The derivation, the grouping and the failure handling are in the core module, which the CLI uses too.
 * All that differs here is that the Server builds a Provider through its own resolver rather than
 * through the installed artifact.
 */
export async function reconcilePhiMediaStorageCors(): Promise<PhiMediaStorageCorsGroup[]> {
  return reconcilePhiMediaStorageCorsWith(getPool(), async (profile) => {
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
