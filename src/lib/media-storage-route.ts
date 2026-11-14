import "server-only";

import { NextResponse } from "next/server";

import { PhiServiceProviderUnavailableError } from "@/lib/addons/services";
import { logRuntimeEvent } from "@/lib/log";
import { createPhisMediaStorageServiceForProfile, type PhisMediaStorageService } from "@/lib/media-storage";

type PhisMediaStorageProfileInput = Parameters<typeof createPhisMediaStorageServiceForProfile>[0];

/**
 * The Storage Service for a route, or the answer a route gives when this Instance cannot open it.
 *
 * Every Instance checks the Provider for itself, because the registry says what the installation wants
 * and not what this process holds: an Instance that has not received the Provider's Add-on, or holds it
 * disabled, cannot serve the Profile however the other Instances are doing. That used to surface as a
 * 500 out of the resolver. It is a named refusal now -- `storage_provider_unavailable`, 503, since another
 * Instance or a later deploy can serve the same request -- and one log line that says which Provider and
 * why, which is what the operator needs and the visitor must not see.
 *
 * Activating a Profile (`phis storage use`) refuses while a serving Instance lacks the Provider, so this
 * is the guard for what changes afterwards: an Instance added or rolled back later.
 */
export async function openPhisMediaStorageForRoute(
  profile: PhisMediaStorageProfileInput,
  siteKey?: string | null,
): Promise<{ storage: PhisMediaStorageService; refusal: null } | { storage: null; refusal: NextResponse }> {
  try {
    return { storage: await createPhisMediaStorageServiceForProfile(profile, siteKey), refusal: null };
  } catch (error) {
    if (!(error instanceof PhiServiceProviderUnavailableError)) {
      throw error;
    }
    logRuntimeEvent("error", "media.storage.provider_unavailable", {
      message: `Storage Provider ${profile.providerId} cannot be opened on this Instance: ${error.reason}.`,
      ...(siteKey ? { siteKey } : {}),
      meta: { siteId: profile.siteId, providerId: profile.providerId, reason: error.reason },
    });
    return {
      storage: null,
      refusal: NextResponse.json(
        { error: "storage_provider_unavailable", message: "Storage is not available on this server." },
        { status: 503 },
      ),
    };
  }
}
