import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  clearPhiUserModuleStateKey,
  getPhiUserModuleState,
  getPhiUserModuleStateKey,
  setPhiUserModuleStateKey,
} from "@/db/user-site-memberships";
import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

/**
 * What only PostgreSQL can decide about `module_state`: that a write reaches one key and no other, and
 * that a marker cannot be moved backwards by an answer that arrives late.
 *
 * Both are properties of the statement rather than of the code around it, so asserting them anywhere
 * else would assert nothing. The row is shared by every Module of a Site, which is what makes the first
 * one worth a test at all.
 */

const SHOP = "@acme/shop/modules/shop";
const NEWS = "@acme/news/modules/news";

describe("user module state", () => {
  let site: PhiTestSite;
  let userId: number;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("user-module-state");
    userId = await createPhiTestUser(site);
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("starts empty and answers null without a membership", async () => {
    expect(await getPhiUserModuleState(userId, site.id)).toEqual({});
    expect(await getPhiUserModuleState(userId + 10_000_000, site.id)).toBeNull();
  });

  it("keeps one key and leaves the rest of the object alone", async () => {
    await setPhiUserModuleStateKey(userId, site.id, `${SHOP}/dismissed-welcome`, true);
    await setPhiUserModuleStateKey(userId, site.id, `${NEWS}/read-until`, 1_700_000_000);

    expect(await getPhiUserModuleState(userId, site.id)).toEqual({
      [`${SHOP}/dismissed-welcome`]: true,
      [`${NEWS}/read-until`]: 1_700_000_000,
    });
  });

  it("writes a second key of one Module without disturbing the first", async () => {
    await setPhiUserModuleStateKey(userId, site.id, `${SHOP}/tour`, { state: "done", version: 1 });

    expect(await getPhiUserModuleStateKey(userId, site.id, `${SHOP}/dismissed-welcome`)).toBe(true);
    expect(await getPhiUserModuleStateKey(userId, site.id, `${SHOP}/tour`)).toEqual({
      state: "done",
      version: 1,
    });
  });

  it("moves a marker forward and ignores an answer that arrives late", async () => {
    const forward = await setPhiUserModuleStateKey(
      userId,
      site.id,
      `${NEWS}/read-until`,
      1_800_000_000,
      { monotonic: true },
    );
    expect(forward).toBe(1_800_000_000);

    const late = await setPhiUserModuleStateKey(
      userId,
      site.id,
      `${NEWS}/read-until`,
      1_600_000_000,
      { monotonic: true },
    );
    expect(late).toBe(1_800_000_000);
  });

  it("starts a marker from nothing when the key is new", async () => {
    const first = await setPhiUserModuleStateKey(
      userId,
      site.id,
      `${NEWS}/seen-banner`,
      42,
      { monotonic: true },
    );
    expect(first).toBe(42);
  });

  it("removes a key rather than falsifying it, and leaves its neighbours", async () => {
    expect(await clearPhiUserModuleStateKey(userId, site.id, `${SHOP}/dismissed-welcome`)).toBe(true);

    const state = await getPhiUserModuleState(userId, site.id);
    expect(state).not.toHaveProperty(`${SHOP}/dismissed-welcome`);
    expect(state).toHaveProperty(`${SHOP}/tour`);
    expect(await getPhiUserModuleStateKey(userId, site.id, `${SHOP}/dismissed-welcome`)).toBeNull();
  });

  it("reports no membership rather than pretending a write happened", async () => {
    expect(await clearPhiUserModuleStateKey(userId + 10_000_000, site.id, `${SHOP}/tour`)).toBe(false);
    expect(
      await setPhiUserModuleStateKey(userId + 10_000_000, site.id, `${SHOP}/tour`, true),
    ).toBeNull();
  });
});
