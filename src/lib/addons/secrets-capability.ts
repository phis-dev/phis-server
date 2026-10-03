import "server-only";

import type { PhisSecretsCapabilityV1 } from "./contract.ts";
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
export function buildPhisAddonSecretsCapability(input: {
  addonId: string;
  siteKey: string;
}): PhisSecretsCapabilityV1 {
  const owner = { kind: "addon", addonId: input.addonId } as const;
  return Object.freeze({
    async read(name, scope = "site") {
      /*
       * Two secrets an operator can set, and the caller names which one it means. `"site"` is bound to
       * this Site by construction: there is no argument through which another Site could be named.
       * `"addon"` is the one set without `--site`, shared by every Site the Add-on runs on. Neither
       * stands in for the other -- a missing Site secret is `null`, so an operator who forgot one Site
       * is told so rather than finding the shared credential used in its place.
       */
      if (scope !== "site" && scope !== "addon") {
        throw new Error(`Secret scope must be "site" or "addon", not ${JSON.stringify(scope)}.`);
      }
      const reference = buildPhiSecretReference({
        owner,
        siteKey: scope === "site" ? input.siteKey : null,
        name,
      });
      // Null for "not configured" and a throw for "exists but unreadable" -- the resolver's own
      // distinction, kept rather than flattened, because the two need different operator action.
      return resolvePhiSecret(owner, reference);
    },
  } satisfies PhisSecretsCapabilityV1);
}
