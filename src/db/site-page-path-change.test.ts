import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));

import { changeSitePagePath, SitePagePathChangeError } from "./site-pages";

type Statement = { text: string; values: readonly unknown[] };

type ScopeRow = {
  id: number;
  site_id: number;
  area_id: number;
  path: string | null;
  owner_module_id: string | null;
  preset_key: string | null;
  tombstoned_at: string | null;
  published_revision_id: number | null;
  working_draft_revision_id: number | null;
};

/**
 * Stands in for the one connection the path change runs on, so the statements it issues and the order
 * it issues them in are observable. Every answer is keyed off the statement text because that is what
 * the production code distinguishes its reads by too.
 */
function pathChangeDb(options: {
  scope?: Partial<ScopeRow> | null;
  collision?: boolean;
  /** The conflicting Scope lies beneath the requested path or above it, rather than on it. */
  nested?: boolean;
  references?: { source_kind: number; count: string }[];
} = {}) {
  const statements: Statement[] = [];
  const scope: ScopeRow | null = options.scope === null ? null : {
    id: 18,
    site_id: 31,
    area_id: 1,
    path: "/kontakt",
    owner_module_id: null,
    preset_key: null,
    tombstoned_at: null,
    published_revision_id: 184,
    working_draft_revision_id: 190,
    ...options.scope,
  };
  const release = vi.fn();
  const client = {
    query: async (text: string, values?: readonly unknown[]) => {
      statements.push({ text, values: values ?? [] });
      if (text.includes("owner_module_id, preset_key, tombstoned_at")) {
        return { rows: scope ? [scope] : [] };
      }
      if (text.includes("AS nested")) {
        if (options.nested) return { rows: [{ id: 45, path: "/kontakt-neu/team", draft_path: null, nested: true }] };
        return { rows: options.collision ? [{ id: 44, path: "/kontakt-neu", draft_path: null, nested: false }] : [] };
      }
      if (text.includes("FROM phis.site_cms_references")) {
        return { rows: options.references ?? [] };
      }
      return { rows: [] };
    },
    release,
  };
  mocks.getPool.mockReturnValue({ connect: async () => client });
  return {
    statements,
    release,
    find: (fragment: string) => statements.find((entry) => entry.text.includes(fragment)),
    index: (fragment: string) => statements.findIndex((entry) => entry.text.includes(fragment)),
    texts: () => statements.map((entry) => entry.text.trim().split(/\s+/u).slice(0, 2).join(" ")),
  };
}

async function change(siteId = 31, areaMask = 1, scopeId = 18, path = "/kontakt-neu") {
  return changeSitePagePath(siteId, areaMask, scopeId, path);
}

async function changeTo(path: string) {
  return change(31, 1, 18, path);
}

async function failing(...args: Parameters<typeof change>) {
  try {
    await change(...args);
  } catch (error) {
    if (error instanceof SitePagePathChangeError) return error;
    throw error;
  }
  throw new Error("The path change was expected to fail.");
}

beforeEach(() => {
  mocks.getPool.mockReset();
});

/*
 * The path change is the one command that moves a canonical Page path. It is not a revision, carries no
 * Undo, and every reference to the Page keeps pointing at the Scope rather than the string -- which is
 * exactly why the parts below have to hold: an ownership slip renames a Module's page, a missed collision
 * gives two Pages one path, and a pointer touched in passing loses a published revision.
 */
describe("A Page path change", () => {
  it("proposes the move and reports what pointed at it", async () => {
    const db = pathChangeDb({ references: [{ source_kind: 1, count: "2" }, { source_kind: 4, count: "1" }] });
    const result = await change();
    expect(result).toMatchObject({
      pageScopeId: 18,
      areaMask: 1,
      // The live address is unchanged: the Page answers on it until somebody publishes.
      path: "/kontakt",
      pendingPath: "/kontakt-neu",
      references: { total: 3, bySource: { page: 2, navigation: 0, content: 0, area: 1 } },
    });
    expect(db.texts()).toContain("COMMIT");
    expect(db.find("ROLLBACK")).toBeUndefined();
    expect(db.release).toHaveBeenCalled();
  });

  it("writes the pending path and nothing else, so the live path and the pointers stand", async () => {
    const db = pathChangeDb();
    const result = await change();
    const update = db.find("UPDATE phis.site_page_scopes");
    expect(update!.text).toMatch(/SET draft_path = \$2, updated_at = NOW\(\)/u);
    expect(update!.text).not.toMatch(/SET path|published_revision_id|working_draft_revision_id|tombstoned_at/u);
    expect(update!.values).toEqual([18, "/kontakt-neu"]);
    // The pointers are read before the write and answered unchanged: a rename is not a publish.
    expect(result.publishedRevisionId).toBe(184);
    expect(result.workingDraftRevisionId).toBe(190);
  });

  it("cancels a pending move when the Page is asked for the path it already answers on", async () => {
    const db = pathChangeDb();
    const result = await changeTo("/kontakt");
    expect(result.pendingPath).toBeNull();
    expect(db.find("UPDATE phis.site_page_scopes")!.values).toEqual([18, null]);
    // Nothing contends with an address the Page already holds, so nothing is asked about it.
    expect(db.find("AS nested")).toBeUndefined();
  });

  it("counts the affected references inside the transaction that moves the path", async () => {
    const db = pathChangeDb({ references: [{ source_kind: 2, count: "5" }] });
    const result = await change();
    expect(result.references.bySource.navigation).toBe(5);
    expect(db.index("BEGIN")).toBeLessThan(db.index("FROM phis.site_cms_references"));
    expect(db.index("FROM phis.site_cms_references")).toBeLessThan(db.index("UPDATE phis.site_page_scopes"));
    expect(db.index("UPDATE phis.site_page_scopes")).toBeLessThan(db.index("COMMIT"));
  });

  it("asks for the references of the Scope, not of the path it is leaving", async () => {
    const db = pathChangeDb();
    await change();
    expect(db.find("FROM phis.site_cms_references")!.values).toEqual([31, 18]);
  });
});

