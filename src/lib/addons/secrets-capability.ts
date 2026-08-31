import "server-only";

import type { PhiServerSecretsCapabilityV1 } from "./contract.ts";
import { buildPhiSecretReference } from "@/lib/secrets/reference";
import { resolvePhiSecret } from "@/lib/secrets/resolver";

/**
 * Reading the secrets an operator set for one Add-on.
 *
 * The owner is bound here, and the resolver checks it again. That is not redundancy for its own sake:
 * the binding makes another Add-on's secret unnameable, and the resolver's check catches a Core caller
 * that constructed the wrong owner. The two guard different mistakes.
 *
 * There is no writer, and there will not be one. An operator sets a secret with `phis secret set`; a
 * package able to write its own would be a package able to plant one, and the store would stop being
 * the operator's record of what they configured.
 */
export function buildPhiServerAddonSecretsCapability(input: {
  addonId: string;
  siteKey: string;
}): PhiServerSecretsCapabilityV1 {
  const owner = { kind: "addon", addonId: input.addonId } as const;
  return Object.freeze({
    async read(name) {
      // Site-scoped by construction: an Add-on on one Site cannot read what an operator set for it on
      // another, because there is no argument through which it could name a different Site.
      const reference = buildPhiSecretReference({
        owner,
        siteKey: input.siteKey,
        name,
      });
      // Null for "not configured" and a throw for "exists but unreadable" -- the resolver's own
      // distinction, kept rather than flattened, because the two need different operator action.
      return resolvePhiSecret(owner, reference);
    },
  } satisfies PhiServerSecretsCapabilityV1);
}
