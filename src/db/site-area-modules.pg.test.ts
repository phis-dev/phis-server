import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PhiCmsAreaRevisionFlags } from "@phis/contracts/cms";

import {
  closePhiTestPool,
  createPhiTestPageScope,
  createPhiTestSite,
  dropPhiTestSites,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import {
  deleteSiteAreaModulesDraftRevision,
  deleteSiteAreaOverride,
  getSiteAreaLiveRead,
  getSiteAreaRevisionReview,
  getSiteCurrentAreaModulesDraft,
  publishSiteAreaModulesRevision,
  publishSiteAreaRevision,
  saveSiteAreaDraftRevision,
  saveSiteAreaModulesDraftRevision,
} from "./site-pages";
import { listPhiSiteActiveModuleIdsWithDb } from "./site-active-modules";
import { countSiteCmsReferencesToPageWithDb } from "./site-cms-references";
import { listSiteRevisionHistory, restoreSiteRevision } from "./site-revisions";
import { createPhiPageReference } from "@/lib/internal-references";
import {
  validateCmsAreaModulesWriteInput,
  validateCmsAreaPresetWriteInput,
  type CmsAreaModulesWriteInput,
  type CmsAreaPresetWriteInput,
} from "@/lib/cms/write-validation";

const APP_AREA = 2;
const BASE = { ownerModuleId: "@phis/ui/modules/app", presetKey: "app-area-preset" };
const PROVIDER = { ownerModuleId: "@acme/site/modules/site", presetKey: "app-shell" };

/**
 * The Module selection is stored apart from the structure: saving or publishing Modules never writes or
 * freezes a structure, and clearing a structure never loses the selection.
 */
describe("an Area's Module selection against PostgreSQL", () => {
  let site: PhiTestSite;

  beforeAll(async () => {
    await requirePhiTestDatabase();
    site = await createPhiTestSite("area-modules");
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  function modulesInput(
    runtimeModules: string[],
    draft?: CmsAreaModulesWriteInput["draft"],
    extra: Record<string, unknown> = {},
  ): CmsAreaModulesWriteInput {
    const validated = validateCmsAreaModulesWriteInput({
      area: "app",
      ...(draft ? { draft } : {}),
      config: { modules: { runtimeModules, ...extra } },
    });
    if (!validated.ok) throw new Error(validated.details?.join(" "));
    return validated.value;
  }

  function structureInput(
    shell: Record<string, unknown> = {},
    draft?: CmsAreaPresetWriteInput["draft"],
  ): CmsAreaPresetWriteInput {
    const validated = validateCmsAreaPresetWriteInput({
      area: "app",
      sourcePreset: { ...BASE, sourcePresetVersion: 1 },
      ...(draft ? { draft } : {}),
      preset: { config: { shell } },
      regions: [],
      overlays: [],
      layoutNodes: [],
      contentWidgets: [],
      controllerSettings: [],
    });
    if (!validated.ok) throw new Error(validated.details?.join(" "));
    return validated.value;
  }

  async function readScope(siteId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{
      id: number;
      published_revision_id: number | null;
      working_draft_revision_id: number | null;
      working_module_draft_revision_id: number | null;
      published_modules_revision_id: number | null;
    }>(
      `SELECT id, published_revision_id, working_draft_revision_id, working_module_draft_revision_id,
              published_modules_revision_id
       FROM phis.site_area_scopes WHERE site_id = $1 AND area_id = $2`,
      [siteId, APP_AREA],
    );
    return rows[0] ?? null;
  }

  async function readRevision(revisionId: number) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ flags: number; tree_json: Record<string, unknown> }>(
      `SELECT flags, tree_json FROM phis.site_area_revisions WHERE id = $1`,
      [revisionId],
    );
    return rows[0] ?? null;
  }

  async function countRevisions(scopeId: number, modules: boolean) {
    const pool = await requirePhiTestDatabase();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM phis.site_area_revisions
       WHERE area_scope_id = $1 AND ((flags & $2::int) <> 0) = $3`,
      [scopeId, PhiCmsAreaRevisionFlags.Modules, modules],
    );
    return Number(rows[0]!.count);
  }

  it("saves and publishes Modules on an Area without a structure, and creates none", async () => {
    const saved = await saveSiteAreaModulesDraftRevision(site.id, modulesInput(["@acme/shop/modules/shop"], undefined, {
      mediaSpaces: { user: { kinds: ["image"] } },
    }));
    const draft = await readRevision(saved.revisionId);
    expect(draft!.flags).toBe(PhiCmsAreaRevisionFlags.Draft | PhiCmsAreaRevisionFlags.Modules);
    expect(draft!.tree_json).toEqual({
      area: "app",
      preset: {
        config: {
          modules: { runtimeModules: ["@acme/shop/modules/shop"], mediaSpaces: { user: { kinds: ["image"] } } },
        },
      },
    });

    const current = await getSiteCurrentAreaModulesDraft(site.id, { areaMask: APP_AREA });
    expect(current?.config).toEqual({
      modules: { runtimeModules: ["@acme/shop/modules/shop"], mediaSpaces: { user: { kinds: ["image"] } } },
    });

    const published = await publishSiteAreaModulesRevision(site.id, { areaMask: APP_AREA });
    expect(published.revisionId).toBe(saved.revisionId);
    expect((await readRevision(saved.revisionId))!.flags).toBe(
      PhiCmsAreaRevisionFlags.Published | PhiCmsAreaRevisionFlags.Modules,
    );

    const scope = await readScope(site.id);
    expect(scope).toMatchObject({
      published_revision_id: null,
      working_draft_revision_id: null,
      working_module_draft_revision_id: null,
      published_modules_revision_id: saved.revisionId,
    });
    expect(await countRevisions(scope!.id, false)).toBe(0);
  });

  it("has the materializers and the active Module list read the published Modules revision", async () => {
    const pool = await requirePhiTestDatabase();
    expect(await listPhiSiteActiveModuleIdsWithDb(pool, site.id)).toEqual(["@acme/shop/modules/shop"]);
    const { rows } = await pool.query<{ user_space_content_kinds: string[] }>(
      `SELECT user_space_content_kinds FROM phis.site_media_config WHERE site_id = $1`,
      [site.id],
    );
    expect(rows[0]?.user_space_content_kinds).toEqual(["image"]);
  });

  it("answers the selection on the live read whatever identity is named, and the structure only under its own", async () => {
    const structure = await saveSiteAreaDraftRevision(site.id, structureInput({ rootRoute: { mode: "landing" } }));
    await publishSiteAreaRevision(site.id, { areaMask: APP_AREA, sourcePreset: BASE, revisionId: structure.revisionId });
    const scope = await readScope(site.id);

    const underBase = await getSiteAreaLiveRead(site.id, APP_AREA, { sourcePreset: BASE });
    expect(underBase.preset?.sourcePreset).toMatchObject(BASE);
    expect(underBase.modules?.revisionId).toBe(scope!.published_modules_revision_id);

    const underProvider = await getSiteAreaLiveRead(site.id, APP_AREA, { sourcePreset: PROVIDER });
    expect(underProvider.preset).toBeNull();
    expect(underProvider.modules).toEqual(underBase.modules);

    const withoutIdentity = await getSiteAreaLiveRead(site.id, APP_AREA, {});
    expect(withoutIdentity.preset).toBeNull();
    expect(withoutIdentity.modules).toEqual(underBase.modules);
  });

  it("publishes a structure without touching the selection", async () => {
    const before = await readScope(site.id);
    const structure = await saveSiteAreaDraftRevision(site.id, structureInput({}));
    await publishSiteAreaRevision(site.id, { areaMask: APP_AREA, sourcePreset: BASE, revisionId: structure.revisionId });

    const after = await readScope(site.id);
    expect(after!.published_revision_id).toBe(structure.revisionId);
    expect(after!.published_modules_revision_id).toBe(before!.published_modules_revision_id);
    // The structure tree carries no selection.
    const tree = (await readRevision(structure.revisionId))!.tree_json;
    expect((tree.preset as { config: Record<string, unknown> }).config).not.toHaveProperty("modules");
  });

  it("answers a reviewed Modules draft as the selection beside the live structure", async () => {
    const saved = await saveSiteAreaModulesDraftRevision(site.id, modulesInput([]));
    const review = await getSiteAreaRevisionReview(site.id, saved.revisionId, {
      areaMask: APP_AREA,
      sourcePreset: BASE,
    });
    expect(review?.modules).toEqual({ revisionId: saved.revisionId, config: { modules: { runtimeModules: [] } } });
    expect(review?.preset?.sourcePreset).toMatchObject(BASE);

    expect(await deleteSiteAreaModulesDraftRevision(site.id, { areaMask: APP_AREA })).toEqual({ deleted: true });
    expect((await readScope(site.id))!.working_module_draft_revision_id).toBeNull();
  });

  it("keeps the structure's references while Modules are saved and published", async () => {
    const pool = await requirePhiTestDatabase();
    const pageScopeId = await createPhiTestPageScope(site, `/pgtest-area-modules-${Math.random().toString(36).slice(2)}`, APP_AREA);
    const reference = createPhiPageReference({ kind: "site", pageScopeId });
    const structure = await saveSiteAreaDraftRevision(site.id, structureInput({
      rootRoute: { mode: "redirect", targetLinkTarget: { kind: "page", reference } },
    }));
    await publishSiteAreaRevision(site.id, { areaMask: APP_AREA, sourcePreset: BASE, revisionId: structure.revisionId });
    expect((await countSiteCmsReferencesToPageWithDb(pool, site.id, pageScopeId)).bySource.area).toBe(1);

    await saveSiteAreaModulesDraftRevision(site.id, modulesInput(["@acme/shop/modules/shop"]));
    await publishSiteAreaModulesRevision(site.id, { areaMask: APP_AREA });

    expect((await countSiteCmsReferencesToPageWithDb(pool, site.id, pageScopeId)).bySource.area).toBe(1);
  });

  it("restores a Modules revision into the Module draft and a structure revision into the structure draft", async () => {
    const scope = await readScope(site.id);
    const firstModules = scope!.published_modules_revision_id!;
    const second = await saveSiteAreaModulesDraftRevision(site.id, modulesInput(["@acme/blog/modules/blog"]));
    await publishSiteAreaModulesRevision(site.id, { areaMask: APP_AREA });
    const history = await listSiteRevisionHistory(site.id, { kind: "area", areaMask: APP_AREA, sourcePreset: BASE });
    expect(history.rows.find((row) => row.revisionId === second.revisionId)?.isPublished).toBe(true);
    expect(history.rows.find((row) => row.revisionId === second.revisionId)?.sourcePreset).toBeNull();

    const restoredModules = await restoreSiteRevision(site.id, {
      kind: "area",
      areaMask: APP_AREA,
      sourcePreset: BASE,
      revisionId: firstModules,
    });
    const afterModules = await readScope(site.id);
    expect(afterModules!.working_module_draft_revision_id).toBe(restoredModules.revisionId);
    expect(afterModules!.working_draft_revision_id).toBeNull();
    expect((await readRevision(restoredModules.revisionId))!.flags).toBe(
      PhiCmsAreaRevisionFlags.Draft | PhiCmsAreaRevisionFlags.Modules,
    );
    // The restored Draft is one the next Module save can build on.
    const current = await getSiteCurrentAreaModulesDraft(site.id, { areaMask: APP_AREA });
    await saveSiteAreaModulesDraftRevision(site.id, modulesInput(["@acme/shop/modules/shop"], {
      revisionId: current!.revisionId,
      version: current!.draft.version,
      nextNodeSequence: current!.draft.nextNodeSequence,
    }));

    const restoredStructure = await restoreSiteRevision(site.id, {
      kind: "area",
      areaMask: APP_AREA,
      sourcePreset: BASE,
      revisionId: afterModules!.published_revision_id!,
    });
    const afterStructure = await readScope(site.id);
    expect(afterStructure!.working_draft_revision_id).toBe(restoredStructure.revisionId);
    expect(afterStructure!.working_module_draft_revision_id).toBe(restoredModules.revisionId);
    expect((await readRevision(restoredStructure.revisionId))!.flags).toBe(PhiCmsAreaRevisionFlags.Draft);
  });

  it("clears the structure and keeps the selection, revisions and pointers alike", async () => {
    const before = await readScope(site.id);
    expect(await deleteSiteAreaOverride(site.id, { areaMask: APP_AREA, sourcePreset: BASE })).toEqual({ deleted: true });

    const after = await readScope(site.id);
    expect(after).toMatchObject({
      id: before!.id,
      published_revision_id: null,
      working_draft_revision_id: null,
      working_module_draft_revision_id: before!.working_module_draft_revision_id,
      published_modules_revision_id: before!.published_modules_revision_id,
    });
    expect(await countRevisions(after!.id, false)).toBe(0);
    expect(await countRevisions(after!.id, true)).toBeGreaterThan(0);

    const read = await getSiteAreaLiveRead(site.id, APP_AREA, { sourcePreset: BASE });
    expect(read.preset).toBeNull();
    expect(read.modules?.revisionId).toBe(before!.published_modules_revision_id);
    const pool = await requirePhiTestDatabase();
    expect(await listPhiSiteActiveModuleIdsWithDb(pool, site.id)).toEqual(["@acme/blog/modules/blog"]);
  });

  it("refuses to clear a structure under an identity it is not stored under", async () => {
    const other = await createPhiTestSite("area-modules-identity");
    await saveSiteAreaDraftRevision(other.id, structureInput());
    await expect(
      deleteSiteAreaOverride(other.id, { areaMask: APP_AREA, sourcePreset: PROVIDER }),
    ).rejects.toThrow(/identity does not match/u);
  });
});