describe("A Page path change refuses what is not the Site's to rename", () => {
  it("leaves a Module-owned Scope alone", async () => {
    const db = pathChangeDb({ scope: { owner_module_id: "@phis/ui", preset_key: "login" } });
    expect((await failing()).code).toBe("module_owned");
    expect(db.find("UPDATE phis.site_page_scopes")).toBeUndefined();
    expect(db.find("ROLLBACK")).toBeDefined();
  });

  it("leaves a Scope that carries a preset identity instead of a path", async () => {
    // The two identities are exclusive by CHECK constraint, so a null path is the Module case.
    pathChangeDb({ scope: { path: null, preset_key: "account-security" } });
    expect((await failing()).code).toBe("module_owned");
  });

  it("rejects reserved, traversing and malformed paths before it opens a transaction", async () => {
    for (const path of [
      "/api/pages", "/_next/static", "/operator", "/setup/first-run",
      "/a/../b", "/a/./b", "/..", "/with?query", "/with#fragment", "/with\\backslash",
      `/${"x".repeat(600)}`,
    ]) {
      pathChangeDb();
      const error = await failing(31, 1, 18, path);
      expect(error.code, `"${path}" must not be accepted`).toBe("invalid_path");
    }
    // Nothing was ever connected: the rejection is a pure decision about the requested string.
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("refuses a Site or Area that cannot be addressed at all", async () => {
    for (const args of [[0, 1], [31, 0], [-1, 1], [31, -2]] as const) {
      pathChangeDb();
      expect((await failing(args[0], args[1])).code).toBe("page_not_found");
    }
    expect(mocks.getPool).not.toHaveBeenCalled();
  });
});

describe("A Page path change keeps one path per Area", () => {
  it("refuses the path another Scope already owns", async () => {
    const db = pathChangeDb({ collision: true });
    expect((await failing()).code).toBe("path_collision");
    expect(db.find("UPDATE phis.site_page_scopes")).toBeUndefined();
    expect(db.find("ROLLBACK")).toBeDefined();
  });

  it("counts a tombstoned Scope as the owner, because deletion reserves the path", async () => {
    const db = pathChangeDb({ collision: true });
    await failing();
    const collision = db.find("AS nested");
    // No tombstone filter: a deleted Page keeps its path until the Scope is reactivated on it.
    expect(collision!.text).not.toMatch(/tombstoned_at/u);
    expect(collision!.text).toMatch(/FOR UPDATE/u);
  });

  it("looks for the collision in the addressed Site and Area only, and never against itself", async () => {
    const db = pathChangeDb();
    await change(31, 4, 18, "/kontakt-neu");
    expect(db.find("AS nested")!.values).toEqual([31, 4, "/kontakt-neu", 18]);
  });

  it("refuses a path that would put one Page beneath another, because a Page is never a folder", async () => {
    const db = pathChangeDb({ nested: true });
    const error = await failing();
    expect(error.code).toBe("path_nested");
    expect(error.message).toContain("/kontakt-neu/team");
    expect(db.find("UPDATE phis.site_page_scopes")).toBeUndefined();
    expect(db.find("ROLLBACK")).toBeDefined();
  });

  it("checks under the Area's address lock, so a concurrent create or move cannot slip past it", async () => {
    const db = pathChangeDb();
    await change(31, 4, 18, "/kontakt-neu");
    const lock = db.find("pg_advisory_xact_lock");
    expect(lock!.values).toEqual(["phis.site_page_addresses:31:4"]);
    expect(db.index("pg_advisory_xact_lock")).toBeLessThan(db.index("AS nested"));
    expect(db.index("AS nested")).toBeLessThan(db.index("UPDATE phis.site_page_scopes"));
  });

  it("reads the Scope through its Site and Area rather than by id alone", async () => {
    const db = pathChangeDb();
    await change(31, 2, 18);
    const lookup = db.find("owner_module_id, preset_key, tombstoned_at");
    expect(lookup!.values).toEqual([18, 31, 2]);
    // The row is locked for the whole decision, so a concurrent rename cannot slip between the two reads.
    expect(lookup!.text).toMatch(/FOR UPDATE/u);
  });

  it("answers page_not_found when the Scope is not in this Site and Area", async () => {
    const db = pathChangeDb({ scope: null });
    expect((await failing()).code).toBe("page_not_found");
    expect(db.find("UPDATE phis.site_page_scopes")).toBeUndefined();
  });
});
