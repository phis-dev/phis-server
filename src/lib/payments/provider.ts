import type { PhisPaymentProviderContextV1, PhisPaymentProviderV1 } from "@phis/contracts/payments";
import type { PhisAddonServiceFactory } from "@phis/contracts/addon";
import { parsePhiSecretReference } from "../secrets/reference.ts";
import { PhisPaymentError } from "./validation.ts";
import type { PhisPaymentProfile } from "./types.ts";

/** The nullary reader can reach exactly the validated references of one Site/profile/provider. */
export function buildPhisPaymentProviderContext(profile: PhisPaymentProfile, siteKey: string, readSecret: (reference: string) => Promise<string | null>): PhisPaymentProviderContextV1 {
  const references = Object.entries(profile.credentialReferences);
  for (const [, reference] of references) {
    const identity = parsePhiSecretReference(reference);
    if (!identity || identity.siteKey !== siteKey || identity.owner.kind !== "addon" || identity.owner.addonId !== profile.providerAddonId) throw new PhisPaymentError("profile_unavailable");
  }
  return Object.freeze({
    providerKey: profile.providerKey,
    async readCredentials() {
      const credentials: Record<string, string> = {};
      for (const [slot, reference] of references) {
        const value = await readSecret(reference);
        if (value === null) return null;
        credentials[slot] = value;
      }
      return Object.freeze(credentials);
    },
  });
}

export async function createPhisPaymentProvider(factory: PhisAddonServiceFactory, profile: PhisPaymentProfile, siteKey: string, readSecret: (reference: string) => Promise<string | null>): Promise<PhisPaymentProviderV1> {
  const result = await factory(Object.freeze({ profileKey: profile.key, mode: profile.mode, merchantIdentity: profile.merchantIdentity }),
    buildPhisPaymentProviderContext(profile, siteKey, readSecret));
  if (!result || typeof result !== "object" || !["probe", "execute", "observe", "recover", "verifyNotification"].every(key => typeof (result as Record<string, unknown>)[key] === "function")) throw new PhisPaymentError("profile_unavailable");
  return result as PhisPaymentProviderV1;
}
