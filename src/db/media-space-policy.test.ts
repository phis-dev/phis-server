import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  isPhiMediaSpaceKindEnabled,
  PhisMediaSpaceKind,
  readDeclaredMediaSpaces,
  resolveEffectiveMediaQuotaBytes,
  type SiteMediaConfigRecord,
} from "@/db/media-spaces";
import { PhiSiteMediaFlags } from "@/lib/constants/media";
import { parseRequestedMediaSpace } from "@/lib/guards/site-media-api";
import { defaultMediaDeliveryPolicy } from "@/db/media";
import { PhiMediaDeliveryPolicy } from "@/db/media-spaces";
import { resolveMediaQuotaCeilingBytes } from "@/db/media-spaces";

function config(overrides: Partial<SiteMediaConfigRecord> = {}): SiteMediaConfigRecord {
  return {
    siteId: 31,
    flags: 0,
    defaultUserQuotaBytes: null,
    defaultGroupQuotaBytes: null,
    userSpaceContentKinds: [],
    groupSpaceContentKinds: [],
    maxUserQuotaBytes: null,
    maxGroupQuotaBytes: null,
    defaultAddonQuotaBytes: null,
    maxAddonQuotaBytes: null,
    maxObjectBytes: 134_217_728,
    ...overrides,
  };
}

describe("Media Space availability", () => {
  it("denies User and Group Spaces on a Site that was never configured", () => {
    const unconfigured = config();
    expect(isPhiMediaSpaceKindEnabled(unconfigured, PhisMediaSpaceKind.User)).toBe(false);
    expect(isPhiMediaSpaceKindEnabled(unconfigured, PhisMediaSpaceKind.Group)).toBe(false);
  });

  it("always keeps the Site Space available", () => {
    expect(isPhiMediaSpaceKindEnabled(config(), PhisMediaSpaceKind.Site)).toBe(true);
  });

  it("enables the two kinds independently", () => {
    const userOnly = config({ flags: PhiSiteMediaFlags.UserSpacesEnabled });
    expect(isPhiMediaSpaceKindEnabled(userOnly, PhisMediaSpaceKind.User)).toBe(true);
    expect(isPhiMediaSpaceKindEnabled(userOnly, PhisMediaSpaceKind.Group)).toBe(false);

    const groupOnly = config({ flags: PhiSiteMediaFlags.GroupSpacesEnabled });
    expect(isPhiMediaSpaceKindEnabled(groupOnly, PhisMediaSpaceKind.User)).toBe(false);
    expect(isPhiMediaSpaceKindEnabled(groupOnly, PhisMediaSpaceKind.Group)).toBe(true);
  });

  it("rejects an unknown Space kind", () => {
    expect(isPhiMediaSpaceKindEnabled(config({ flags: 3 }), 99)).toBe(false);
  });
});

describe("what an Area preset declares", () => {
  const flagsOf = (value: unknown) => readDeclaredMediaSpaces(value).flags;

  it("reads a declaration per kind", () => {
    expect(flagsOf({ user: { kinds: ["image"] } })).toBe(PhiSiteMediaFlags.UserSpacesEnabled);
    expect(flagsOf({ group: { kinds: ["document"] } })).toBe(PhiSiteMediaFlags.GroupSpacesEnabled);
    expect(flagsOf({ group: { kinds: [] }, user: { kinds: [] } }))
      .toBe(PhiSiteMediaFlags.UserSpacesEnabled | PhiSiteMediaFlags.GroupSpacesEnabled);
  });

  it("carries what each Space is declared to hold", () => {
    expect(readDeclaredMediaSpaces({ user: { kinds: ["image"] }, group: { kinds: ["pdf", "document"] } }))
      .toEqual({
        flags: PhiSiteMediaFlags.UserSpacesEnabled | PhiSiteMediaFlags.GroupSpacesEnabled,
        userSpaceContentKinds: ["image"],
        groupSpaceContentKinds: ["pdf", "document"],
      });
  });

  // A Module that asks for a Space without saying what for gets the Space and accepts nothing in it,
  // which is what makes stating a purpose the only way to be usable.
  it("keeps a Space present while it holds nothing", () => {
    expect(readDeclaredMediaSpaces({ user: { kinds: [] } })).toEqual({
      flags: PhiSiteMediaFlags.UserSpacesEnabled,
      userSpaceContentKinds: [],
      groupSpaceContentKinds: [],
    });
  });

  it("treats an absent, empty, or malformed declaration as no declaration", () => {
    for (const value of [undefined, null, {}, "user", ["user"], 7]) {
      expect(readDeclaredMediaSpaces(value)).toEqual({
        flags: 0,
        userSpaceContentKinds: [],
        groupSpaceContentKinds: [],
      });
    }
  });

  it("ignores a Space kind it does not know rather than rejecting the publish", () => {
    expect(readDeclaredMediaSpaces({ user: { kinds: ["image"] }, tenant: { kinds: ["image"] } }))
      .toEqual({
        flags: PhiSiteMediaFlags.UserSpacesEnabled,
        userSpaceContentKinds: ["image"],
        groupSpaceContentKinds: [],
      });
    expect(flagsOf({ site: { kinds: ["binary"] } })).toBe(0);
  });

  it("carries a content kind it does not know, for the Module that does", () => {
    expect(readDeclaredMediaSpaces({ user: { kinds: ["image", "hologram"] } }).userSpaceContentKinds)
      .toEqual(["image", "hologram"]);
  });

  it("drops a content kind that is not a usable string", () => {
    expect(readDeclaredMediaSpaces({ user: { kinds: ["image", "", "  ", 7, null] } }).userSpaceContentKinds)
      .toEqual(["image"]);
  });

  it("unions the declarations of several Areas", () => {
    const areas = [
      { user: { kinds: ["image"] } },
      {},
      { group: { kinds: ["document"] }, user: { kinds: ["pdf"] } },
      undefined,
    ];
    const union = areas.reduce((carried, area) => {
      const declared = readDeclaredMediaSpaces(area);
      return {
        flags: carried.flags | declared.flags,
        userSpaceContentKinds: [...carried.userSpaceContentKinds, ...declared.userSpaceContentKinds],
        groupSpaceContentKinds: [...carried.groupSpaceContentKinds, ...declared.groupSpaceContentKinds],
      };
    }, { flags: 0, userSpaceContentKinds: [] as string[], groupSpaceContentKinds: [] as string[] });

    expect(union.flags).toBe(PhiSiteMediaFlags.UserSpacesEnabled | PhiSiteMediaFlags.GroupSpacesEnabled);
    expect(union.userSpaceContentKinds).toEqual(["image", "pdf"]);
    expect(union.groupSpaceContentKinds).toEqual(["document"]);
  });
});

