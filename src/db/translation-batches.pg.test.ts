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
  findSiteExternalTranslationUnitsByContext,
  resolveSiteMessageIds,
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

  it("answers a hash collision as an Error for that message alone", async () => {
    // The hash covers the first fifty characters, so these two share one.
    const prefix = "x".repeat(50);
    const ids = await ensureSiteMessageIds(site.id, [`${prefix} first`, `${prefix} second`, "Plain"], ctx);

    expect(typeof ids.get(`${prefix} first`)).toBe("number");
    expect(ids.get(`${prefix} second`)).toBeInstanceOf(Error);
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

    const units = await findSiteExternalTranslationUnitsByContext({
      siteId: site.id,
      locale: "de",
      entries: [source, "Unbekannt"].map((text) => ({ source: text, sourceHash: computeExternalSourceHash(text), ctx })),
    });

    expect(units).toEqual([{ msgId, canonicalMsg: "A source text" }, null]);
  });

  it("resolves messages under contexts of their own in one go, and only reads them where it may not create", async () => {
    const entries = [{ msg: "Pro", ctx: `${ctx} one` }, { msg: "Pro", ctx: `${ctx} two` }];
    expect(await resolveSiteMessageIds(site.id, entries, { create: false })).toEqual([null, null]);
    const created = await resolveSiteMessageIds(site.id, entries);
    expect(created.every((id) => typeof id === "number")).toBe(true);
    expect(created[0]).not.toBe(created[1]);
    expect(await resolveSiteMessageIds(site.id, [...entries, { msg: "Never", ctx: `${ctx} one` }], { create: false }))
      .toEqual([created[0], created[1], null]);
  });

  it("finds the external units of sources under contexts of their own in one go, each only under its own", async () => {
    const source = "Édition Pro";
    const [first, second] = [`[extern]${ctx} one`, `[extern]${ctx} two`];
    const msgId = await ensureSiteExternalTranslationUnit({
      siteId: site.id, sourceLocale: "fr", source, sourceHash: computeExternalSourceHash(source), canonicalMsg: "Pro edition", ctx: first,
    });
    const lookup = (entries: Array<[string, string]>) => findSiteExternalTranslationUnitsByContext({
      siteId: site.id, locale: "fr", entries: entries.map(([text, at]) => ({ source: text, sourceHash: computeExternalSourceHash(text), ctx: at })),
    });
    // In order: the unit under its context, none under another context, none for a text never rendered.
    expect(await lookup([[source, first], [source, second], ["Inconnu", first]])).toEqual([{ msgId, canonicalMsg: "Pro edition" }, null, null]);
    expect(await lookup([])).toEqual([]);
  });
});
