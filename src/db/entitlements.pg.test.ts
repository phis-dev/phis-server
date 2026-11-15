import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import { PhisEntitlementFlag, type PhisEntitlementKindId } from "@phis/contracts/entitlements";

import {
  activatePhiTestAddonForSite,
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  enablePhiTestAddonForSite,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  allowEntitlementSource,
  announceEndedEntitlements,
  disallowEntitlementSource,
  ensureEntitlementSubject,
  findEntitlementSubject,
  grantEntitlement,
  isEntitlementSourceAllowed,
  listEntitlementKindSources,
  listEntitlements,
  readEntitlementState,
  updateEntitlement,
} from "./entitlements.mts";

const configured = process.env.PHIS_PG_TEST === "1";

const LICENSE = "@pgtest/licenses:pro" as PhisEntitlementKindId;
const SEATS = "@pgtest/licenses:seats" as PhisEntitlementKindId;
const SHOP = "@pgtest/shop";
const OTHER = "@pgtest/other";
const READY_A = "@pgtest/listener-a";
const READY_B = "@pgtest/listener-b";
const NOT_READY = "@pgtest/listener-idle";

const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString();

/**
 * Who is entitled to what, and the one change nobody writes: an ending. The cases that would break if
 * validity were stored instead of derived, or if a payment handler delivered twice entitled twice.
 * See design/ENTITLEMENTS.md.
 */