describe("effective quota resolution", () => {
  const site = config({ defaultUserQuotaBytes: 1_000, defaultGroupQuotaBytes: 5_000 });

  it("inherits the Site default per kind when the Space has no override", () => {
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.User, quotaBytes: null }, site))
      .toBe(1_000);
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.Group, quotaBytes: null }, site))
      .toBe(5_000);
  });

  it("inherits the Add-on default too, because the reservation statement resolves the same one", () => {
    /*
     * The reader and the enforcer have to name one number. `reserveMediaSpaceQuota` coalesces the
     * override with `default_addon_quota_bytes`; answering `null` here would have told an Add-on and
     * an administrator that a Space is unlimited while the store refused uploads against the default.
     */
    expect(resolveEffectiveMediaQuotaBytes(
      { kind: PhisMediaSpaceKind.Addon, quotaBytes: null },
      config({ defaultAddonQuotaBytes: 9_000 }),
    )).toBe(9_000);
    expect(resolveEffectiveMediaQuotaBytes(
      { kind: PhisMediaSpaceKind.Addon, quotaBytes: 7 },
      config({ defaultAddonQuotaBytes: 9_000 }),
    )).toBe(7);
  });

  it("inherits live, so changing the Site default moves every non-overridden Space", () => {
    const space = { kind: PhisMediaSpaceKind.User, quotaBytes: null };
    expect(resolveEffectiveMediaQuotaBytes(space, site)).toBe(1_000);
    expect(resolveEffectiveMediaQuotaBytes(space, { ...site, defaultUserQuotaBytes: 2_000 }))
      .toBe(2_000);
  });

  it("prefers an explicit override over the default", () => {
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.User, quotaBytes: 42 }, site))
      .toBe(42);
  });

  it("treats an explicit zero as revocation rather than as an absent override", () => {
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.User, quotaBytes: 0 }, site))
      .toBe(0);
  });

  it("leaves the Site Space unlimited and independent of the per-kind defaults", () => {
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.Site, quotaBytes: null }, site))
      .toBeNull();
  });

  it("resolves to no limit when neither an override nor a default exists", () => {
    expect(resolveEffectiveMediaQuotaBytes({ kind: PhisMediaSpaceKind.User, quotaBytes: null }, config()))
      .toBeNull();
  });
});

describe("requested Space parameter", () => {
  it("parses a numeric id, the semantic user selector, and rejects noise", async () => {
    const { NextRequest } = await import("next/server");
    const { readRequestedMediaSpaceId } = await import("@/lib/guards/site-media-api");
    const read = (query: string) =>
      readRequestedMediaSpaceId(new NextRequest(`https://server.test/api/site/media${query}`));
    expect(read("")).toBeNull();
    expect(read("?spaceId=7")).toBe(7);
    expect(read("?spaceId=user")).toBe("user");
    expect(read("?spaceId=USER")).toBe("user");
    expect(read("?spaceId=0")).toBeNull();
    expect(read("?spaceId=-3")).toBeNull();
    expect(read("?spaceId=abc")).toBeNull();
  });
});

