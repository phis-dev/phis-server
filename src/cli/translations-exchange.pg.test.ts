import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { ensureSiteMessageId, getTranslations, upsertTranslation } from "../db/translations";
import {
  exportPhiTranslations,
  importPhiTranslations,
  readPhiTranslationExchangeFile,
  readPhiTranslationStatus,
  type PhiTranslationExchangeFile,
} from "./translations-exchange.mts";

afterAll(async () => {
  await closePhiTestPool();
});

/** A Site's store, so the global catalogue of the development database is never touched. */
describe("translations through a file, against PostgreSQL", () => {
  let site: PhiTestSite;
  const ctx = "pgtest exchange";

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("tr-exchange");
    await ensureSiteMessageId(site.id, "Save", ctx);
    await ensureSiteMessageId(site.id, "Delete %n files", ctx);
    await ensureSiteMessageId(site.id, "Cancel", ctx);
  });

  afterAll(async () => {
    await dropPhiTestSites();
  });

  it("exports what is missing, imports it, and keeps what is already there", async () => {
    const pool = getPool();
    const exported = await exportPhiTranslations(pool, { locale: "fr", siteKey: site.key, missing: true });
    expect(exported.store).toBe(site.key);
    expect(exported.entries.map((entry) => entry.msg).sort()).toEqual(["Cancel", "Delete %n files", "Save"]);

    const answers: Record<string, string> = { Save: "Enregistrer", "Delete %n files": "Supprimer %n fichiers", Cancel: "" };
    const file = { ...exported, entries: exported.entries.map((entry) => ({ ...entry, translation: answers[entry.msg] ?? null })) };

    const dry = await importPhiTranslations(pool, file, { siteKey: site.key, dryRun: true });
    expect(dry.counts).toMatchObject({ written: 2, refused: 1 });
    expect((await readPhiTranslationStatus(pool, { siteKey: site.key, locales: ["fr"] })).locales)
      .toEqual([{ locale: "fr", translated: 0, missing: 3 }]);

    const written = await importPhiTranslations(pool, file, { siteKey: site.key });
    expect(written.counts).toMatchObject({ written: 2, refused: 1 });
    expect(written.refused[0]).toMatchObject({ msg: "Cancel", reason: "the translation is empty" });
    expect((await exportPhiTranslations(pool, { locale: "fr", siteKey: site.key, missing: true })).entries.map((entry) => entry.msg))
      .toEqual(["Cancel"]);

    const changed = { ...file, entries: file.entries.map((entry) => (entry.msg === "Save" ? { ...entry, translation: "Sauver" } : entry)) };
    expect((await importPhiTranslations(pool, changed, { siteKey: site.key })).counts).toMatchObject({ kept: 1, unchanged: 1 });
    expect((await importPhiTranslations(pool, changed, { siteKey: site.key, overwrite: true })).counts)
      .toMatchObject({ replaced: 1, unchanged: 1 });
  });

  it("refuses a source that changed, a broken placeholder, and another store's file", async () => {
    const pool = getPool();
    const exported = await exportPhiTranslations(pool, { locale: "es", siteKey: site.key });
    const save = exported.entries.find((entry) => entry.msg === "Save")!;
    const files = exported.entries.find((entry) => entry.msg === "Delete %n files")!;
    const result = await importPhiTranslations(pool, {
      ...exported,
      entries: [
        { ...save, msg: "Save it", translation: "Guardar" },
        { ...files, translation: "Eliminar archivos" },
      ],
    }, { siteKey: site.key });
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      "its hash is not the hash of its msg",
      "its placeholders are not the source's",
    ]);
    await expect(importPhiTranslations(pool, exported, {})).rejects.toThrow(/exported from the store/);
  });
});

const hashOf = (msg: string) => createHash("sha256").update(msg.slice(0, 50)).digest("hex");

