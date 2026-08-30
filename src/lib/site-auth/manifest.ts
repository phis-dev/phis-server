import "server-only";

import { getSiteAuthPolicy, listSiteAuthMethods } from "@/db/site-auth";
import {
  PHI_CORE_AUTH_METHODS,
  isPhiCoreAuthMethodStage,
  type PhiPublicAuthManifest,
} from "@/lib/site-auth/contracts";
import { hasSiteAuthSecrets } from "@/lib/site-auth/secret-store";

const IMPLEMENTED_METHODS = new Set(["password", "google", "apple", "github", "microsoft"]);

export async function buildPublicAuthManifest(siteId: number): Promise<PhiPublicAuthManifest> {
  const [policy, methods] = await Promise.all([
    getSiteAuthPolicy(siteId),
    listSiteAuthMethods(siteId),
  ]);
  // Whether a provider is configured, asked once for all of them. This is a public endpoint, and the
  // answer is a row count rather than a plaintext -- decrypting per provider to learn it would be work
  // nobody asked for.
  const configuredSecrets = await hasSiteAuthSecrets(
    methods.map((method) => method.provider?.secretReference ?? null),
  );
  return {
    version: 1,
    registrationMode: policy?.registrationMode ?? "disabled",
    methods: methods
      .filter((method) => {
        if (
          !method.enabled ||
          !IMPLEMENTED_METHODS.has(method.methodKey) ||
          !isPhiCoreAuthMethodStage(method.methodKey, method.stage)
        ) {
          return false;
        }
        if (!method.providerInstallationKey) {
          return method.methodKey === "password";
        }
        return Boolean(
          method.provider?.enabled &&
          method.provider.secretReference &&
          configuredSecrets.has(method.provider.secretReference),
        );
      })
      .map((method) => {
        const fallback = PHI_CORE_AUTH_METHODS[method.methodKey as keyof typeof PHI_CORE_AUTH_METHODS];
        return {
          methodKey: method.methodKey,
          stage: method.stage,
          label: typeof method.presentation.label === "string"
            ? method.presentation.label
            : fallback?.label ?? method.methodKey,
          ...(typeof method.presentation.icon === "string"
            ? { icon: method.presentation.icon }
            : {}),
          ...(method.providerInstallationKey
            ? { installationKey: method.providerInstallationKey }
            : {}),
          startPath: method.methodKey === "password"
            ? "/api/auth/password/login"
            : `/api/auth/providers/${encodeURIComponent(method.methodKey)}/start?installation=${encodeURIComponent(method.providerInstallationKey ?? "")}`,
        };
      }),
  };
}
