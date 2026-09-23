import { describe, expect, it } from "vitest";

import { resolvePhiUserStateKeyOwner } from "@/db/site-active-modules";

/**
 * Who owns a user-state key, decided by prefix alone.
 *
 * This is the whole authorization for a write, so the cases that matter are the ones where a prefix
 * nearly matches: a Module id that is a prefix of a longer one, a key that is only a Module id, and an
 * id that matches as text but not at a segment boundary.
 */

const SHOP = "@acme/shop/modules/shop";
const SHOP_ADMIN = "@acme/shop/modules/shop-admin";
const NEWS = "@acme/news/modules/news";

describe("resolvePhiUserStateKeyOwner", () => {
  it("answers the Module whose id the key begins with", () => {
    expect(resolvePhiUserStateKeyOwner(`${SHOP}/dismissed`, [SHOP, NEWS])).toBe(SHOP);
  });

  it("prefers the longest id, so a nested Module keeps its own keys", () => {
    expect(resolvePhiUserStateKeyOwner(`${SHOP_ADMIN}/dismissed`, [SHOP, SHOP_ADMIN])).toBe(SHOP_ADMIN);
    expect(resolvePhiUserStateKeyOwner(`${SHOP}/dismissed`, [SHOP, SHOP_ADMIN])).toBe(SHOP);
  });

  it("refuses a key that is only a Module id", () => {
    expect(resolvePhiUserStateKeyOwner(SHOP, [SHOP])).toBeNull();
    expect(resolvePhiUserStateKeyOwner(`${SHOP}/`, [SHOP])).toBeNull();
  });

  it("refuses a match that is not on a segment boundary", () => {
    expect(resolvePhiUserStateKeyOwner(`${SHOP}-admin/dismissed`, [SHOP])).toBeNull();
  });

  it("refuses a Module this Site does not run", () => {
    expect(resolvePhiUserStateKeyOwner(`${NEWS}/read-until`, [SHOP])).toBeNull();
    expect(resolvePhiUserStateKeyOwner(`${NEWS}/read-until`, [])).toBeNull();
  });
});
