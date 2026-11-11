import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  deleteSiteTranslation,
  ensureSiteMessageId,
  readTranslationChangeMarkers,
  upsertSiteTranslationForSite,
  upsertSiteTranslations,
  upsertTranslation,
} from "./translations";

/**
 * A Site keeps translations without expiry and empties a store only when its marker differs from the
 * one it saw last. A write that changes an answer without moving the marker leaves every Site on the old
 * answer until something else moves it; a fill that moves it serializes every concurrent fill of a Site.
 */
describe("translation change markers against PostgreSQL", () => {
  const globalCtx = `pgtest-markers-${process.pid}`;
  let siteA: PhiTestSite;
  let siteB: PhiTestSite;

  async function dropGlobalTestMessages() {
    const pool = await requirePhiTestDatabase();
    await pool.query("DELETE FROM phis.tr_msg WHERE ctx = $1", [globalCtx]);
  }

  beforeAll(async () => {
    await dropPhiTestSites();
    await dropGlobalTestMessages();
    siteA = await createPhiTestSite("tr-markers-a");
    siteB = await createPhiTestSite("tr-markers-b");
  });

  afterAll(async () => {
    await dropGlobalTestMessages();
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  async function markers(site: PhiTestSite) {
    return readTranslationChangeMarkers(site.id);
  }

  it("leaves the marker alone when a missing Site translation is filled", async () => {
    const msgId = await ensureSiteMessageId(siteA.id, "Fill me", "pgtest");
    const before = await markers(siteA);

    await upsertSiteTranslations([{ msgId, locale: "de", translation: "Füll mich" }]);

    expect(await markers(siteA)).toEqual(before);
  });

  it("leaves an editor's translation standing when a fill for the same message arrives after it", async () => {
    const pool = await requirePhiTestDatabase();
    const msgId = await ensureSiteMessageId(siteA.id, "Keep my edit", "pgtest");
    await upsertSiteTranslationForSite({ siteId: siteA.id, msgId, locale: "de", translation: "Von Hand" });
    const before = await markers(siteA);

    await upsertSiteTranslations([{ msgId, locale: "de", translation: "Vom Anbieter" }]);

    const { rows } = await pool.query<{ translation: string }>(
      `SELECT translation FROM phis.tr_site_lang WHERE msg_id = $1 AND locale = 'de'`,
      [msgId],
    );
    expect(rows[0]?.translation).toBe("Von Hand");
    expect(await markers(siteA)).toEqual(before);
  });

  it("moves only the edited Site's marker on an editor write", async () => {
    const msgId = await ensureSiteMessageId(siteA.id, "Edit me", "pgtest");
    const beforeA = await markers(siteA);
    const beforeB = await markers(siteB);

    await upsertSiteTranslationForSite({ siteId: siteA.id, msgId, locale: "de", translation: "Bearbeite mich" });

    const afterA = await markers(siteA);
    expect(afterA.site).not.toBe(beforeA.site);
    expect(afterA.global).toBe(beforeA.global);
    expect((await markers(siteB)).site).toBe(beforeB.site);
  });

  it("moves the Site's marker when a translation is deleted", async () => {
    const msgId = await ensureSiteMessageId(siteA.id, "Delete me", "pgtest");
    await upsertSiteTranslationForSite({ siteId: siteA.id, msgId, locale: "de", translation: "Lösch mich" });
    const before = await markers(siteA);

    await deleteSiteTranslation({ siteId: siteA.id, msgId, locale: "de" });

    expect((await markers(siteA)).site).not.toBe(before.site);
  });

  // The cascade from `tr_site_msg` deletes the translations after their message is gone, so the
  // `tr_site_lang` trigger cannot find the Site; the message's own trigger has to.
  it("moves the Site's marker when a message and its translations go by cascade", async () => {
    const pool = await requirePhiTestDatabase();
    const msgId = await ensureSiteMessageId(siteA.id, "Cascade me", "pgtest");
    await upsertSiteTranslationForSite({ siteId: siteA.id, msgId, locale: "de", translation: "Kaskadiere mich" });
    const before = await markers(siteA);

    await pool.query("DELETE FROM phis.tr_site_msg WHERE id = $1", [msgId]);

    expect((await markers(siteA)).site).not.toBe(before.site);
  });

  it("lets a Site with translations be deleted", async () => {
    const pool = await requirePhiTestDatabase();
    const doomed = await createPhiTestSite("tr-markers-doomed");
    const msgId = await ensureSiteMessageId(doomed.id, "Doomed", "pgtest");
    await upsertSiteTranslationForSite({ siteId: doomed.id, msgId, locale: "de", translation: "Verloren" });

    await pool.query("DELETE FROM phis.sites WHERE id = $1", [doomed.id]);

    expect((await markers(doomed)).site).toBeNull();
  });

  it("leaves the global marker alone on a fill and moves it on any other write", async () => {
    const pool = await requirePhiTestDatabase();
    const msg = "Global fill me";
    const hash = createHash("sha256").update(msg.slice(0, 50)).digest("hex");
    const before = await markers(siteA);

    await upsertTranslation("de", msg, globalCtx, "Global füll mich", hash);
    expect((await markers(siteA)).global).toBe(before.global);

    await pool.query(
      `UPDATE phis.tr_lang AS lang SET translation = 'Global geändert'
       FROM phis.tr_msg AS msg
       WHERE lang.msg_id = msg.id AND msg.ctx = $1`,
      [globalCtx],
    );
    const after = await markers(siteA);
    expect(after.global).not.toBe(before.global);
    expect(after.site).toBe(before.site);
  });
});