/** `--add`: the messages the store lacks are created, through the function the request path uses. */
describe("translations import --add, against PostgreSQL", () => {
  const globalCtx = "pgtest exchange add";
  let site: PhiTestSite;

  const fileFor = (store: string, locale: string, entries: Array<Record<string, unknown>>) =>
    ({ version: 1, store, locale, exportedAt: "x", entries }) as unknown as PhiTranslationExchangeFile;

  const countGlobal = async (msg: string, ctx = globalCtx) => Number((await getPool().query<{ n: string }>(
    "SELECT count(*) AS n FROM phis.tr_msg WHERE ctx = $1 AND msg = $2", [ctx, msg],
  )).rows[0]?.n);

  const cleanGlobal = () => getPool().query("DELETE FROM phis.tr_msg WHERE ctx LIKE 'pgtest exchange add%'");

  beforeAll(async () => {
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    await cleanGlobal();
    site = await createPhiTestSite("tr-exchange-add");
  });

  afterAll(async () => {
    await cleanGlobal();
    await dropPhiTestSites();
  });

  it("skips an unknown message as before, without --add", async () => {
    const file = fileFor("global", "fr", [{ hash: hashOf("Add to cart"), ctx: globalCtx, msg: "Add to cart", translation: "Ajouter au panier" }]);
    const result = await importPhiTranslations(getPool(), file, {});
    expect(result.counts).toMatchObject({ created: 0, written: 0, refused: 1 });
    expect(await countGlobal("Add to cart")).toBe(0);
  });

  it("creates in the global store under the runtime's key, and a dry run only reports it", async () => {
    const pool = getPool();
    const file = fileFor("global", "fr", [{ hash: hashOf("Add to cart"), ctx: globalCtx, msg: "Add to cart", translation: "Ajouter au panier" }]);
    const dry = await importPhiTranslations(pool, file, { add: true, dryRun: true });
    expect(dry.counts).toMatchObject({ created: 1, written: 0, refused: 0 });
    expect(dry.created.map((entry) => entry.msg)).toEqual(["Add to cart"]);
    expect(await countGlobal("Add to cart")).toBe(0);

    const result = await importPhiTranslations(pool, file, { add: true });
    expect(result.counts).toMatchObject({ created: 1, written: 0, refused: 0 });
    // Read back the way the runtime reads, by its own hash.
    expect((await getTranslations("fr", [{ msg: "Add to cart", hash: hashOf("Add to cart") }], globalCtx)).get(hashOf("Add to cart")))
      .toBe("Ajouter au panier");
    // The runtime's own fill finds the same message instead of creating a second one.
    await upsertTranslation("es", "Add to cart", globalCtx, "Anadir al carrito", hashOf("Add to cart"));
    expect(await countGlobal("Add to cart")).toBe(1);

    // It exists now: the same file fills nothing new and creates nothing.
    expect((await importPhiTranslations(pool, file, { add: true })).counts).toMatchObject({ created: 0, unchanged: 1 });
  });

  it("fills a message that exists as before, and creates only the one that does not", async () => {
    const pool = getPool();
    await upsertTranslation("de", "Products", globalCtx, "Produkte", hashOf("Products"));
    const result = await importPhiTranslations(pool, fileFor("global", "fr", [
      { hash: hashOf("Products"), ctx: globalCtx, msg: "Products", translation: "Produits" },
      { hash: hashOf("GUI development"), ctx: globalCtx, msg: "GUI development", translation: "Developpement GUI" },
    ]), { add: true });
    expect(result.counts).toMatchObject({ created: 1, written: 1, replaced: 0, refused: 0 });
  });

  it("takes a hand-written file without hashes, and refuses a hash that is not the message's", async () => {
    const pool = getPool();
    const raw = JSON.stringify({ version: 1, store: "global", locale: "fr", exportedAt: "x", entries: [
      { ctx: globalCtx, msg: "Checkout", translation: "Paiement" },
    ] });
    expect(() => readPhiTranslationExchangeFile(raw)).toThrow(/Entry 1/);
    const file = readPhiTranslationExchangeFile(raw, { add: true });
    expect(file.entries[0]?.hash).toBe(hashOf("Checkout"));
    expect((await importPhiTranslations(pool, file, { add: true })).counts).toMatchObject({ created: 1 });
    const wrong = fileFor("global", "fr", [{ hash: hashOf("Other"), ctx: globalCtx, msg: "Basket", translation: "Panier" }]);
    const result = await importPhiTranslations(pool, wrong, { add: true });
    expect(result.refused[0]?.reason).toBe("its hash is not the hash of its msg");
    expect(await countGlobal("Basket")).toBe(0);
  });

  it("aborts before writing when an entry cannot be created", async () => {
    const pool = getPool();
    const good = { hash: hashOf("Wishlist"), ctx: globalCtx, msg: "Wishlist", translation: "Liste de souhaits" };
    await expect(importPhiTranslations(pool, fileFor("global", "fr", [
      good,
      { hash: hashOf(" "), ctx: globalCtx, msg: " ", translation: "x" },
      { hash: hashOf("Bad"), ctx: "[bogus]ctx", msg: "Bad", translation: "Mauvais" },
    ]), { add: true })).rejects.toThrow(/nothing was written[\s\S]*Entry 2[\s\S]*Entry 3/);
    expect(await countGlobal("Wishlist")).toBe(0);
  });

  it("refuses an extern unit, and a source language equal to the target", async () => {
    const pool = getPool();
    const externCtx = `[extern]${globalCtx}`;
    const extern = await importPhiTranslations(pool, fileFor("global", "fr", [
      { hash: hashOf("Panier"), ctx: externCtx, msg: "Panier", translation: "Cart" },
    ]), { add: true });
    expect(extern.counts).toMatchObject({ created: 0, refused: 1 });
    expect(extern.refused[0]?.reason).toMatch(/extern/);
    expect(await countGlobal("Panier", externCtx)).toBe(0);

    const same = await importPhiTranslations(pool, fileFor("global", "en", [
      { hash: hashOf("Orders"), ctx: globalCtx, msg: "Orders", translation: "Orders" },
    ]), { add: true });
    expect(same.counts).toMatchObject({ created: 0, refused: 1 });
    expect(await countGlobal("Orders")).toBe(0);
  });

  it("handles two lines with one key: equal ones once, different ones abort", async () => {
    const pool = getPool();
    const line = { hash: hashOf("Totals"), ctx: globalCtx, msg: "Totals", translation: "Totaux" };
    const twice = await importPhiTranslations(pool, fileFor("global", "fr", [line, line]), { add: true });
    expect(twice.counts).toMatchObject({ created: 1, unchanged: 1 });
    const other = { ...line, msg: "Shipping", hash: hashOf("Shipping") };
    await expect(importPhiTranslations(pool, fileFor("global", "fr", [
      other, { ...other, translation: "Livraison" }, { ...other, translation: "Expedition" },
    ]), { add: true })).rejects.toThrow(/occurs twice/);
    expect(await countGlobal("Shipping")).toBe(0);
  });

  it("creates in a Site's store the same way", async () => {
    const pool = getPool();
    const file = fileFor(site.key, "fr", [{ hash: hashOf("Add to cart"), ctx: "pgtest shop", msg: "Add to cart", translation: "Ajouter au panier" }]);
    expect((await importPhiTranslations(pool, file, { siteKey: site.key })).counts).toMatchObject({ created: 0, refused: 1 });
    const result = await importPhiTranslations(pool, file, { siteKey: site.key, add: true });
    expect(result.counts).toMatchObject({ created: 1, refused: 0 });
    // The runtime's own creation finds that message.
    const id = await ensureSiteMessageId(site.id, "Add to cart", "pgtest shop");
    const { rows } = await pool.query("SELECT 1 FROM phis.tr_site_msg WHERE site_id = $1 AND msg = 'Add to cart'", [site.id]);
    expect(rows).toHaveLength(1);
    expect(id).toBeGreaterThan(0);
    expect((await exportPhiTranslations(pool, { locale: "fr", siteKey: site.key })).entries
      .find((entry) => entry.msg === "Add to cart")?.translation).toBe("Ajouter au panier");
  });
});
