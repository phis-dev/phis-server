import { describe, expect, it } from "vitest";

import { PHI_SERVER_SERVICE_KINDS } from "./core-services";
import { getPhiServerAddonInstalledManifest } from "./installed";
import { resolvePhiServerServiceProvider } from "./services";

/**
 * The runtime loader, exercised against whatever is actually installed here.
 *
 * Every other test in this directory works on a fixture, which cannot show the one thing that matters
 * about the loader: that a real artifact in the install root is found, verified against its digest,
 * imported through its derived address, and searched for the export its descriptor names. This one
 * needs an installation to say anything, so it skips where there is none.
 */
const S3_ADDON_ID = "@phis/storage-s3";
const installed = (() => {
  try {
    return getPhiServerAddonInstalledManifest();
  } catch {
    return {};
  }
})();
const s3Installed = Boolean(installed[S3_ADDON_ID]?.enabled);

describe.skipIf(!s3Installed)("the installed S3 Add-on", () => {
  it("is read from the install root rather than from a build", () => {
    expect(Object.keys(installed)).toContain(S3_ADDON_ID);
  });

  it("resolves its Media Storage factory through the runtime loader", async () => {
    const resolved = await resolvePhiServerServiceProvider(
      PHI_SERVER_SERVICE_KINDS.mediaStorage,
      "@phis/storage-s3/s3",
    );
    expect(resolved.addonId).toBe(S3_ADDON_ID);
    expect(typeof resolved.factory).toBe("function");
    expect(resolved.descriptor.factoryExport).toBe("createPhiS3MediaStorageAdapter");
  });
});