describe.skipIf(!configured)("entitlements", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let userId: number;
  let subject: string;
  let subjectId: number;
  let seq = 0;

  const listeners = [READY_A, READY_B, NOT_READY];
  const ref = (label: string) => `${label}-${(seq += 1)}`;

  async function grant(input: {
    kind?: PhisEntitlementKindId; source?: string; reference?: string;
    startsAt?: string | null; endsAt?: string | null; quantity?: number | null; recipients?: readonly string[];
  } = {}) {
    return grantEntitlement(pool, {
      siteId: site.id, subjectId, kind: input.kind ?? LICENSE, source: input.source ?? SHOP,
      reference: input.reference ?? ref("order"), startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null, quantity: input.quantity ?? null, listeners: input.recipients ?? [],
    });
  }

  const stateOf = (kind: PhisEntitlementKindId, counted = false) =>
    readEntitlementState(pool, { siteId: site.id, subjectId, kind, counted });

  async function outbox() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ addon_id: string; subject_kind: string; payload: { subject: string; entitlementKind: string } }>(
      `SELECT addon_id, subject_kind, payload FROM phis.addon_event_outbox
       WHERE site_id = $1 AND event = 'entitlement.changed' ORDER BY id`,
      [site.id],
    );
    return rows;
  }

  async function clearOutbox() {
    const pool = await requirePhiTestDatabase();
    await pool.query(`DELETE FROM phis.addon_event_outbox WHERE site_id = $1`, [site.id]);
  }

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    site = await createPhiTestSite("entitlements");
    userId = await createPhiTestUser(site);
    subject = await ensureEntitlementSubject(pool, site.id, userId);
    subjectId = (await findEntitlementSubject(pool, site.id, subject))!.id;
    await enablePhiTestAddonForSite(site, READY_A);
    await enablePhiTestAddonForSite(site, READY_B);
    await activatePhiTestAddonForSite(site, NOT_READY);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("issues one subject per user and Site, and a different one on another Site", async () => {
    expect(subject).toMatch(/^sub_[a-z0-9]{24}$/);
    expect(await ensureEntitlementSubject(pool, site.id, userId)).toBe(subject);
    const second = await createPhiTestSite("entitlements-b");
    const elsewhere = await ensureEntitlementSubject(pool, second.id, userId);
    expect(elsewhere).not.toBe(subject);
    // A reference of another Site is nobody here.
    expect(await findEntitlementSubject(pool, site.id, elsewhere)).toBeNull();
    expect(await findEntitlementSubject(pool, second.id, subject)).toBeNull();
    expect(await findEntitlementSubject(pool, site.id, subject)).toEqual({ id: subjectId, userId });
  });

  it("grants idempotently and writes one outbox row per ready listener on the first call only", async () => {
    await clearOutbox();
    const reference = ref("idem");
    const first = await grant({ reference, recipients: listeners });
    expect(first).toMatchObject({ kind: LICENSE, subject, source: SHOP, reference, valid: true, flags: 0, quantity: null });
    const rows = await outbox();
    expect(rows.map((row) => row.addon_id).sort()).toEqual([READY_A, READY_B]);
    expect(rows[0]).toMatchObject({ subject_kind: "entitlement", payload: { subject, entitlementKind: LICENSE } });

    const second = await grant({ reference, endsAt: hours(5), recipients: listeners });
    expect(second.id).toBe(first.id);
    // The second call changes nothing, not even what it was asked to change.
    expect(second.endsAt).toBeNull();
    expect(await outbox()).toHaveLength(2);
    expect((await listEntitlements(pool, { siteId: site.id, subjectId, kind: LICENSE })).filter((e) => e.reference === reference)).toHaveLength(1);
  });

  it("adds up the valid entries of a counted kind", async () => {
    await grant({ kind: SEATS, quantity: 3 });
    await grant({ kind: SEATS, quantity: 4, endsAt: hours(2) });
    expect(await stateOf(SEATS, true)).toMatchObject({ entitled: true, quantity: 7 });
    // An uncounted reading of the same entries carries no quantity.
    expect(await stateOf(SEATS, false)).toMatchObject({ entitled: true, quantity: null });
  });

  it("does not count a suspended or revoked entry, and does not let an update revive a revoked one", async () => {
    const kind = "@pgtest/licenses:suspend" as PhisEntitlementKindId;
    const reference = ref("susp");
    await grant({ kind, reference });
    expect((await stateOf(kind)).entitled).toBe(true);

    const suspended = await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference, suspended: true, listeners: [] });
    expect(suspended).toMatchObject({ valid: false, flags: PhisEntitlementFlag.Suspended });
    expect((await stateOf(kind)).entitled).toBe(false);

    const resumed = await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference, suspended: false, listeners: [] });
    expect(resumed).toMatchObject({ valid: true, flags: 0 });

    const revoked = await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference, revoke: true, listeners: [] });
    expect(revoked).toMatchObject({ valid: false, flags: PhisEntitlementFlag.Revoked });
    expect((await stateOf(kind)).entitled).toBe(false);

    // Over for good: neither a resume nor a new end brings it back, and the answer is "not found".
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference, suspended: false, listeners: [] })).toBeNull();
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference, endsAt: null, listeners: [] })).toBeNull();
    expect((await stateOf(kind)).entitled).toBe(false);
    const [entry] = await listEntitlements(pool, { siteId: site.id, subjectId, kind });
    expect(entry!.flags & PhisEntitlementFlag.Revoked).toBe(PhisEntitlementFlag.Revoked);
  });

  it("does not count an entry that has ended or not yet started", async () => {
    const kind = "@pgtest/licenses:timed" as PhisEntitlementKindId;
    await grant({ kind, startsAt: hours(-3), endsAt: hours(-1) });
    expect(await stateOf(kind)).toEqual({ kind, entitled: false, quantity: null, until: null });
    await grant({ kind, startsAt: hours(1), endsAt: hours(2) });
    expect((await stateOf(kind)).entitled).toBe(false);
  });

  it("answers until as the latest end, and null while one valid entry has none", async () => {
    const kind = "@pgtest/licenses:until" as PhisEntitlementKindId;
    const early = hours(2);
    const late = hours(6);
    await grant({ kind, endsAt: early });
    await grant({ kind, endsAt: late });
    expect(await stateOf(kind)).toMatchObject({ entitled: true, until: late });
    await grant({ kind });
    expect(await stateOf(kind)).toMatchObject({ entitled: true, until: null });
  });

  it("does not find another source's entry to change or take back", async () => {
    const kind = "@pgtest/licenses:own" as PhisEntitlementKindId;
    const reference = ref("own");
    await grant({ kind, reference, source: SHOP });
    expect(await updateEntitlement(pool, { siteId: site.id, source: OTHER, kind, reference, suspended: true, listeners: [] })).toBeNull();
    expect(await updateEntitlement(pool, { siteId: site.id, source: OTHER, kind, reference, revoke: true, listeners: [] })).toBeNull();
    expect((await stateOf(kind)).entitled).toBe(true);
    // The same reference of another source is its own entry.
    const mine = await grant({ kind, reference, source: OTHER });
    expect(mine.source).toBe(OTHER);
    expect(await listEntitlements(pool, { siteId: site.id, subjectId, kind })).toHaveLength(2);
  });

  it("announces each ended entry once, and once per subject and kind", async () => {
    const kind = "@pgtest/licenses:ending" as PhisEntitlementKindId;
    const pool = await requirePhiTestDatabase();
    await clearOutbox();
    await grant({ kind, startsAt: hours(-4), endsAt: hours(-3) });
    await grant({ kind, startsAt: hours(-4), endsAt: hours(-2) });
    // A revoked entry that ended is not news, and neither is one still running.
    const revokedRef = ref("revoked-ended");
    await grant({ kind, startsAt: hours(-4), endsAt: hours(-1), reference: revokedRef });
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference: revokedRef, revoke: true, listeners: [] });
    await grant({ kind, endsAt: hours(5) });

    const sites = await announceEndedEntitlements(pool, [READY_A, READY_B, NOT_READY]);
    expect(sites).toContain(site.id);
    const rows = (await outbox()).filter((row) => row.payload.entitlementKind === kind);
    expect(rows.map((row) => row.addon_id).sort()).toEqual([READY_A, READY_B]);
    expect(rows.every((row) => row.payload.subject === subject)).toBe(true);

    const { rows: marked } = await pool.query<{ ended_event_at: Date | null; flags: number }>(
      `SELECT ended_event_at, flags FROM phis.entitlements WHERE site_id = $1 AND kind = $2`, [site.id, kind],
    );
    expect(marked.filter((row) => row.ended_event_at !== null)).toHaveLength(2);

    // Nothing is owed the second time.
    await clearOutbox();
    expect(await announceEndedEntitlements(pool, [READY_A, READY_B])).not.toContain(site.id);
    expect(await outbox()).toHaveLength(0);

    // A moved ending is owed its event again.
    const moved = (await listEntitlements(pool, { siteId: site.id, subjectId, kind })).find((entry) => !entry.valid && entry.flags === 0)!;
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, kind, reference: moved.reference, endsAt: hours(-0.5), listeners: [] });
    expect(await announceEndedEntitlements(pool, [READY_A])).toContain(site.id);
    expect((await outbox()).filter((row) => row.addon_id === READY_A)).toHaveLength(1);
  });

  it("allows, lists and takes back a source for a kind", async () => {
    expect(await isEntitlementSourceAllowed(pool, site.id, LICENSE, SHOP)).toBe(false);
    expect(await allowEntitlementSource(pool, { siteId: site.id, kind: LICENSE, source: SHOP, grantedByUserId: null })).toBe(true);
    // Saying it twice changes nothing.
    expect(await allowEntitlementSource(pool, { siteId: site.id, kind: LICENSE, source: SHOP, grantedByUserId: userId })).toBe(false);
    await allowEntitlementSource(pool, { siteId: site.id, kind: SEATS, source: OTHER, grantedByUserId: userId });
    expect(await isEntitlementSourceAllowed(pool, site.id, LICENSE, SHOP)).toBe(true);
    expect(await isEntitlementSourceAllowed(pool, site.id, LICENSE, OTHER)).toBe(false);

    const listed = await listEntitlementKindSources(pool, site.id);
    expect(listed.map((row) => `${row.kind}|${row.source}`)).toEqual([`${LICENSE}|${SHOP}`, `${SEATS}|${OTHER}`]);
    expect(listed[0]).toMatchObject({ grantedByUserId: null });
    expect(listed[1]).toMatchObject({ grantedByUserId: userId });

    expect(await disallowEntitlementSource(pool, { siteId: site.id, kind: LICENSE, source: SHOP })).toBe(true);
    expect(await disallowEntitlementSource(pool, { siteId: site.id, kind: LICENSE, source: SHOP })).toBe(false);
    expect(await isEntitlementSourceAllowed(pool, site.id, LICENSE, SHOP)).toBe(false);
    // The entries the source wrote stay.
    expect((await listEntitlements(pool, { siteId: site.id, subjectId, kind: LICENSE })).some((entry) => entry.source === SHOP)).toBe(true);
  });
});
