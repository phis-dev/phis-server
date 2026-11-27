import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PHIS_CORE_CAPABILITIES } from "@phis/contracts/addon";
import { PhiBaseRole, PhiUserEmailSource } from "@phis/contracts/access";
import { PhisSiteAddressFlags, type PhisUserField } from "@phis/contracts/users";

/*
 * The listeners of the user events are read from the installed manifests; these are the ones the tests
 * install. Everything else the module answers stays as it is.
 */
const installed = vi.hoisted(() => ({ entries: {} as Record<string, unknown> }));
vi.mock("@/lib/addons/installed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/addons/installed")>()),
  getPhisAddonInstalledManifest: () => installed.entries,
}));

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { ensureEntitlementSubject } from "./entitlements.mts";
import {
  createPhisSiteAddress,
  listPhisUsersAccessLog,
  readPhisCurrentSiteAddresses,
  readPhisUsersAccessLogDays,
  removePhisSiteAddress,
  setPhisUsersAccessLogDays,
} from "./site-users";
import { addThreadMessage, getThreadDetail } from "./threads";
import { buildPhisAddonThreadsCapability } from "@/lib/addons/threads-capability";
import { readPhisCustomerFile } from "@/lib/site-customer-file";
import { grantPhisAddonUsersBackground, revokePhisAddonUsersBackground } from "./users-grants.mts";
import { setUserProfilePhones, upsertUserProfile } from "./user-profiles";
import { updateUserAccountProfileFields } from "./user-accounts";
import { recordUserSiteLogin, upsertUserSiteMembership } from "./user-site-memberships";
import { forgetExpiredPhisUsersAccessLog } from "./maintenance.mts";
import { readPhisSiteAccessHolder } from "@/lib/addons/site-access";
import { buildPhisAddonUsersCapability } from "@/lib/addons/users-capability";
import { PHIS_SITE_ADDRESS_FLAG_HANDED_OUT, PhisUsersAccessRoad } from "@/lib/constants/users";

/**
 * users:v1 against the database (SERVER_ADDONS.md, users:v1): the roads by the people's real Site
 * accesses, the background grant, the address book's versions and defaults, the access log and its
 * retention, and the user events written into the outbox.
 */

const READER = "@pgtest/users-reader";
const DEAF = "@pgtest/users-deaf";
const ALL: PhisUserField[] = ["name", "email", "phone", "address"];
const HOME = { companyName: null, name: "Ada Lovelace", line1: "12 St James's Square", line2: null, postalCode: "SW1Y 4JH", city: "London", region: null, country: "GB" };

