import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  computeExternalSourceHash,
  ensureSiteExternalTranslationUnit,
  ensureSiteMessageId,
  ensureSiteMessageIds,
  findSiteExternalTranslationUnits,
} from "./translations";

afterAll(async () => {
  await closePhiTestPool();
});

/**
 * A translation request resolves a whole page's strings at once. These run the batch statements for
 * real -- `unnest`, the hash compared as bytes, the conflict rule -- because a fake accepts any SQL.
 */
describe("translation batches against PostgreSQL", () => {
  let site: PhiTestSite;
  const ctx = `pgtest-batch-${process.pid}`;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("tr-batch");
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  it("creates what is missing and answers what exists, with the ids the single form gives", async () => {
    const known = await ensureSiteMessageId(site.id, "Known message", ctx);

    const ids = await ensureSiteMessageIds(site.id, ["Known message", "New message", "Another new one"], ctx);

    expect(ids.get("Known message")).toBe(known);
    expect(ids.get("New message")).toBe(await ensureSiteMessageId(site.id, "New message", ctx));
    expect(ids.get("Another new one")).toBe(await ensureSiteMessageId(site.id, "Another new one", ctx));
    expect(await ensureSiteMessageIds(site.id, ["New message", "Known message"], ctx))
      .toEqual(new Map([["New message", ids.get("New message")], ["Known message", known]]));
  });

  it("keeps two messages sharing a long opening apart", async () => {
    // The hash covered the first fifty characters once, and HTML opening with the same link did not.
    const opening = '<x-link data-index="0"><x-code data-index="0" translate="no">';
    const ids = await ensureSiteMessageIds(site.id, [`${opening}/api/v1/tr</x-code></x-link>`, `${opening}/api/operator</x-code></x-link>`], ctx);

    expect(typeof ids.get(`${opening}/api/v1/tr</x-code></x-link>`)).toBe("number");
    expect(typeof ids.get(`${opening}/api/operator</x-code></x-link>`)).toBe("number");
    expect(ids.get(`${opening}/api/v1/tr</x-code></x-link>`)).not.toBe(ids.get(`${opening}/api/operator</x-code></x-link>`));
  });

  it("answers a row stored under the hash for another text as an Error for that message alone", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.tr_site_msg (site_id, msg, msg_hash, ctx)
       VALUES ($1, 'Somebody else', sha256(convert_to('Taken', 'UTF8')), $2)`,
      [site.id, ctx],
    );
    const ids = await ensureSiteMessageIds(site.id, ["Taken", "Plain"], ctx);

    expect(ids.get("Taken")).toBeInstanceOf(Error);
    expect(typeof ids.get("Plain")).toBe("number");
  });

  it("finds the external units of many sources in one go", async () => {
    const source = "Ein Quelltext";
    const msgId = await ensureSiteExternalTranslationUnit({
      siteId: site.id,
      sourceLocale: "de",
      source,
      sourceHash: computeExternalSourceHash(source),
      canonicalMsg: "A source text",
      ctx,
    });

    const units = await findSiteExternalTranslationUnits({
      siteId: site.id,
      locale: "de",
      ctx,
      entries: [source, "Unbekannt"].map((text) => ({ source: text, sourceHash: computeExternalSourceHash(text) })),
    });

    expect(units.get(source)).toEqual({ msgId, canonicalMsg: "A source text" });
    expect(units.get("Unbekannt")).toBeNull();
  });
});
