import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  siteAccess: new Set<string>(),
  grant: 0,
  describe: vi.fn(async (_input: Record<string, unknown>): Promise<unknown[]> => []),
  current: vi.fn(async (_siteId: number, _userIds: readonly number[]) => new Map()),
  byIds: vi.fn(async (_input: Record<string, unknown>): Promise<unknown[]> => []),
  create: vi.fn(async (input: Record<string, unknown>) => ({ id: 41, subject: input.userId == null ? null : "sub_person", ...(input.address as object), flags: input.flags, replacesId: null, createdAt: "2026-11-24T00:00:00.000Z" })),
  member: vi.fn(async (_siteId: number, _subject: string): Promise<{ userId: number; member: boolean } | null> => ({ userId: 12, member: true })),
  log: vi.fn(async (_db: unknown, _entry: Record<string, unknown>) => undefined),
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/db/users-grants.mts", () => ({ readPhisAddonUsersGrant: async () => state.grant }));
vi.mock("@/db/site-users", () => ({
  readPhisUserDescriptions: (input: Record<string, unknown>) => state.describe(input),
  readPhisCurrentSiteAddresses: (siteId: number, userIds: readonly number[]) => state.current(siteId, userIds),
  readPhisSiteAddressesByIds: (input: Record<string, unknown>) => state.byIds(input),
  createPhisSiteAddress: (input: Record<string, unknown>) => state.create(input),
  findPhisSiteSubjectMember: (siteId: number, subject: string) => state.member(siteId, subject),
  recordPhisUsersAccess: (db: unknown, entry: Record<string, unknown>) => state.log(db, entry),
}));

import { PhisSiteAddressFlags, type PhisUserField } from "@phis/contracts/users";
import { PhisUsersAccessRoad } from "@/lib/constants/users";
import { buildPhisAddonUsersCapability } from "./users-capability.ts";

const ALL: PhisUserField[] = ["name", "email", "phone", "address"];
const ADDRESS = { name: "Ada Lovelace", line1: "1 Analytical Way", city: "London", country: "gb" };

function capability(overrides: Partial<Parameters<typeof buildPhisAddonUsersCapability>[0]> = {}) {
  return buildPhisAddonUsersCapability({
    addonId: "@acme/crm",
    siteId: 7,
    actorUserId: 9,
    access: { fields: ALL, background: ["name", "address"] },
    readSiteAccess: async () => (access: string) => state.siteAccess.has(access),
    background: false,
    ...overrides,
  });
}

const member = (subject: string, userId: number) => ({
  subject, userId, member: true,
  profile: { firstName: "Ada", lastName: "L", displayName: null, companyName: null, phone: "+41 79", mobile: null },
  email: `${subject}@example.invalid`,
});

