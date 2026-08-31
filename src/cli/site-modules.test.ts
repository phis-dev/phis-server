import { describe, expect, it } from "vitest";

import { buildSiteModuleProjection } from "./modules.mts";

/**
 * What `phis module` writes into a Site.
 *
 * The generated file is the whole of the installation, so its shape is worth pinning: a list of imports
 * and one call. Nothing here loads a Module -- the placement into Areas happens where the projection is
 * imported, from each Module's own `eligibleAreas`.
 */
describe("the generated Site Module projection", () => {
  it("composes to nothing when no Module is installed", () => {
    const { server, client } = buildSiteModuleProjection([]);
    expect(server).toContain("collectPhiSiteModuleServerAreaContributions([\n]);");
    expect(client).toContain("definitions: []");
    expect(client).toContain("clients: []");
    expect(client).toContain("authoring: []");
    // A Site without Modules must still get a Client file, or its Area hosts have nothing to be handed.
    expect(client.startsWith('"use client";')).toBe(true);
  });

  it("imports each boundary under the fixed export names", () => {
    const { server, client } = buildSiteModuleProjection([
      { packageName: "@acme/status", origin: "local" },
    ]);
    expect(server).toContain(
      'import { phiModuleServerContributions as m_acme_status } from "@acme/status/server";',
    );
    expect(client).toContain(
      'import { phiModuleDefinitions as m_acme_status_definitions } from "@acme/status";',
    );
    expect(client).toContain(
      'import { phiModuleClientContributions as m_acme_status_client } from "@acme/status/client";',
    );
    expect(client).toContain(
      'import { phiModuleAuthoringContributions as m_acme_status_authoring } from "@acme/status/authoring-client";',
    );
  });

  it("orders Modules by package name rather than by when they were added", () => {
    const { server } = buildSiteModuleProjection([
      { packageName: "@zeta/late", origin: "local" },
      { packageName: "@alpha/early", origin: "local" },
    ]);
    expect(server.indexOf("m_alpha_early")).toBeLessThan(server.indexOf("m_zeta_late"));
  });

  it("names imports after their package, so removing one does not renumber the rest", () => {
    const two = buildSiteModuleProjection([
      { packageName: "@acme/a", origin: "local" },
      { packageName: "@acme/b", origin: "local" },
    ]);
    const one = buildSiteModuleProjection([{ packageName: "@acme/b", origin: "local" }]);
    // The surviving Module keeps the exact lines it had; a numbered alias would have shifted them.
    for (const line of one.server.split("\n").filter((entry) => entry.includes("m_acme_b"))) {
      expect(two.server).toContain(line);
    }
  });
});
