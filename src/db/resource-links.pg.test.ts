import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PhiBaseRole } from "@phis/contracts/access";
import { PhisResourceLinkFlag } from "@phis/contracts/resource-links";
import { PhisSiteThreadKindFlag, PhisThreadKind } from "@phis/contracts/threads";

import {
  addPhiTestGroupMember,
  closePhiTestPool,
  createPhiTestGroup,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhisResourceLinkError } from "./resource-links";
import { createThread, getThreadDetail } from "./threads";
import { buildPhisAddonResourceLinksCapability } from "@/lib/addons/resource-links-capability";

const ADDON = "@phis/github";
const LINK_TYPE = 20;

/**
 * A link is a person's statement that two records belong together, bounded by what that person may
 * reach. Two ways that bound could be crossed are decided by the statement itself and so by PostgreSQL:
 * a second person naming the same external record for a subject of their own must not be handed the
 * first person's link, and removing a link takes the same reach as making one.
 */
describe("resource links against PostgreSQL", () => {
  let site: PhiTestSite;
  let anna: number;
  let bert: number;
  let carla: number;
  let annasThread: number;
  let carlasThread: number;

  async function staff(groupId: number, userId: number) {
    const pool = await requirePhiTestDatabase();
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags)
       VALUES ($1, $2, '@phis/server/core', $3)
       ON CONFLICT (site_id, user_id, provider_id) DO UPDATE SET role_flags = EXCLUDED.role_flags`,
      [site.id, userId, PhiBaseRole.Staff],
    );
    await addPhiTestGroupMember({ site, groupId, userId });
  }

  const asUser = (userId: number) => buildPhisAddonResourceLinksCapability({
    addonId: ADDON, siteId: site.id, actorUserId: userId,
  });

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    await dropPhiTestSites();
    site = await createPhiTestSite("resource-links");
    await pool.query(
      `INSERT INTO phis.site_thread_config (site_id, flags) VALUES ($1, $2)
       ON CONFLICT (site_id) DO UPDATE SET flags = EXCLUDED.flags`,
      [site.id, PhisSiteThreadKindFlag.Direct],
    );
    // Anna and Bert share one group, Carla and Bert another: Bert is in both conversations, Anna and
    // Carla each in one, and neither can see the other's.
    anna = await createPhiTestUser(site);
    bert = await createPhiTestUser(site);
    carla = await createPhiTestUser(site);
    const left = await createPhiTestGroup(site, "pgtest-links-left");
    const right = await createPhiTestGroup(site, "pgtest-links-right");
    await staff(left, anna);
    await staff(left, bert);
    await staff(right, carla);
    await staff(right, bert);
    annasThread = (await createThread({
      siteId: site.id, kind: PhisThreadKind.Direct, subject: "Left", message: "Hello Bert.",
      participantUserIds: [bert], createdByUserId: anna,
    })).thread.id;
    carlasThread = (await createThread({
      siteId: site.id, kind: PhisThreadKind.Direct, subject: "Right", message: "Hello Bert.",
      participantUserIds: [bert], createdByUserId: carla,
    })).thread.id;
    expect(await getThreadDetail(site.id, { kind: "user", userId: carla }, annasThread)).toBeNull();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("does not hand one person's link to another who names the same record elsewhere", async () => {
    const annas = await asUser(anna).link({
      subject: { kind: "thread", id: annasThread }, type: LINK_TYPE, externalId: "issue-7",
    });
    expect(annas.subject).toEqual({ kind: "thread", id: annasThread });

    // Carla may reach her own thread, and that is the only thing that was checked. The record is
    // already linked to Anna's, which she may not see: the answer is a refusal, not Anna's link.
    await expect(asUser(carla).link({
      subject: { kind: "thread", id: carlasThread }, type: LINK_TYPE, externalId: "issue-7",
    })).rejects.toThrow(PhisResourceLinkError);
    expect(await asUser(carla).list({ kind: "thread", id: carlasThread })).toEqual([]);
    expect((await asUser(anna).list({ kind: "thread", id: annasThread })).map((link) => link.id))
      .toEqual([annas.id]);
  });

  it("says the same link again for the same subject, and keeps a consent once given", async () => {
    const first = await asUser(anna).link({
      subject: { kind: "thread", id: annasThread }, type: LINK_TYPE, externalId: "issue-8",
    });
    const again = await asUser(anna).link({
      subject: { kind: "thread", id: annasThread }, type: LINK_TYPE, externalId: "issue-8",
      flags: PhisResourceLinkFlag.Synced,
    });
    expect(again.id).toBe(first.id);
    expect(again.flags & PhisResourceLinkFlag.Synced).not.toBe(0);
  });

  it("takes the same reach to remove a link as to make one", async () => {
    const annas = await asUser(anna).link({
      subject: { kind: "thread", id: annasThread }, type: LINK_TYPE, externalId: "issue-9",
      flags: PhisResourceLinkFlag.Synced,
    });

    await expect(asUser(carla).unlink(annas.id)).rejects.toThrow(/cannot reach/u);
    expect((await asUser(anna).list({ kind: "thread", id: annasThread })).map((link) => link.id))
      .toContain(annas.id);

    // Bert is in the conversation; Anna made it. Either may take it back, and a second removal is nothing.
    expect(await asUser(bert).unlink(annas.id)).toBe(true);
    expect(await asUser(anna).unlink(annas.id)).toBe(false);
  });
});