describe("users capability", () => {
  beforeEach(() => {
    state.siteAccess = new Set();
    state.grant = 0;
  });

  it("refuses an unverified hook, a field the manifest does not list, and malformed or too many subjects", async () => {
    const hook = capability({ actorUserId: null, unauthenticated: true });
    await expect(hook.describe({ subjects: [], fields: ["name"] })).rejects.toThrow(/unverified hook/u);
    await expect(hook.addresses({ ids: [1] })).rejects.toThrow(/unverified hook/u);
    await expect(hook.createAddress({ subject: null, address: ADDRESS as never, flags: 1 })).rejects.toThrow(/unverified hook/u);

    const narrow = capability({ access: { fields: ["name"] } });
    await expect(narrow.describe({ subjects: ["sub_x"], fields: ["email"] })).rejects.toThrow(/does not list in users\.fields/u);
    await expect(narrow.addresses({ ids: [1] })).rejects.toThrow(/does not list in users\.fields/u);
    await expect(narrow.createAddress({ subject: null, address: ADDRESS as never, flags: 1 })).rejects.toThrow(/does not list/u);

    await expect(capability().describe({ subjects: [7] as never, fields: ["name"] })).rejects.toThrow(/not a list of entitlement subjects/u);
    await expect(capability().describe({ subjects: ["sub_x"], fields: ["birthday" as never] })).rejects.toThrow(/not users:v1 fields/u);
    await expect(capability().describe({ subjects: Array.from({ length: 101 }, () => "sub_x"), fields: ["name"] })).rejects.toThrow(/more than 100/u);
    expect(state.describe).not.toHaveBeenCalled();
  });

  it("answers nobody acting without system authority, and a member without an access, the bare subjects and reads nothing", async () => {
    state.describe.mockClear();
    expect(await capability({ actorUserId: null }).describe({ subjects: ["sub_a", "sub_b"], fields: ALL }))
      .toEqual([{ subject: "sub_a" }, { subject: "sub_b" }]);
    // A job without a grant: the same.
    expect(await capability({ actorUserId: null, background: true }).describe({ subjects: ["sub_a"], fields: ALL }))
      .toEqual([{ subject: "sub_a" }]);
    expect(state.describe).not.toHaveBeenCalled();
    expect(await capability({ actorUserId: null }).addresses({ ids: [1, 2] })).toEqual([]);
    expect(state.byIds).not.toHaveBeenCalled();
  });

  it("gives support no address and accounting every field, absent rather than refused, and logs the road", async () => {
    state.siteAccess = new Set(["support"]);
    state.describe.mockResolvedValueOnce([member("sub_a", 12)]);
    state.log.mockClear();
    const [supported] = await capability().describe({ subjects: ["sub_a"], fields: ALL });
    expect(supported).toEqual({
      subject: "sub_a",
      name: { firstName: "Ada", lastName: "L", displayName: null, companyName: null },
      email: "sub_a@example.invalid",
      phone: { phone: "+41 79", mobile: null },
    });
    expect(state.current).toHaveBeenCalledWith(7, []);
    expect(state.log).toHaveBeenCalledWith(null, expect.objectContaining({ road: PhisUsersAccessRoad.Staff, subjects: ["sub_a"], fields: 7, actorUserId: 9 }));

    state.siteAccess = new Set(["accounting"]);
    state.describe.mockResolvedValueOnce([member("sub_a", 12), { subject: "sub_gone", userId: null, member: false, profile: null, email: null }]);
    state.current.mockResolvedValueOnce(new Map([[12, [{ id: 3 }]]]));
    const [accounted, gone] = await capability().describe({ subjects: ["sub_a", "sub_gone"], fields: ["address"] });
    expect(accounted).toEqual({ subject: "sub_a", addresses: [{ id: 3 }] });
    expect(gone).toEqual({ subject: "sub_gone" });
    expect(state.log).toHaveBeenLastCalledWith(null, expect.objectContaining({ subjects: ["sub_a"], addressIds: [3], fields: 8 }));
  });

  it("answers the person all of their own, and a job only what was granted and is still asked", async () => {
    state.describe.mockResolvedValueOnce([member("sub_me", 9), member("sub_other", 12)]);
    const [own, other] = await capability().describe({ subjects: ["sub_me", "sub_other"], fields: ["email"] });
    expect(own).toEqual({ subject: "sub_me", email: "sub_me@example.invalid" });
    expect(other).toEqual({ subject: "sub_other" });

    state.grant = 1 | 2 | 8; // name, email, address -- email is no longer asked in the background
    state.describe.mockResolvedValueOnce([member("sub_a", 12)]);
    const [background] = await capability({ actorUserId: null, background: true }).describe({ subjects: ["sub_a"], fields: ["name", "email"] });
    expect(background).toEqual({ subject: "sub_a", name: { firstName: "Ada", lastName: "L", displayName: null, companyName: null } });
    expect(state.log).toHaveBeenLastCalledWith(null, expect.objectContaining({ road: PhisUsersAccessRoad.Background, actorUserId: null, fields: 1 }));
  });

  it("reads addresses by id on the widest road: anybody's for accounting, the person's own otherwise", async () => {
    state.siteAccess = new Set(["accounting"]);
    await capability().addresses({ ids: [5, 6] });
    expect(state.byIds).toHaveBeenLastCalledWith({ siteId: 7, ids: [5, 6], ownerUserId: null });
    state.siteAccess = new Set(["support"]);
    await capability().addresses({ ids: [5] });
    expect(state.byIds).toHaveBeenLastCalledWith({ siteId: 7, ids: [5], ownerUserId: 9 });
    await expect(capability().addresses({ ids: [0] })).rejects.toThrow(/not address ids/u);
  });

  it("writes an address for the person, for accounting on a member's behalf and for a guest, and refuses the rest", async () => {
    state.member.mockResolvedValueOnce({ userId: 9, member: true });
    await capability().createAddress({ subject: "sub_me", address: ADDRESS as never, flags: PhisSiteAddressFlags.Billing | PhisSiteAddressFlags.DefaultBilling });
    expect(state.create).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 9, flags: 5, replaces: null, handedOut: true, address: expect.objectContaining({ country: "GB", line2: null }) }));
    expect(state.log).toHaveBeenLastCalledWith(null, expect.objectContaining({ road: PhisUsersAccessRoad.Self, operation: 3, addressIds: [41] }));

    await expect(capability().createAddress({ subject: "sub_other", address: ADDRESS as never, flags: 1 })).rejects.toThrow(/accounting/u);
    state.siteAccess = new Set(["accounting"]);
    await capability().createAddress({ subject: "sub_other", address: ADDRESS as never, flags: 2 });
    expect(state.create).toHaveBeenLastCalledWith(expect.objectContaining({ userId: 12 }));
    state.member.mockResolvedValueOnce({ userId: 12, member: false });
    await expect(capability().createAddress({ subject: "sub_left", address: ADDRESS as never, flags: 2 })).rejects.toThrow(/no member/u);
    await expect(capability({ actorUserId: null, background: true }).createAddress({ subject: "sub_other", address: ADDRESS as never, flags: 2 }))
      .rejects.toThrow(/accounting/u);

    // A checkout without an account.
    state.siteAccess = new Set();
    await capability({ actorUserId: null }).createAddress({ subject: null, address: ADDRESS as never, flags: 3 });
    expect(state.create).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null }));
    expect(state.log).toHaveBeenLastCalledWith(null, expect.objectContaining({ road: PhisUsersAccessRoad.Checkout, subjects: [] }));
    await expect(capability({ actorUserId: null }).createAddress({ subject: null, address: ADDRESS as never, flags: 5 })).rejects.toThrow(/guest/u);
    await expect(capability({ actorUserId: null }).createAddress({ subject: null, address: ADDRESS as never, flags: 1, replaces: 3 })).rejects.toThrow(/guest/u);
  });

  it("holds an address to its parts and its flags to what a caller states", async () => {
    const write = (address: unknown, flags = 1) => capability({ actorUserId: null }).createAddress({ subject: null, address: address as never, flags });
    await expect(write({ ...ADDRESS, country: "GBR" })).rejects.toThrow(/ISO 3166-1/u);
    await expect(write({ ...ADDRESS, name: " " })).rejects.toThrow(/address\.name is empty/u);
    await expect(write({ ...ADDRESS, city: undefined })).rejects.toThrow(/address\.city is missing/u);
    await expect(write({ ...ADDRESS, line1: "a\nb" })).rejects.toThrow(/no line of text/u);
    await expect(write({ ...ADDRESS, postalCode: "1".repeat(33) })).rejects.toThrow(/longer than 32/u);
    await expect(write(ADDRESS, 0)).rejects.toThrow(/neither a billing nor a shipping/u);
    await expect(write(ADDRESS, PhisSiteAddressFlags.Superseded | 1)).rejects.toThrow(/Core keeps the rest/u);
    await expect(write(ADDRESS, PhisSiteAddressFlags.DefaultShipping | PhisSiteAddressFlags.Billing)).rejects.toThrow(/default was given for a purpose/u);
  });
});
