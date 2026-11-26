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

/** `--replace-source`: same key, other words -- the message takes the file's text, other locales lose their answers. */
describe("translations import --replace-source, against PostgreSQL", () => {
  const globalCtx = "pgtest exchange replace";
  const opening = "This paragraph opens the same way in both versions ";
  const oldText = `${opening}and then says the old thing.`;
  const newText = `${opening}and then says something new, rewritten.`;
  let site: PhiTestSite;

  const fileFor = (store: string, locale: string, entries: Array<Record<string, unknown>>) =>
    ({ version: 1, store, locale, exportedAt: "x", entries }) as unknown as PhiTranslationExchangeFile;

  const siteMessage = async (ctx: string) => (await getPool().query<{ id: number; msg: string }>(
    "SELECT id, msg FROM phis.tr_site_msg WHERE site_id = $1 AND ctx = $2", [site.id, ctx],
  )).rows;
  const siteAnswers = async (id: number) => (await getPool().query<{ locale: string; translation: string }>(
    "SELECT locale, translation FROM phis.tr_site_lang WHERE msg_id = $1 ORDER BY locale", [id],
  )).rows;

  const cleanGlobal = () => getPool().query("DELETE FROM phis.tr_msg WHERE ctx LIKE 'pgtest exchange replace%'");

  beforeAll(async () => {
    expect(hashOf(oldText)).toBe(hashOf(newText));
    await requirePhiTestDatabase();
    await dropPhiTestSites();
    await cleanGlobal();
    site = await createPhiTestSite("tr-exchange-replace");
  });

  afterAll(async () => {
    await cleanGlobal();
    await dropPhiTestSites();
  });

  it("refuses without the flag, replaces with it under the same id, and drops the other locales' answers", async () => {
    const pool = getPool();
    const ctx = "[html]pgtest replace";
    const id = await ensureSiteMessageId(site.id, oldText, ctx);
    await pool.query(
      "INSERT INTO phis.tr_site_lang (msg_id, locale, translation) VALUES ($1, 'de', 'Alter Text'), ($1, 'fr', 'Ancien texte'), ($1, 'es', 'Texto viejo')",
      [id],
    );
    const { rows: [before] } = await pool.query<{ marker: string }>("SELECT marker::text FROM phis.tr_site_marker WHERE site_id = $1", [site.id]);
    const file = fileFor(site.key, "de", [{ hash: hashOf(newText), ctx, msg: newText, translation: "Neuer Text" }]);

    const strict = await importPhiTranslations(pool, file, { siteKey: site.key, overwrite: true });
    expect(strict.counts).toMatchObject({ sourceReplaced: 0, refused: 1 });
    expect(strict.refused[0]?.reason).toMatch(/source text changed since the export/);
    expect((await siteMessage(ctx))[0]?.msg).toBe(oldText);

    const dry = await importPhiTranslations(pool, file, { siteKey: site.key, replaceSource: true, dryRun: true });
    expect(dry.counts).toMatchObject({ sourceReplaced: 1, refused: 0 });
    expect(dry.sourceReplaced[0]).toMatchObject({
      ctx,
      differsAt: opening.length + "and then says ".length,
      dropped: [{ locale: "es", translation: "Texto viejo" }, { locale: "fr", translation: "Ancien texte" }],
    });
    expect(dry.sourceReplaced[0]?.oldExcerpt).toMatch(/the old thing/);
    expect(dry.sourceReplaced[0]?.newExcerpt).toMatch(/something new/);
    expect((await siteMessage(ctx))[0]?.msg).toBe(oldText);
    expect(await siteAnswers(id)).toHaveLength(3);

    const result = await importPhiTranslations(pool, file, { siteKey: site.key, replaceSource: true });
    expect(result.counts).toMatchObject({ sourceReplaced: 1, written: 0, replaced: 0, refused: 0 });
    expect(await siteMessage(ctx)).toEqual([{ id, msg: newText }]);
    expect(await siteAnswers(id)).toEqual([{ locale: "de", translation: "Neuer Text" }]);
    const { rows: [after] } = await pool.query<{ marker: string }>("SELECT marker::text FROM phis.tr_site_marker WHERE site_id = $1", [site.id]);
    expect(after?.marker).not.toBe(before?.marker);

    // The runtime now finds the new text under its key instead of a collision.
    expect(await ensureSiteMessageId(site.id, newText, ctx)).toBe(id);
    // The same file again is an ordinary import.
    expect((await importPhiTranslations(pool, file, { siteKey: site.key, replaceSource: true })).counts)
      .toMatchObject({ sourceReplaced: 0, unchanged: 1 });
  });

  it("refuses a translation that breaks the new text's tags, a second source for one key, and the source locale", async () => {
    const pool = getPool();
    const ctx = "[html]pgtest replace checks";
    await ensureSiteMessageId(site.id, `${opening}<b>old</b>`, ctx);
    const tagged = `${opening}<b>new</b> words`;
    const broken = await importPhiTranslations(pool, fileFor(site.key, "de", [
      { hash: hashOf(tagged), ctx, msg: tagged, translation: "Neue Worte" },
    ]), { siteKey: site.key, replaceSource: true });
    expect(broken.refused[0]?.reason).toBe("its tags are not the source's");

    const other = `${opening}<b>other</b> words`;
    const twice = await importPhiTranslations(pool, fileFor(site.key, "de", [
      { hash: hashOf(tagged), ctx, msg: tagged, translation: "<b>Neue</b> Worte" },
      { hash: hashOf(other), ctx, msg: other, translation: "<b>Andere</b> Worte" },
    ]), { siteKey: site.key, replaceSource: true });
    expect(twice.counts).toMatchObject({ sourceReplaced: 1, refused: 1 });
    expect(twice.refused[0]?.reason).toMatch(/earlier entry/);
    expect((await siteMessage(ctx))[0]?.msg).toBe(tagged);

    const source = await importPhiTranslations(pool, fileFor(site.key, "en", [
      { hash: hashOf(other), ctx, msg: other, translation: other },
    ]), { siteKey: site.key, replaceSource: true });
    expect(source.refused[0]?.reason).toMatch(/source language is en/);
  });

  it("refuses a message content versions read as their own text", async () => {
    const pool = getPool();
    const ctx = "pgtest replace content";
    const id = await ensureSiteMessageId(site.id, oldText, ctx);
    const { rows: [content] } = await pool.query<{ id: number }>(
      "INSERT INTO phis.site_content (site_id, type, slug) VALUES ($1, 1, 'pgtest-replace') RETURNING id",
      [site.id],
    );
    const { rows: [version] } = await pool.query<{ id: number }>(
      "INSERT INTO phis.site_content_versions (content_id, version_no) VALUES ($1, 1) RETURNING id",
      [content!.id],
    );
    await pool.query(
      "INSERT INTO phis.site_content_version_text (version_id, field_name, msg_id) VALUES ($1, 'content', $2)",
      [version!.id, id],
    );
    const result = await importPhiTranslations(pool, fileFor(site.key, "de", [
      { hash: hashOf(newText), ctx, msg: newText, translation: "Neuer Text" },
    ]), { siteKey: site.key, replaceSource: true });
    expect(result.refused[0]?.reason).toMatch(/1 content version read it/);
    expect((await siteMessage(ctx))[0]?.msg).toBe(oldText);
  });

  it("replaces in the global store too, with a hand-written file without hash", async () => {
    const pool = getPool();
    await upsertTranslation("fr", oldText, globalCtx, "Ancien texte", hashOf(oldText));
    await upsertTranslation("es", oldText, globalCtx, "Texto viejo", hashOf(oldText));
    const raw = JSON.stringify({ version: 1, store: "global", locale: "fr", exportedAt: "x", entries: [
      { ctx: globalCtx, msg: newText, translation: "Nouveau texte" },
    ] });
    const file = readPhiTranslationExchangeFile(raw, { replaceSource: true });
    const { rows: [before] } = await pool.query<{ marker: string }>("SELECT marker::text FROM phis.tr_marker WHERE scope = 'global'");
    const result = await importPhiTranslations(pool, file, { replaceSource: true });
    expect(result.counts).toMatchObject({ sourceReplaced: 1, refused: 0 });
    expect(result.sourceReplaced[0]?.dropped).toEqual([{ locale: "es", translation: "Texto viejo" }]);
    const { rows } = await pool.query<{ msg: string }>("SELECT msg FROM phis.tr_msg WHERE ctx = $1", [globalCtx]);
    expect(rows).toEqual([{ msg: newText }]);
    expect((await getTranslations("fr", [{ msg: newText, hash: hashOf(newText) }], globalCtx)).get(hashOf(newText)))
      .toBe("Nouveau texte");
    expect((await getTranslations("es", [{ msg: newText, hash: hashOf(newText) }], globalCtx)).get(hashOf(newText)))
      .toBeUndefined();
    const { rows: [after] } = await pool.query<{ marker: string }>("SELECT marker::text FROM phis.tr_marker WHERE scope = 'global'");
    expect(after?.marker).not.toBe(before?.marker);
  });
});
