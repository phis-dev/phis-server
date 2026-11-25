import "server-only";

import type {
  PhisCdnImportRequestV1,
  PhisCdnImportResultV1,
  PhisCdnLinkRequestV1,
  PhisCdnLinkResultV1,
  PhisCdnPublishCapabilityV1,
} from "./contract.ts";
import { getPhisConfigSync } from "@/lib/config";
import { readPhiCdnImportHosts } from "@/lib/config-core";
import { importPhisCdnFile, linkPhisCdnFile, type PhisCdnAddonCaller } from "@/lib/cdn-publish.mts";
import { openPhisCdnTarget, readPhisCdnSiteLimits } from "@/lib/cdn-server";
import { getPool } from "@/lib/db";
import { logRuntimeEvent } from "@/lib/log";

export class PhisAddonCdnPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhisAddonCdnPublishError";
  }
}

/**
 * `cdn-publish:v1`: putting a file into the Site's CDN catalogue from an address Core fetches itself, or
 * recording it as a link.
 *
 * Bound to the Site and to the calling Add-on, which becomes the file's origin -- and which can therefore
 * only publish under a name that is new or holds nothing but its own. Every hop of an import is on the
 * stage's `cdn.importHosts`, read at each call so an operator's change applies without a restart. A job, a
 * route or a command gets it; an unverified hook gets a capability whose every call throws, as
 * `mediaRelease` does, because nobody stands behind such a request.
 */
export function buildPhisAddonCdnPublishCapability(input: {
  addonId: string;
  siteId: number;
  siteKey: string;
  unauthenticated?: boolean;
}): PhisCdnPublishCapabilityV1 {
  const { addonId, siteId, siteKey } = input;

  const refuseUnverified = (call: string) => {
    if (input.unauthenticated) {
      throw new PhisAddonCdnPublishError(
        `${addonId} called cdnPublish.${call} from an unverified hook; publishing under the Site's name needs a job, a route or a command.`,
      );
    }
  };

  async function caller(): Promise<PhisCdnAddonCaller> {
    const { maxObjectBytes } = await readPhisCdnSiteLimits(siteId);
    return {
      addonId,
      importHosts: readPhiCdnImportHosts(getPhisConfigSync()),
      maxObjectBytes,
      onRefusal: ({ code, message, key }) => {
        logRuntimeEvent("warn", "cdn.import.refused", {
          message,
          siteKey,
          pluginKey: addonId,
          meta: { addonId, refusal: code, key },
        });
      },
    };
  }

  return Object.freeze({
    async import(request: PhisCdnImportRequestV1, options?: { signal?: AbortSignal }): Promise<PhisCdnImportResultV1> {
      refuseUnverified("import");
      const target = await openPhisCdnTarget(siteId, siteKey);
      const result = await importPhisCdnFile(getPool(), target, request, await caller(), options?.signal ? { signal: options.signal } : {});
      if (result.ok && result.flags === 0) {
        logRuntimeEvent("info", "cdn.published", {
          message: `${addonId} imported ${result.file.key}.`,
          siteKey,
          pluginKey: addonId,
          meta: { addonId, key: result.file.key, sizeBytes: result.file.sizeBytes, sourceUrl: request.url },
        });
      }
      return result;
    },

    async link(request: PhisCdnLinkRequestV1): Promise<PhisCdnLinkResultV1> {
      refuseUnverified("link");
      const target = await openPhisCdnTarget(siteId, siteKey);
      const result = await linkPhisCdnFile(getPool(), target, request, await caller());
      if (result.ok && result.flags === 0) {
        logRuntimeEvent("info", "cdn.published", {
          message: `${addonId} linked ${result.file.key}.`,
          siteKey,
          pluginKey: addonId,
          meta: { addonId, key: result.file.key, storage: "link", sourceUrl: request.url },
        });
      }
      return result;
    },
  } satisfies PhisCdnPublishCapabilityV1);
}
