import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  ensureSiteMediaConfig,
  isPhiMediaContentAllowedInSpace,
  isPhiMediaObjectSizeAllowed,
  PhiMediaSpaceKind,
  updateSiteMediaConfig,
} from "./media-spaces";

/**
 * The acceptance limits, round-tripped through the columns they live in.
 *
 * The rules themselves are decided in plain code and pinned by the unit suite; what only PostgreSQL can
 * say is whether the derivation survives being written and read back -- a `varchar(32)[]` that came
 * back as a string, or a default that read as anything other than an empty list, would make the rule
 * mean the opposite of what it says.
 */
describe("Media acceptance limits against PostgreSQL", () => {
  let site: PhiTestSite;
  const space = (kind: number) => ({ kind });

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("acceptance");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("starts a Site at 25 MB with no Space declared for anything", async () => {
    const config = await ensureSiteMediaConfig(site.id);

    expect(config.maxObjectBytes).toBe(26_214_400);
    expect(config.userSpaceContentKinds).toEqual([]);
    expect(config.groupSpaceContentKinds).toEqual([]);
    // Nothing has been published, so no Module has said what a delegated Space is for.
    expect(isPhiMediaContentAllowedInSpace("image/png", space(PhiMediaSpaceKind.User), config)).toBe(false);
    // The Site Space needs no declaration; a role decides there.
    expect(isPhiMediaContentAllowedInSpace("application/x-msdownload", space(PhiMediaSpaceKind.Site), config))
      .toBe(true);
    expect(isPhiMediaObjectSizeAllowed(26_214_400, config)).toBe(true);
    expect(isPhiMediaObjectSizeAllowed(26_214_401, config)).toBe(false);
  });

  it("reads back a derived list as a list, per Space kind", async () => {
    await setPhiTestMediaConfig(site, {
      userSpaceContentKinds: ["image"],
      groupSpaceContentKinds: ["pdf", "document"],
    });
    const config = await ensureSiteMediaConfig(site.id);

    expect(config.userSpaceContentKinds).toEqual(["image"]);
    expect(config.groupSpaceContentKinds).toEqual(["pdf", "document"]);
    expect(isPhiMediaContentAllowedInSpace("image/png", space(PhiMediaSpaceKind.User), config)).toBe(true);
    expect(isPhiMediaContentAllowedInSpace("application/pdf", space(PhiMediaSpaceKind.User), config)).toBe(false);
    expect(isPhiMediaContentAllowedInSpace("application/pdf", space(PhiMediaSpaceKind.Group), config)).toBe(true);
  });

  // The point of the whole change: an administrative write must not be able to reach these.
  it("leaves the derivation alone when an operator writes capacity", async () => {
    await setPhiTestMediaConfig(site, {
      maxObjectBytes: 4_096,
      userSpaceContentKinds: ["image"],
      groupSpaceContentKinds: ["document"],
    });

    const updated = await updateSiteMediaConfig(site.id, { defaultUserQuotaBytes: 500 });

    expect(updated.defaultUserQuotaBytes).toBe(500);
    expect(updated.maxObjectBytes).toBe(4_096);
    expect(updated.userSpaceContentKinds).toEqual(["image"]);
    expect(updated.groupSpaceContentKinds).toEqual(["document"]);
  });

  // The size cap is the operator's and has no escape: the schema refuses to store a disabled one.
  it("refuses to store a non-positive object cap", async () => {
    await expect(updateSiteMediaConfig(site.id, { maxObjectBytes: 0 }))
      .rejects.toMatchObject({ code: "23514" });
  });
});