describe.skipIf(process.env.PHIS_PG_TEST !== "1")("users:v1", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let accountant: number;
  let supporter: number;
  let author: number;
  let ada: number;
  let subject: string;

  const capability = (actorUserId: number | null, options: { background?: boolean; backgroundFields?: PhisUserField[]; on?: PhiTestSite } = {}) =>
    buildPhisAddonUsersCapability({
      addonId: READER,
      siteId: (options.on ?? site).id,
      actorUserId,
      access: { fields: ALL, background: options.backgroundFields ?? ["name", "address"] },
      readSiteAccess: async () => (actorUserId == null ? () => false : readPhisSiteAccessHolder((options.on ?? site).id, actorUserId)),
      background: options.background === true,
    });

  async function staff(roleFlags: number) {
    const pool = await requirePhiTestDatabase();
    const userId = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.user_site_role_claims (site_id, user_id, provider_id, role_flags) VALUES ($1, $2, '@phis/server/core', $3)`,
      [site.id, userId, roleFlags],
    );
    return userId;
  }

  async function logOf(target: PhiTestSite) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ actor_user_id: number | null; road: number; operation: number; subjects: string[]; address_ids: number[]; fields: number }>(
      `SELECT actor_user_id, road, operation, subjects, address_ids, fields FROM phis.users_access_log WHERE site_id = $1 ORDER BY id`,
      [target.id],
    );
    return rows;
  }

  async function outbox(target: PhiTestSite) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ addon_id: string; event: string; subject_kind: string; payload: Record<string, unknown> }>(
      `SELECT addon_id, event, subject_kind, payload FROM phis.addon_event_outbox WHERE site_id = $1 AND subject_kind = 'user' ORDER BY id`,
      [target.id],
    );
    return rows;
  }

  async function clear() {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = ANY($1::smallint[])`, [[site.id, other.id]]);
    await pool.query(`DELETE FROM phis.users_access_log WHERE site_id = ANY($1::smallint[])`, [[site.id, other.id]]);
  }

  beforeAll(async () => {
    const pool = await requirePhiTestDatabase();
    installed.entries = {
      [READER]: { flags: 1, manifest: { addonId: READER, capabilities: [], requiredCoreCapabilities: [PHIS_CORE_CAPABILITIES.users],
        eventHandlers: [{ id: "r", event: "user.registered", handler: "r" }, { id: "c", event: "user.changed", handler: "c" }], jobs: [] } },
      // Listens, and may not read people: hears nothing.
      [DEAF]: { flags: 1, manifest: { addonId: DEAF, capabilities: [], requiredCoreCapabilities: [],
        eventHandlers: [{ id: "r", event: "user.registered", handler: "r" }], jobs: [] } },
    };
    site = await createPhiTestSite("users");
    other = await createPhiTestSite("users-other");
    for (const target of [site, other]) {
      await enablePhiTestAddonForSite(target, READER);
      await enablePhiTestAddonForSite(target, DEAF);
    }
    accountant = await staff(PhiBaseRole.Accountant);
    supporter = await staff(PhiBaseRole.Supporter);
    author = await staff(PhiBaseRole.Author);
    ada = await createPhiTestUser(site);
    await pool.query(
      `INSERT INTO phis.user_profiles (user_id, first_name, last_name, company_name, phone, mobile) VALUES ($1, 'Ada', 'Lovelace', 'Analytical', '+44 20 7946 0000', NULL)`,
      [ada],
    );
    subject = await ensureEntitlementSubject(pool, site.id, ada);
  });

  beforeEach(clear);

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("describe", () => {
    it("answers by the acting person's road, field by field, and logs what it carried", async () => {
      const [bySupport] = await capability(supporter).describe({ subjects: [subject], fields: ALL });
      expect(bySupport).toEqual({
        subject,
        name: { firstName: "Ada", lastName: "Lovelace", displayName: null, companyName: "Analytical" },
        email: expect.stringContaining("@example.invalid"),
        phone: { phone: "+44 20 7946 0000", mobile: null },
      });
      const [byAccounting] = await capability(accountant).describe({ subjects: [subject], fields: ["address"] });
      expect(byAccounting).toEqual({ subject, addresses: [] });
      expect(await capability(author).describe({ subjects: [subject], fields: ALL })).toEqual([{ subject }]);
      expect(await logOf(site)).toEqual([
        { actor_user_id: supporter, road: PhisUsersAccessRoad.Staff, operation: 1, subjects: [subject], address_ids: [], fields: 7 },
        { actor_user_id: accountant, road: PhisUsersAccessRoad.Staff, operation: 1, subjects: [subject], address_ids: [], fields: 8 },
      ]);
    });

    it("answers the person their own, in the order asked, and the bare subject for anybody who is no member here", async () => {
      const pool = await requirePhiTestDatabase();
      const foreign = await ensureEntitlementSubject(pool, other.id, await createPhiTestUser(other));
      const left = await createPhiTestUser(site);
      const leftSubject = await ensureEntitlementSubject(pool, site.id, left);
      await pool.query(`DELETE FROM phis.user_site_memberships WHERE user_id = $1 AND site_id = $2`, [left, site.id]);

      const answers = await capability(ada).describe({ subjects: [foreign, subject, "sub_000000000000000000000000", leftSubject, subject], fields: ["email"] });
      expect(answers.map((answer) => Object.keys(answer))).toEqual([["subject"], ["subject", "email"], ["subject"], ["subject"], ["subject", "email"]]);
      expect(answers[0]).toEqual({ subject: foreign });
      expect((await logOf(site)).map((row) => [row.road, row.subjects])).toEqual([[PhisUsersAccessRoad.Self, [subject]]]);
    });

    it("answers a job only what this Site granted and the manifest still asks, until the grant is withdrawn", async () => {
      const pool = await requirePhiTestDatabase();
      const job = (backgroundFields?: PhisUserField[]) => capability(null, { background: true, backgroundFields });
      expect(await job().describe({ subjects: [subject], fields: ALL })).toEqual([{ subject }]);

      await grantPhisAddonUsersBackground(pool, { siteId: site.id, addonId: READER, fields: 1 | 2, grantedByUserId: null });
      // Granted name and email; the manifest asks name and address: name alone counts.
      const [granted] = await job().describe({ subjects: [subject], fields: ALL });
      expect(Object.keys(granted!)).toEqual(["subject", "name"]);
      // A request nobody signed in to is no background road, whatever the Site granted.
      expect(await capability(null).describe({ subjects: [subject], fields: ALL })).toEqual([{ subject }]);
      // The grant is this Site's.
      expect(await capability(null, { background: true, on: other }).describe({ subjects: [subject], fields: ALL })).toEqual([{ subject }]);
      expect((await logOf(site)).map((row) => [row.actor_user_id, row.road, row.fields])).toEqual([[null, PhisUsersAccessRoad.Background, 1]]);

      expect(await revokePhisAddonUsersBackground(pool, { siteId: site.id, addonId: READER })).toBe(true);
      expect(await job().describe({ subjects: [subject], fields: ALL })).toEqual([{ subject }]);
    });
  });

  describe("the address book", () => {
    async function rowOf(id: number) {
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ flags: number; replaces_id: number | null }>(`SELECT flags, replaces_id FROM phis.site_addresses WHERE id = $1`, [id]);
      return rows[0] ?? null;
    }

    it("writes a person's address once, moves a default, and answers an equal one instead of a second", async () => {
      const person = await createPhiTestUser(site);
      const pool = await requirePhiTestDatabase();
      const own = await ensureEntitlementSubject(pool, site.id, person);
      const asPerson = capability(person);
      const first = await asPerson.createAddress({ subject: own, address: HOME, flags: PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.DefaultBilling });
      expect(first).toMatchObject({ subject: own, flags: 5, country: "GB", replacesId: null });
      const office = await asPerson.createAddress({
        subject: own, address: { ...HOME, line1: "1 Office Road" }, flags: PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.DefaultBilling,
      });
      expect((await rowOf(first.id))!.flags & 0xffff).toBe(PhisSiteAddressFlags.Billing);
      expect(office.flags).toBe(5);

      // Equal in every part, as text with spaces around: the same address, now for shipping too.
      const again = await asPerson.createAddress({
        subject: own, address: { ...HOME, name: "  Ada Lovelace " }, flags: PhisSiteAddressFlags.Shipping | PhisSiteAddressFlags.DefaultShipping,
      });
      expect(again.id).toBe(first.id);
      expect(again.flags).toBe(PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Shipping | PhisSiteAddressFlags.DefaultShipping);
      const { rows } = await pool.query(`SELECT 1 FROM phis.site_addresses WHERE site_id = $1 AND user_id = $2`, [site.id, person]);
      expect(rows).toHaveLength(2);
      // Two at once take turns and still write one.
      const [left, right] = await Promise.all([
        asPerson.createAddress({ subject: own, address: { ...HOME, city: "Bath" }, flags: 1 }),
        asPerson.createAddress({ subject: own, address: { ...HOME, city: "Bath" }, flags: 1 }),
      ]);
      expect(left.id).toBe(right.id);
      expect((await rowOf(left.id))!.flags & PHIS_SITE_ADDRESS_FLAG_HANDED_OUT).not.toBe(0);
    });

    it("supersedes the version a change follows, owes user.changed for it, and keeps it for addresses by id", async () => {
      const person = await createPhiTestUser(site);
      const pool = await requirePhiTestDatabase();
      const own = await ensureEntitlementSubject(pool, site.id, person);
      const first = await capability(person).createAddress({ subject: own, address: HOME, flags: 1 | 4 });
      await clear();
      // Accounting changes it on the person's behalf.
      const moved = await capability(accountant).createAddress({ subject: own, address: { ...HOME, line1: "13 St James's Square" }, flags: 1 | 4, replaces: first.id });
      expect(moved.replacesId).toBe(first.id);
      expect((await rowOf(first.id))!.flags & 0xffff).toBe(PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Superseded);
      expect(await outbox(site)).toEqual([
        { addon_id: READER, event: "user.changed", subject_kind: "user", payload: { subject: own, fields: ["address"] } },
      ]);
      await expect(capability(person).createAddress({ subject: own, address: HOME, flags: 1, replaces: first.id }))
        .rejects.toThrow(/no current address/u);

      const [described] = await capability(accountant).describe({ subjects: [own], fields: ["address"] });
      expect(described!.addresses!.map((address) => address.id)).toEqual([moved.id]);
      expect((await capability(accountant).addresses({ ids: [moved.id, first.id, moved.id] })).map((address) => [address.id, address.flags]))
        .toEqual([[moved.id, 5], [first.id, 17]]);
      // The person reads their own by id; Support reads none; another Site's id is absent.
      expect((await capability(person).addresses({ ids: [first.id] })).map((address) => address.id)).toEqual([first.id]);
      expect(await capability(ada).addresses({ ids: [first.id] })).toEqual([]);
      expect(await capability(accountant, { on: other }).addresses({ ids: [first.id] })).toEqual([]);
      expect((await logOf(site)).map((row) => [row.operation, row.road, row.address_ids])).toEqual([
        [3, PhisUsersAccessRoad.Staff, [moved.id]],
        [1, PhisUsersAccessRoad.Staff, [moved.id]],
        [2, PhisUsersAccessRoad.Staff, [moved.id, first.id]],
        [2, PhisUsersAccessRoad.Self, [first.id]],
      ]);
    });

    it("writes a guest's address without an account, and refuses somebody else's to a person who is not accounting", async () => {
      const guest = await capability(null).createAddress({ subject: null, address: HOME, flags: PhisSiteAddressFlags.Shipping });
      expect(guest).toMatchObject({ subject: null, flags: 2 });
      const second = await capability(null).createAddress({ subject: null, address: HOME, flags: PhisSiteAddressFlags.Shipping });
      expect(second.id).not.toBe(guest.id);
      expect((await logOf(site)).map((row) => [row.actor_user_id, row.road, row.subjects])).toEqual([
        [null, PhisUsersAccessRoad.Checkout, []],
        [null, PhisUsersAccessRoad.Checkout, []],
      ]);
      await expect(capability(supporter).createAddress({ subject, address: HOME, flags: 1 })).rejects.toThrow(/accounting/u);
      await expect(capability(null).createAddress({ subject, address: HOME, flags: 1 })).rejects.toThrow(/accounting/u);
    });

    it("removes an address: deleted where it was never handed out, kept as Removed where it was, with its earlier versions", async () => {
      const person = await createPhiTestUser(site);
      const pool = await requirePhiTestDatabase();
      const own = await ensureEntitlementSubject(pool, site.id, person);
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO phis.site_addresses (site_id, user_id, flags, name, line1, city, country) VALUES ($1, $2, 3, 'Ada', 'Never shown', 'London', 'GB') RETURNING id`,
        [site.id, person],
      );
      const unshown = rows[0]!.id;
      const handed = await capability(person).createAddress({ subject: own, address: HOME, flags: 1 | 4 });
      const newer = await capability(person).createAddress({ subject: own, address: { ...HOME, city: "Bath" }, flags: 1 | 4, replaces: handed.id });
      await clear();

      expect(await removePhisSiteAddress({ siteId: site.id, userId: person, addressId: unshown })).toBe("deleted");
      expect(await rowOf(unshown)).toBeNull();
      expect(await removePhisSiteAddress({ siteId: site.id, userId: person, addressId: handed.id })).toBeNull();
      expect(await removePhisSiteAddress({ siteId: site.id, userId: ada, addressId: newer.id })).toBeNull();
      expect(await removePhisSiteAddress({ siteId: site.id, userId: person, addressId: newer.id })).toBe("removed");
      expect((await rowOf(newer.id))!.flags & 0xffff).toBe(PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Removed);
      expect((await rowOf(handed.id))!.flags & 0xffff).toBe(PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.Superseded | PhisSiteAddressFlags.Removed);
      expect(await outbox(site)).toHaveLength(2);
      const [described] = await capability(person).describe({ subjects: [own], fields: ["address"] });
      expect(described!.addresses).toEqual([]);
    });
  });

  it("keeps what a person writes in their account off the handed-out mark, so removing it deletes it", async () => {
    const person = await createPhiTestUser(site);
    const written = await createPhisSiteAddress({ siteId: site.id, userId: person, address: HOME, flags: 1, replaces: null, handedOut: false });
    const pool = await requirePhiTestDatabase();
    // The subject is issued with the first address, so an Add-on reading it later sees whose it is.
    expect(written.subject).toBe(await ensureEntitlementSubject(pool, site.id, person));
    expect((await readPhisCurrentSiteAddresses(site.id, [person], { handedOut: false })).get(person)!.map((row) => row.id)).toEqual([written.id]);
    const { rows } = await pool.query<{ flags: number }>(`SELECT flags FROM phis.site_addresses WHERE id = $1`, [written.id]);
    expect(rows[0]!.flags & PHIS_SITE_ADDRESS_FLAG_HANDED_OUT).toBe(0);
    expect(await removePhisSiteAddress({ siteId: site.id, userId: person, addressId: written.id })).toBe("deleted");
  });

  describe("a person's file in the background", () => {
    const job = (backgroundFields: PhisUserField[]) => buildPhisAddonThreadsCapability({
      addonId: READER,
      siteId: site.id,
      actorUserId: null,
      readSiteAccess: async () => () => false,
      background: true,
      usersBackground: backgroundFields,
    });

    it("is handed out and reached for get and reply while the Site grants name, and logged on the background road", async () => {
      const pool = await requirePhiTestDatabase();
      const person = await createPhiTestUser(site);
      const own = await ensureEntitlementSubject(pool, site.id, person);
      await expect(job(["name"]).fileOf({ subject: own })).rejects.toThrow(/background grant/u);

      await grantPhisAddonUsersBackground(pool, { siteId: site.id, addonId: READER, fields: 2, grantedByUserId: null });
      await expect(job(["name", "email"]).fileOf({ subject: own })).rejects.toThrow(/background grant/u);
      await grantPhisAddonUsersBackground(pool, { siteId: site.id, addonId: READER, fields: 1, grantedByUserId: null });
      // Granted, and no longer asked in the manifest: nothing.
      await expect(job(["address"]).fileOf({ subject: own })).rejects.toThrow(/background grant/u);
      // A request nobody signed in to never stands on the background road.
      await expect(buildPhisAddonThreadsCapability({
        addonId: READER, siteId: site.id, actorUserId: null, readSiteAccess: async () => () => false, usersBackground: ["name"],
      }).fileOf({ subject: own })).rejects.toThrow(/background grant/u);

      const file = (await job(["name"]).fileOf({ subject: own }))!;
      expect(file.threadId).toBeGreaterThan(0);
      expect(await job(["name"]).fileOf({ subject: "sub_000000000000000000000000" })).toBeNull();
      expect((await logOf(site)).map((row) => [row.actor_user_id, row.road, row.operation, row.subjects, row.fields]))
        .toEqual([[null, PhisUsersAccessRoad.Background, 4, [own], 1]]);

      const reply = { threadId: file.threadId, message: "Order 7 paid.", externalRef: "order-7-paid" };
      expect(await job(["name"]).reply(reply)).not.toBeNull();
      await job(["name"]).reply(reply);
      expect((await job(["name"]).get(file.threadId))?.thread.id).toBe(file.threadId);
      // The message is Internal, so the Add-on is never handed it back; Staff read it once.
      const asStaff = await getThreadDetail(site.id, { kind: "user", userId: accountant }, file.threadId);
      expect(asStaff?.messages.map((message) => message.bodyText)).toEqual(["Order 7 paid."]);
      // Nothing but get and reply reaches it: no reader without the grant's reach, and none once it is withdrawn.
      expect(await addThreadMessage({ siteId: site.id, threadId: file.threadId, reader: { kind: "provider", providerId: READER }, message: "x" })).toBeNull();
      await revokePhisAddonUsersBackground(pool, { siteId: site.id, addonId: READER });
      expect(await job(["name"]).get(file.threadId)).toBeNull();
      expect(await job(["name"]).reply({ ...reply, externalRef: "order-8" })).toBeNull();
    });
  });

  it("reads the access log a page at a time, newest first, by subject and Add-on, and keeps the retention per Site", async () => {
    await capability(supporter).describe({ subjects: [subject], fields: ["name"] });
    await capability(accountant).describe({ subjects: [subject], fields: ["address"] });
    const all = await listPhisUsersAccessLog({ siteId: site.id, subject: null, addonId: null, page: 1, pageSize: 10 });
    expect(all.map((entry) => [entry.actor?.userId, entry.fields])).toEqual([[accountant, 8], [supporter, 1]]);
    expect(all[0]!.actor!.displayName).toBe(`#${accountant}`);
    expect(await listPhisUsersAccessLog({ siteId: site.id, subject: "sub_none", addonId: null, page: 1, pageSize: 10 })).toEqual([]);
    expect(await listPhisUsersAccessLog({ siteId: site.id, subject, addonId: DEAF, page: 1, pageSize: 10 })).toEqual([]);
    expect(await listPhisUsersAccessLog({ siteId: site.id, subject, addonId: READER, page: 2, pageSize: 1 })).toHaveLength(1);
    expect(await listPhisUsersAccessLog({ siteId: other.id, subject: null, addonId: null, page: 1, pageSize: 10 })).toEqual([]);

    await setPhisUsersAccessLogDays(other.id, 400);
    expect(await readPhisUsersAccessLogDays(other.id)).toBe(400);
    expect(await readPhisUsersAccessLogDays(site.id)).not.toBe(400);
    await setPhisUsersAccessLogDays(other.id, 90);
  });

  it("answers Staff's customer file by the staff road, opens the file, lists the shared threads and logs the read", async () => {
    const pool = await requirePhiTestDatabase();
    const person = await createPhiTestUser(site);
    await upsertUserProfile({ userId: person, firstName: "Mary", lastName: "Somerville" });
    await createPhisSiteAddress({ siteId: site.id, userId: person, address: HOME, flags: 1, replaces: null, handedOut: false });
    const own = await ensureEntitlementSubject(pool, site.id, person);
    const read = async (actor: number) => readPhisCustomerFile({
      siteId: site.id, actorUserId: actor, holds: await readPhisSiteAccessHolder(site.id, actor), userId: person, page: 1, pageSize: 25,
    });

    const bySupport = (await read(supporter))!;
    expect(bySupport.person).toEqual({
      userId: person, displayName: "Mary Somerville",
      name: { firstName: "Mary", lastName: "Somerville", displayName: null, companyName: null },
      email: expect.stringContaining("@example.invalid"), phone: { phone: null, mobile: null },
    });
    const byAccounting = (await read(accountant))!;
    expect(byAccounting.person.addresses).toHaveLength(1);
    expect(byAccounting.fileThreadId).toBe(bySupport.fileThreadId);
    expect(byAccounting.threads).toEqual([]);
    expect(await read(author)).toBeNull();
    expect(await readPhisCustomerFile({
      siteId: site.id, actorUserId: accountant, holds: await readPhisSiteAccessHolder(site.id, accountant), userId: 2_000_000_000, page: 1, pageSize: 25,
    })).toBeNull();
    expect((await logOf(site)).map((row) => [row.actor_user_id, row.road, row.operation, row.subjects, row.fields]))
      .toEqual([[supporter, PhisUsersAccessRoad.Staff, 5, [own], 7], [accountant, PhisUsersAccessRoad.Staff, 5, [own], 15]]);
  });

  describe("the user events", () => {
    it("owes user.registered to the Add-ons that read people and listen, on the Site joined", async () => {
      const pool = await requirePhiTestDatabase();
      const { rows } = await pool.query<{ id: number }>(`INSERT INTO phis.user_accounts DEFAULT VALUES RETURNING id`);
      const person = rows[0]!.id;
      await upsertUserSiteMembership({ userId: person, siteId: site.id });
      await upsertUserSiteMembership({ userId: person, siteId: site.id });
      await recordUserSiteLogin(person, other.id);
      await recordUserSiteLogin(person, other.id);
      const issued = await ensureEntitlementSubject(pool, site.id, person);
      expect(await outbox(site)).toEqual([{ addon_id: READER, event: "user.registered", subject_kind: "user", payload: { subject: issued } }]);
      expect((await outbox(other)).map((row) => row.event)).toEqual(["user.registered"]);
      await pool.query(`DELETE FROM phis.user_accounts WHERE id = $1`, [person]);
    });

    it("owes user.changed with the groups that changed, never their values, on every Site of the person", async () => {
      const pool = await requirePhiTestDatabase();
      const person = await createPhiTestUser(site);
      await pool.query(`INSERT INTO phis.user_site_memberships (user_id, site_id) VALUES ($1, $2)`, [person, other.id]);
      await upsertUserProfile({ userId: person, firstName: "Grace", lastName: "Hopper" });
      // The same names again change nothing.
      await upsertUserProfile({ userId: person, firstName: "Grace", lastName: "Hopper" });
      expect(await setUserProfilePhones({ userId: person, phone: "+1 555 0100", mobile: null })).toBe(true);
      await setUserProfilePhones({ userId: person, phone: "+1 555 0100", mobile: null });
      await updateUserAccountProfileFields(person, { email: `pgtest-users-${person}@example.invalid`, emailSource: PhiUserEmailSource.Operator });
      const fields = (await outbox(site)).map((row) => row.payload.fields);
      expect(fields).toEqual([["name"], ["phone"], ["email"]]);
      expect((await outbox(other)).map((row) => row.payload.fields)).toEqual([["name"], ["phone"], ["email"]]);
      const { rows } = await pool.query(`SELECT phone_digits FROM phis.user_profiles WHERE user_id = $1`, [person]);
      expect(rows[0]).toEqual({ phone_digits: "15550100" });
    });
  });

  it("forgets the access log past each Site's retention", async () => {
    const pool = await requirePhiTestDatabase();
    await pool.query(`UPDATE phis.sites SET users_access_log_days = 30 WHERE id = $1`, [site.id]);
    for (const [target, days] of [[site, 31], [site, 29], [other, 31], [other, 91]] as const) {
      await pool.query(
        `INSERT INTO phis.users_access_log (site_id, addon_id, road, operation, fields, created_at)
         VALUES ($1, $2, 1, 1, 1, NOW() - make_interval(days => $3::int))`,
        [target.id, READER, days],
      );
    }
    expect((await forgetExpiredPhisUsersAccessLog(pool, { dryRun: true })).cleared).toBe(0);
    await forgetExpiredPhisUsersAccessLog(pool);
    expect((await logOf(site))).toHaveLength(1);
    expect((await logOf(other))).toHaveLength(1);
  });
});
