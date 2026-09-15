import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { createPhiPresetCmsInstanceId } from "@/lib/cms/instance-id";
import { createPhiPageReference } from "@/lib/internal-references";
import { saveSiteNavigationDraftRevision } from "./site-navigation";

const docsContainer = createPhiPresetCmsInstanceId({
  domain: "navigation",
  ownerModuleId: "@phis/ui/modules/docs",
  presetKey: "docs-nav",
  nodeKey: "docs",
});
let start: string;
let faq: string;

function overlay(navKey: string, folder?: unknown) {
  return {
    navKey,
    itemOverrides: folder === undefined ? [] : [{ id: docsContainer, folder }],
    customItems: [],
    tombstones: [],
  };
}

async function save(site: PhiTestSite, key: string, folder?: unknown, baseRevisionId?: number) {
  return saveSiteNavigationDraftRevision(site.id, {
    key,
    overlay: overlay(key, folder),
    nextNodeSequence: 1,
    ...(baseRevisionId ? { baseRevisionId } : {}),
  });
}

async function workingFolder(site: PhiTestSite, key: string) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ tree_json: { itemOverrides?: { folder?: unknown }[] } }>(
    `SELECT r.tree_json
     FROM phis.site_nav_scopes s
     JOIN phis.site_nav_revisions r ON r.id = s.working_draft_revision_id
     WHERE s.site_id = $1 AND s.key = $2`,
    [site.id, key],
  );
  return rows[0]?.tree_json.itemOverrides?.[0]?.folder ?? null;
}

/**
 * One address, one target: a save carries the folder targets it changed into every other Navigation of
 * its Area holding the same folder, in its own transaction, as a new Draft there.
 */
describe("Carrying a folder target across Navigations against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("folder-carry");
    // Page targets are indexed as references, so they must name Pages that exist.
    start = createPhiPageReference({ kind: "site", pageScopeId: await createPhiTestPageScope(site, "/pgtest-docs/start") });
    faq = createPhiPageReference({ kind: "site", pageScopeId: await createPhiTestPageScope(site, "/pgtest-docs/faq") });
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("carries a changed target to the same folder in the Area, and nowhere else", async () => {
    await save(site, "public:header", { address: "/docs", target: null });
    await save(site, "public:quicklinks", { address: "/docs", target: null });
    await save(site, "public:footer");
    await save(site, "admin:sidebar", { address: "/docs", target: null });

    const result = await save(site, "public:header", { address: "/docs", target: { kind: "page", reference: start } });

    expect(result.carriedOver.map((entry) => entry.key)).toEqual(["public:quicklinks"]);
    expect(result.carriedOver[0]?.folders).toEqual([{ address: "/docs", target: { kind: "page", reference: start } }]);
    expect(await workingFolder(site, "public:quicklinks")).toEqual({ address: "/docs", target: { kind: "page", reference: start } });
    expect(await workingFolder(site, "public:footer")).toBeNull();
    expect(await workingFolder(site, "admin:sidebar")).toEqual({ address: "/docs", target: null });
  });

  it("carries nothing when a save leaves its targets as they were", async () => {
    const result = await save(site, "public:header", { address: "/docs", target: { kind: "page", reference: start } });

    expect(result.carriedOver).toEqual([]);
  });

  it("does not carry back a target an editor loaded before another Navigation changed it", async () => {
    // The quicklinks editor loaded its Draft while the folder still led to `start`.
    const loaded = await save(site, "public:quicklinks", { address: "/docs", target: { kind: "page", reference: start } });
    await save(site, "public:header", { address: "/docs", target: { kind: "page", reference: faq } });
    expect(await workingFolder(site, "public:quicklinks")).toEqual({ address: "/docs", target: { kind: "page", reference: faq } });

    // It saves an unrelated change from that older state.
    const stale = await save(site, "public:quicklinks", { address: "/docs", target: { kind: "page", reference: start } }, loaded.revisionId);

    expect(stale.carriedOver).toEqual([]);
    expect(await workingFolder(site, "public:header")).toEqual({ address: "/docs", target: { kind: "page", reference: faq } });
  });

  it("clears a target across Navigations when 404 is chosen", async () => {
    const result = await save(site, "public:header", { address: "/docs", target: null });

    expect(result.carriedOver.map((entry) => entry.key)).toEqual(["public:quicklinks"]);
    expect(await workingFolder(site, "public:quicklinks")).toEqual({ address: "/docs", target: null });
  });
});
