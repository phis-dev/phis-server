import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * The search index against the development database: a set replaced whole, the same fingerprint
 * written once, and a query answered by prefix with the title outranking the body.
 */

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { replaceSiteSearchDocuments, searchSiteDocuments, listSiteSearchIndexStates } from "./site-search";

describe("the Site search index", () => {
  let site: PhiTestSite;
  const key = (areaMask = 1, locale = "en") => ({ siteId: site.id, areaMask, locale });

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("search");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("writes a set, and the same fingerprint only once", async () => {
    const first = await replaceSiteSearchDocuments(key(), "print-1", [
      { path: "/docs/install", title: "Install phis", description: "From the package to the first Site.", text: "The server needs PostgreSQL and Node." },
      { path: "/home", title: "Home", description: "", text: "Ship what makes your product unique. Installation is one command." },
    ]);
    expect(first.status).toBe("written");
    if (first.status !== "written") return;
    expect(first.state).toMatchObject({ areaMask: 1, locale: "en", fingerprint: "print-1", documentCount: 2 });

    const again = await replaceSiteSearchDocuments(key(), "print-1", []);
    expect(again.status).toBe("unchanged");

    const states = await listSiteSearchIndexStates(site.id);
    expect(states).toHaveLength(1);
    expect(states[0].documentCount).toBe(2);
  });

  it("finds by prefix, ranks the title first and marks the words in the snippet", async () => {
    const result = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "en", query: "instal", limit: 10 });

    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => hit.path)).toEqual(["/docs/install", "/home"]);
    const home = result.hits[1];
    expect(home.snippet.some((segment) => segment.match && segment.text === "Installation")).toBe(true);
    // The first hit matched in its title; its body says nothing of the word, so there is nothing to quote.
    expect(result.hits[0].snippet).toEqual([]);
  });

  it("requires every word and searches only the Areas asked for", async () => {
    await replaceSiteSearchDocuments(key(2), "app-1", [
      { path: "/account", title: "Your account", description: "", text: "Install nothing here." },
    ]);

    const both = await searchSiteDocuments({ siteId: site.id, areaMask: 3, locale: "en", query: "install", limit: 10 });
    expect(both.hits.map((hit) => hit.path).sort()).toEqual(["/account", "/docs/install", "/home"]);

    const publicOnly = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "en", query: "install", limit: 10 });
    expect(publicOnly.hits.map((hit) => hit.path)).not.toContain("/account");

    const narrow = await searchSiteDocuments({ siteId: site.id, areaMask: 3, locale: "en", query: "install postgres", limit: 10 });
    expect(narrow.hits.map((hit) => hit.path)).toEqual(["/docs/install"]);

    const none = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "de", query: "install", limit: 10 });
    expect(none.total).toBe(0);
  });

  it("replaces the set whole and keeps the last document at an address", async () => {
    const written = await replaceSiteSearchDocuments(key(), "print-2", [
      { path: "/home", title: "Home", description: "", text: "First reading." },
      { path: "/home", title: "Home", description: "", text: "Second reading, the one that stays." },
    ]);
    expect(written.status).toBe("written");
    if (written.status !== "written") return;
    expect(written.state.documentCount).toBe(1);

    const gone = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "en", query: "postgres", limit: 10 });
    expect(gone.total).toBe(0);
    const kept = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "en", query: "second", limit: 10 });
    expect(kept.hits.map((hit) => hit.path)).toEqual(["/home"]);
  });

  it("writes nothing a visitor types into the text query's grammar", async () => {
    const result = await searchSiteDocuments({ siteId: site.id, areaMask: 1, locale: "en", query: "second & !(reading) | ", limit: 10 });

    expect(result.hits.map((hit) => hit.path)).toEqual(["/home"]);
  });
});
