import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPool } from "@/lib/db";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { ensureSiteMessageId } from "../db/translations";
import { exportPhiTranslations, importPhiTranslations, readPhiTranslationStatus } from "./translations-exchange.mts";

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
