import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
  restoreFirstPartyAuthPreset,
} from "./auth-preset.mts";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";

const PUBLIC_AREA = 1;
const BUILDER_AREA = 256;
const FOREIGN_PROVIDER = "@acme/login";

/** The Module selection lives under `config.modules`; `shell` belongs to the structure draft. */
async function createAreaRevision(
  site: PhiTestSite,
  areaMask: number,
  modules: Record<string, unknown>,
  shell: Record<string, unknown> | null = null,
) {
  const config: Record<string, unknown> = { modules, ...(shell ? { shell } : {}) };
  const pool = await requirePhiTestDatabase();
  const { rows: scopeRows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.site_area_scopes (site_id, area_id) VALUES ($1, $2) RETURNING id`,
    [site.id, areaMask],
  );
  const scopeId = scopeRows[0]!.id;
  const { rows: revisionRows } = await pool.query<{ id: number }>(
    `INSERT INTO phis.site_area_revisions (area_scope_id, flags, tree_json, message)
     VALUES ($1, 0, $2::jsonb, 'fixture')
     RETURNING id`,
    [scopeId, JSON.stringify({ regions: [], preset: { flags: 0, config } })],
  );
  const revisionId = revisionRows[0]!.id;
  await pool.query(
    `UPDATE phis.site_area_scopes SET published_revision_id = $2 WHERE id = $1`,
    [scopeId, revisionId],
  );
  return { scopeId, revisionId };
}

async function readAreaPointer(scopeId: number) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ published_revision_id: number | null }>(
    `SELECT published_revision_id FROM phis.site_area_scopes WHERE id = $1`,
    [scopeId],
  );
  return rows[0]!.published_revision_id;
}

async function readAreaConfig(revisionId: number) {
  const pool = await requirePhiTestDatabase();
  const { rows } = await pool.query<{ config: Record<string, unknown> }>(
    `SELECT tree_json #> '{preset,config}' AS config FROM phis.site_area_revisions WHERE id = $1`,
    [revisionId],
  );
  return rows[0]!.config;
}

async function readAreaModules(revisionId: number) {
  return (await readAreaConfig(revisionId)).modules as Record<string, unknown>;
}

describe("restoreFirstPartyAuthPreset", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("auth-preset");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("replaces a foreign provider, keeps the rest of the selection, and stays idempotent", async () => {
    const pool = await requirePhiTestDatabase();
    const { scopeId, revisionId } = await createAreaRevision(
      site,
      PUBLIC_AREA,
      {
        runtimeModules: ["@phis/ui/modules/asset", FOREIGN_PROVIDER, "@phis/ui/modules/avatar"],
        authUiProviderModuleId: FOREIGN_PROVIDER,
        mediaSpaces: { user: { kinds: ["image"] } },
      },
      { rootRoute: { mode: "landing" } },
    );

    const first = await restoreFirstPartyAuthPreset(pool, site.key);
    const publicArea = first.areas.find((area) => area.area === "public")!;

    expect(publicArea.changed).toBe(true);
    expect(publicArea.removedProviderModuleIds).toEqual([FOREIGN_PROVIDER]);
    expect(publicArea.publishedRevisionId).not.toBe(revisionId);
    expect(first.publicLoginOwner).toBe("site-revision");
    expect(first.warnings).toEqual([]);

    const restored = await readAreaModules(publicArea.publishedRevisionId!);
    expect(restored.runtimeModules).toEqual([
      PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
      "@phis/ui/modules/asset",
      "@phis/ui/modules/avatar",
    ]);
    expect(restored.authUiProviderModuleId).toBe(PHI_FIRST_PARTY_AUTH_UI_MODULE_ID);
    // Untouched keys survive: the operation restores Auth, it does not rewrite the preset.
    expect(restored.mediaSpaces).toEqual({ user: { kinds: ["image"] } });
    // And it stays inside its own namespace -- the Shell's statements are another draft's to make.
    expect((await readAreaConfig(publicArea.publishedRevisionId!)).shell).toEqual({
      rootRoute: { mode: "landing" },
    });

    const settled = await readAreaPointer(scopeId);
    const second = await restoreFirstPartyAuthPreset(pool, site.key);

    expect(second.areas.find((area) => area.area === "public")!.changed).toBe(false);
    expect(await readAreaPointer(scopeId)).toBe(settled);
  });

  it("undeletes an Auth page preset so the code preset becomes effective again", async () => {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.site_page_scopes (site_id, area_id, owner_module_id, preset_key, tombstoned_at)
       VALUES ($1, $2, $3, 'login-page', NOW())
       RETURNING id`,
      [site.id, PUBLIC_AREA, PHI_FIRST_PARTY_AUTH_UI_MODULE_ID],
    );
    const scopeId = rows[0]!.id;

    const result = await restoreFirstPartyAuthPreset(pool, site.key);
    const page = result.pagePresets.find((entry) => entry.presetKey === "login-page")!;

    expect(page.changed).toBe(true);
    expect(page.restoredFromDeleted).toBe(true);

    const { rows: after } = await pool.query<{
      tombstoned_at: Date | null;
      published_revision_id: number | null;
    }>(
      `SELECT tombstoned_at, published_revision_id FROM phis.site_page_scopes WHERE id = $1`,
      [scopeId],
    );
    expect(after[0]!.tombstoned_at).toBeNull();
    expect(after[0]!.published_revision_id).toBeNull();
  });

  it("reports a provider that stays active in an Area it does not touch", async () => {
    const pool = await requirePhiTestDatabase();
    await createAreaRevision(site, BUILDER_AREA, {
      runtimeModules: [FOREIGN_PROVIDER],
      authUiProviderModuleId: FOREIGN_PROVIDER,
    });

    const result = await restoreFirstPartyAuthPreset(pool, site.key);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      `Another Auth UI provider stays active outside Public, Admin and App -- builder: ${FOREIGN_PROVIDER}. This command does not touch those Areas.`,
    ]);
  });

  it("says so when an Area carries no Site revision of its own", async () => {
    const pool = await requirePhiTestDatabase();
    const bare = await createPhiTestSite("auth-preset-bare");

    const result = await restoreFirstPartyAuthPreset(pool, bare.key);

    expect(result.publicLoginOwner).toBe("code-preset");
    expect(result.areas.map((area) => area.source)).toEqual([
      "code-preset",
      "code-preset",
      "code-preset",
    ]);
    expect(result.warnings).toEqual([
      "Public carries no Site revision; the installed code preset decides the login owner and cannot be verified from the control plane.",
    ]);
  });

  it("leaves navigation alone -- an injected item returns with its Module", async () => {
    const pool = await requirePhiTestDatabase();
    const result = await restoreFirstPartyAuthPreset(pool, site.key);

    expect(Object.keys(result)).not.toContain("navigation");
  });

  it("refuses an unknown Site", async () => {
    const pool = await requirePhiTestDatabase();
    await expect(restoreFirstPartyAuthPreset(pool, "pgtest-does-not-exist")).rejects.toThrow(
      /does not exist/u,
    );
  });
});