/*
 * A number can only ever address a Space that already exists. The semantic forms exist for the cases
 * where the row legitimately may not: the actor's own Space, a group's, and one named by administration
 * on someone else's behalf.
 */
describe("Media Space addresses", () => {
  it("reads every address form", () => {
    expect(parseRequestedMediaSpace("42")).toBe(42);
    expect(parseRequestedMediaSpace("user")).toBe("user");
    expect(parseRequestedMediaSpace("group:7")).toEqual({ kind: "group", groupId: 7 });
    expect(parseRequestedMediaSpace("user:9")).toEqual({ kind: "user", userId: 9 });
  });

  it("treats anything else as no explicit Space", () => {
    for (const raw of [null, undefined, "", "group:", "group:0", "group:-1", "site", "0", "12x"]) {
      expect(parseRequestedMediaSpace(raw)).toBeNull();
    }
  });
});

describe("Media quota ceiling", () => {
  it("applies per Space kind and never to the Site Space", () => {
    const limited = config({ maxUserQuotaBytes: 100, maxGroupQuotaBytes: 200, maxAddonQuotaBytes: 300 });
    expect(resolveMediaQuotaCeilingBytes(PhisMediaSpaceKind.User, limited)).toBe(100);
    expect(resolveMediaQuotaCeilingBytes(PhisMediaSpaceKind.Group, limited)).toBe(200);
    // An Add-on's Space is delegated capacity like the other two: the Space's quota is the Add-on's
    // quota, so a ceiling on it is a ceiling on the Add-on.
    expect(resolveMediaQuotaCeilingBytes(PhisMediaSpaceKind.Addon, limited)).toBe(300);
    // The Site Space is not delegated capacity, so no ceiling is measured against it.
    expect(resolveMediaQuotaCeilingBytes(PhisMediaSpaceKind.Site, limited)).toBeNull();
  });

  it("means no ceiling when unset", () => {
    expect(resolveMediaQuotaCeilingBytes(PhisMediaSpaceKind.Group, config())).toBeNull();
  });
});

/*
 * The group foreign key deliberately does not cascade: deleting a group would otherwise take its Space,
 * folders, and every Asset in it with no warning. This pins the schema statement itself, because the
 * rule lives in the constraint rather than in code that could be tested directly.
 */
describe("Group Space ownership", () => {
  it("does not cascade a group deletion into its Media Space", async () => {
    const schema = await readFile(new URL("../../scripts/sql/001_create_phis.pgsql", import.meta.url), "utf8");
    const declaration = /CONSTRAINT media_spaces_group_site_fk[\s\S]*?REFERENCES phis\.site_groups \(id, site_id\)[^,]*,/u
      .exec(schema)?.[0];
    expect(declaration).toBeDefined();
    expect(declaration).not.toContain("ON DELETE");
    /*
     * Declared with the table rather than altered afterwards: pre-v1 the create script is the schema,
     * so a column or a rule that changes is changed where it was written and the database is rebuilt.
     *
     * The one exception is a reference forward. `media_spaces` is created long before `server_addons`
     * exists, so the Add-on Space's foreign key cannot be stated with the table however much one would
     * like it to be. That is not schema evolution and it does not open the door to any: everything
     * else about the table still has to be declared in one place.
     */
    const alters = [...schema.matchAll(/ALTER TABLE phis\.media_spaces\s+(\w+)[^;]*;/gu)]
      .map((match) => match[0]);
    expect(alters.every((statement) => statement.includes("media_spaces_addon_fk"))).toBe(true);
  });
});

/*
 * What an Asset is visible to before anyone says otherwise. Defaulting everything to `Public` had it
 * backwards for the two isolated Spaces: a file in a User Space is that user's until a Module widens it
 * for a purpose, and a group's file is the group's. Ownership and visibility are separate axes, but the
 * safe starting point on one follows from the other.
 */
describe("default delivery policy", () => {
  it("keeps a User Space Asset private until something widens it", () => {
    expect(defaultMediaDeliveryPolicy(PhisMediaSpaceKind.User)).toBe(PhiMediaDeliveryPolicy.User);
  });

  it("keeps a Group Space Asset inside its group", () => {
    expect(defaultMediaDeliveryPolicy(PhisMediaSpaceKind.Group)).toBe(PhiMediaDeliveryPolicy.Group);
  });

  it("leaves Site content public, which is what the Site Space is for", () => {
    expect(defaultMediaDeliveryPolicy(PhisMediaSpaceKind.Site)).toBe(PhiMediaDeliveryPolicy.Public);
    // An unknown or absent kind must not be more permissive than the Site Space it falls back to.
    expect(defaultMediaDeliveryPolicy(null)).toBe(PhiMediaDeliveryPolicy.Public);
  });
});
