import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activatePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

import { readPhisAddonCapabilityStates } from "./server-addons";

afterAll(async () => {
  await closePhiTestPool();
});

/**
 * The capability snapshot reads every installed Add-on's registry row and Site state in one statement.
 * What a fake cannot show is the join: a Site without a row must come back as no state, not drop the
 * Add-on, and another Site's row must not answer for this one.
 */
describe("readPhisAddonCapabilityStates against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("capstates");
    other = await createPhiTestSite("capstates-other");
    await enablePhiTestAddonForSite(site, "@pgtest/ready");
    await activatePhiTestAddonForSite(site, "@pgtest/requested");
    await enablePhiTestAddonForSite(other, "@pgtest/elsewhere");
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  it("answers registry and Site state for every named Add-on at once", async () => {
    const states = await readPhisAddonCapabilityStates(
      ["@pgtest/ready", "@pgtest/requested", "@pgtest/elsewhere", "@pgtest/absent"],
      site.id,
    );

    expect(states.get("@pgtest/ready")).toMatchObject({
      registry: { addonId: "@pgtest/ready", packageVersion: "0.0.0" },
      siteState: { requestedEnabled: true, configurationStatus: "ready" },
    });
    expect(states.get("@pgtest/requested")?.siteState?.requestedEnabled).toBe(false);
    // Installed, but this Site has no row: the Add-on is known, its state here is not.
    expect(states.get("@pgtest/elsewhere")).toMatchObject({ registry: { addonId: "@pgtest/elsewhere" }, siteState: null });
    expect(states.has("@pgtest/absent")).toBe(false);
  });

  it("asks nothing for no Add-ons", async () => {
    expect((await readPhisAddonCapabilityStates([], site.id)).size).toBe(0);
  });
});
