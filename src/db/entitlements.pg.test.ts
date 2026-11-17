import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import { PhisEntitlementFlag } from "@phis/contracts/entitlements";
import type { PhisProductId } from "@phis/contracts/products";

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
  listEntitlementSources,
  listEntitlements,
  readEntitlementState,
  updateEntitlement,
} from "./entitlements.mts";
import { moveProductsAsOperator, registerProduct, setProductState } from "./products.mts";
import { normalizePhisProductDraft } from "../lib/addons/product-draft.ts";

const configured = process.env.PHIS_PG_TEST === "1";

const SUPPLIER = "@pgtest/licenses";
const LICENSE = "@pgtest/licenses:pro" as PhisProductId;
const SEATS = "@pgtest/licenses:seats" as PhisProductId;
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
    counted?: boolean; product?: PhisProductId; source?: string; reference?: string;
    startsAt?: string | null; endsAt?: string | null; quantity?: number | null; recipients?: readonly string[];
  } = {}) {
    return (await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: input.product ?? LICENSE, source: input.source ?? SHOP,
      reference: input.reference ?? ref("order"), startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null, quantity: input.quantity ?? null, counted: input.counted ?? false, listeners: input.recipients ?? [],
    }))!;
  }

  /** A product of the Site, active unless said otherwise, which is what an entry needs to count. */
  async function product(id: PhisProductId, input: { counted?: boolean; state?: "draft" | "active" | "withdrawn" } = {}) {
    const key = id.slice(id.lastIndexOf(":") + 1);
    await registerProduct(pool, {
      siteId: site.id, supplier: SUPPLIER, listeners: [],
      draft: normalizePhisProductDraft({ key, type: "licence", title: key, summary: "", counted: input.counted === true }),
    });
    await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key, state: input.state ?? "active", listeners: [] });
    return id;
  }

  const stateOf = (product: PhisProductId) => readEntitlementState(pool, { siteId: site.id, subjectId, product });

  async function outbox() {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ addon_id: string; subject_kind: string; payload: { subject: string; product: string } }>(
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
    await product(LICENSE);
    await product(SEATS, { counted: true });
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
    expect(first).toMatchObject({ product: LICENSE, subject, source: SHOP, reference, valid: true, flags: 0, quantity: null });
    const rows = await outbox();
    expect(rows.map((row) => row.addon_id).sort()).toEqual([READY_A, READY_B]);
    expect(rows[0]).toMatchObject({ subject_kind: "entitlement", payload: { subject, product: LICENSE } });

    const second = await grant({ reference, endsAt: hours(5), recipients: listeners });
    expect(second.id).toBe(first.id);
    // The second call changes nothing, not even what it was asked to change.
    expect(second.endsAt).toBeNull();
    expect(await outbox()).toHaveLength(2);
    expect((await listEntitlements(pool, { siteId: site.id, subjectId, product: LICENSE })).filter((e) => e.reference === reference)).toHaveLength(1);
  });

  it("adds up the valid entries of a counted product", async () => {
    await grant({ product: SEATS, counted: true, quantity: 3 });
    await grant({ product: SEATS, counted: true, quantity: 4, endsAt: hours(2) });
    expect(await stateOf(SEATS)).toMatchObject({ entitled: true, quantity: 7 });
    // A product that does not count carries no quantity, whatever its entries say.
    expect(await stateOf(LICENSE)).toMatchObject({ quantity: null });
  });

  it("does not count a suspended or revoked entry, and does not let an update revive a revoked one", async () => {
    const kind = await product("@pgtest/licenses:suspend" as PhisProductId);
    const reference = ref("susp");
    await grant({ product: kind, reference });
    expect((await stateOf(kind)).entitled).toBe(true);

    const suspended = await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference, suspended: true, listeners: [] });
    expect(suspended).toMatchObject({ valid: false, flags: PhisEntitlementFlag.Suspended });
    expect((await stateOf(kind)).entitled).toBe(false);

    const resumed = await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference, suspended: false, listeners: [] });
    expect(resumed).toMatchObject({ valid: true, flags: 0 });

    const revoked = await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference, revoke: true, listeners: [] });
    expect(revoked).toMatchObject({ valid: false, flags: PhisEntitlementFlag.Revoked });
    expect((await stateOf(kind)).entitled).toBe(false);

    // Over for good: neither a resume nor a new end brings it back, and the answer is "not found".
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference, suspended: false, listeners: [] })).toBeNull();
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference, endsAt: null, listeners: [] })).toBeNull();
    expect((await stateOf(kind)).entitled).toBe(false);
    const [entry] = await listEntitlements(pool, { siteId: site.id, subjectId, product: kind });
    expect(entry!.flags & PhisEntitlementFlag.Revoked).toBe(PhisEntitlementFlag.Revoked);
  });

  it("does not count an entry that has ended or not yet started", async () => {
    const kind = await product("@pgtest/licenses:timed" as PhisProductId);
    await grant({ product: kind, startsAt: hours(-3), endsAt: hours(-1) });
    expect(await stateOf(kind)).toEqual({ product: kind, entitled: false, quantity: null, until: null });
    await grant({ product: kind, startsAt: hours(1), endsAt: hours(2) });
    expect((await stateOf(kind)).entitled).toBe(false);
  });

  it("answers until as the latest end, and null while one valid entry has none", async () => {
    const kind = await product("@pgtest/licenses:until" as PhisProductId);
    const early = hours(2);
    const late = hours(6);
    await grant({ product: kind, endsAt: early });
    await grant({ product: kind, endsAt: late });
    expect(await stateOf(kind)).toMatchObject({ entitled: true, until: late });
    await grant({ product: kind });
    expect(await stateOf(kind)).toMatchObject({ entitled: true, until: null });
  });

  it("does not find another source's entry to change or take back", async () => {
    const kind = await product("@pgtest/licenses:own" as PhisProductId);
    const reference = ref("own");
    await grant({ product: kind, reference, source: SHOP });
    expect(await updateEntitlement(pool, { siteId: site.id, source: OTHER, product: kind, reference, suspended: true, listeners: [] })).toBeNull();
    expect(await updateEntitlement(pool, { siteId: site.id, source: OTHER, product: kind, reference, revoke: true, listeners: [] })).toBeNull();
    expect((await stateOf(kind)).entitled).toBe(true);
    // The same reference of another source is its own entry.
    const mine = await grant({ product: kind, reference, source: OTHER });
    expect(mine.source).toBe(OTHER);
    expect(await listEntitlements(pool, { siteId: site.id, subjectId, product: kind })).toHaveLength(2);
  });

  it("announces each ended entry once, and once per subject and product", async () => {
    const kind = await product("@pgtest/licenses:ending" as PhisProductId);
    const pool = await requirePhiTestDatabase();
    await clearOutbox();
    await grant({ product: kind, startsAt: hours(-4), endsAt: hours(-3) });
    await grant({ product: kind, startsAt: hours(-4), endsAt: hours(-2) });
    // A revoked entry that ended is not news, and neither is one still running.
    const revokedRef = ref("revoked-ended");
    await grant({ product: kind, startsAt: hours(-4), endsAt: hours(-1), reference: revokedRef });
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference: revokedRef, revoke: true, listeners: [] });
    await grant({ product: kind, endsAt: hours(5) });

    const sites = await announceEndedEntitlements(pool, [READY_A, READY_B, NOT_READY]);
    expect(sites).toContain(site.id);
    const rows = (await outbox()).filter((row) => row.payload.product === kind);
    expect(rows.map((row) => row.addon_id).sort()).toEqual([READY_A, READY_B]);
    expect(rows.every((row) => row.payload.subject === subject)).toBe(true);

    const { rows: marked } = await pool.query<{ ended_event_at: Date | null; flags: number }>(
      `SELECT ended_event_at, flags FROM phis.entitlements WHERE site_id = $1 AND product = $2`, [site.id, kind],
    );
    expect(marked.filter((row) => row.ended_event_at !== null)).toHaveLength(2);

    // Nothing is owed the second time.
    await clearOutbox();
    expect(await announceEndedEntitlements(pool, [READY_A, READY_B])).not.toContain(site.id);
    expect(await outbox()).toHaveLength(0);

    // A moved ending is owed its event again.
    const moved = (await listEntitlements(pool, { siteId: site.id, subjectId, product: kind })).find((entry) => !entry.valid && entry.flags === 0)!;
    await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: kind, reference: moved.reference, endsAt: hours(-0.5), listeners: [] });
    expect(await announceEndedEntitlements(pool, [READY_A])).toContain(site.id);
    expect((await outbox()).filter((row) => row.addon_id === READY_A)).toHaveLength(1);
  });

  it("allows, lists and takes back a source, for every product or for named suppliers", async () => {
    expect(await isEntitlementSourceAllowed(pool, site.id, SUPPLIER, SHOP)).toBe(false);
    expect(await allowEntitlementSource(pool, { siteId: site.id, source: SHOP, suppliers: [SUPPLIER], grantedByUserId: null })).toBe(true);
    // Saying it twice changes nothing.
    expect(await allowEntitlementSource(pool, { siteId: site.id, source: SHOP, suppliers: [SUPPLIER], grantedByUserId: userId })).toBe(false);
    expect(await isEntitlementSourceAllowed(pool, site.id, SUPPLIER, SHOP)).toBe(true);
    expect(await isEntitlementSourceAllowed(pool, site.id, "@pgtest/elsewhere", SHOP)).toBe(false);
    expect(await isEntitlementSourceAllowed(pool, site.id, SUPPLIER, OTHER)).toBe(false);

    // Allowing for every product replaces the named suppliers.
    expect(await allowEntitlementSource(pool, { siteId: site.id, source: SHOP, suppliers: null, grantedByUserId: null })).toBe(true);
    expect(await isEntitlementSourceAllowed(pool, site.id, "@pgtest/elsewhere", SHOP)).toBe(true);
    await allowEntitlementSource(pool, { siteId: site.id, source: OTHER, suppliers: ["@pgtest/b", "@pgtest/a"], grantedByUserId: userId });

    const listed = await listEntitlementSources(pool, site.id);
    expect(listed.map((row) => row.source)).toEqual([OTHER, SHOP]);
    expect(listed[0]).toMatchObject({ allProducts: false, suppliers: ["@pgtest/a", "@pgtest/b"], grantedByUserId: userId });
    expect(listed[1]).toMatchObject({ allProducts: true, suppliers: [], grantedByUserId: null });

    expect(await disallowEntitlementSource(pool, { siteId: site.id, source: SHOP })).toBe(true);
    expect(await disallowEntitlementSource(pool, { siteId: site.id, source: SHOP })).toBe(false);
    expect(await isEntitlementSourceAllowed(pool, site.id, SUPPLIER, SHOP)).toBe(false);
    // The entries the source wrote stay.
    expect((await listEntitlements(pool, { siteId: site.id, subjectId, product: LICENSE })).some((entry) => entry.source === SHOP)).toBe(true);
  });

  it("refuses an allowance that names nothing", async () => {
    await expect(allowEntitlementSource(pool, { siteId: site.id, source: SHOP, suppliers: [], grantedByUserId: null })).rejects.toThrow(/entitlement_sources_scope_check/);
  });

  it("refuses a new entry for a product that does not exist or is not active, and answers an existing one", async () => {
    const draft = await product("@pgtest/licenses:draft" as PhisProductId, { state: "draft" });
    expect(await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: draft, source: SHOP, reference: "r-draft", startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    })).toBeNull();
    expect(await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: "@pgtest/licenses:nothing" as PhisProductId, source: SHOP, reference: "r-none", startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    })).toBeNull();

    const active = await product("@pgtest/licenses:fading" as PhisProductId);
    const first = await grant({ product: active, reference: "r-fade" });
    await setProductState(pool, { siteId: site.id, supplier: SUPPLIER, key: "fading", state: "withdrawn", listeners: [] });
    // A payment handler delivered again after the withdrawal still finds its entry; a new one is refused.
    expect((await grant({ product: active, reference: "r-fade" })).id).toBe(first.id);
    expect(await grantEntitlement(pool, {
      siteId: site.id, subjectId, product: active, source: SHOP, reference: "r-new", startsAt: null, endsAt: null, quantity: null, counted: false, listeners: [],
    })).toBeNull();
    // Withdrawn: holders keep it as it was, and the entry can still be changed and taken back.
    expect((await stateOf(active)).entitled).toBe(true);
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: active, reference: "r-fade", suspended: true, listeners: [] })).not.toBeNull();
    expect(await updateEntitlement(pool, { siteId: site.id, source: SHOP, product: active, reference: "r-fade", revoke: true, listeners: [] })).not.toBeNull();
  });

  it("does not count entries while their product is locked, nor those whose product does not exist, and keeps them", async () => {
    const locked = await product("@pgtest/licenses:lockme" as PhisProductId, { counted: true });
    await grant({ product: locked, counted: true, quantity: 2 });
    expect(await stateOf(locked)).toMatchObject({ entitled: true, quantity: 2 });
    await moveProductsAsOperator(pool, { siteId: site.id, to: "locked", productId: locked, listeners: [] });
    expect(await stateOf(locked)).toEqual({ product: locked, entitled: false, quantity: null, until: null });
    const [entry] = await listEntitlements(pool, { siteId: site.id, subjectId, product: locked });
    expect(entry).toMatchObject({ valid: false, flags: 0 });
    await moveProductsAsOperator(pool, { siteId: site.id, to: "unlocked", productId: locked, listeners: [] });
    // Unlocked it is withdrawn, and holders keep it as it was.
    expect(await stateOf(locked)).toMatchObject({ entitled: true, quantity: 2 });

    // An entry whose product is not there (any more) stays and does not count.
    const orphan = "@pgtest/licenses:vanished" as PhisProductId;
    await pool.query(
      `INSERT INTO phis.entitlements (site_id, subject_id, product, source, reference) VALUES ($1, $2, $3, $4, 'orphan')`,
      [site.id, subjectId, orphan, SHOP],
    );
    expect(await stateOf(orphan)).toMatchObject({ entitled: false });
    expect(await listEntitlements(pool, { siteId: site.id, subjectId, product: orphan })).toMatchObject([{ valid: false }]);
  });
});
