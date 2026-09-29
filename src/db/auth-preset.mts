import type { Pool, PoolClient } from "pg";
import { PhiCmsVisibilityContext } from "@phis/contracts/cms";
import { PHI_AREA_CONFIG_MODULES_NAMESPACE } from "../lib/cms/area-config.ts";
import { withPoolTransaction } from "../lib/db-transaction.ts";

export const PHI_FIRST_PARTY_AUTH_UI_MODULE_ID = "@phis/ui/modules/auth";

const PUBLIC_AREA_MASK = PhiCmsVisibilityContext.PublicArea;

/** Every Area, so a diagnostic can name the one it found a foreign provider in. */
const AREA_NAME_BY_MASK = new Map<number, string>([
  [PhiCmsVisibilityContext.PublicArea, "public"],
  [PhiCmsVisibilityContext.AppArea, "app"],
  [PhiCmsVisibilityContext.AdminArea, "admin"],
  [PhiCmsVisibilityContext.EditorArea, "editor"],
  [PhiCmsVisibilityContext.AccountingArea, "accounting"],
  [PhiCmsVisibilityContext.BuilderArea, "builder"],
]);

const AUTH_PRESET_AREAS = [
  { area: "public", areaMask: PhiCmsVisibilityContext.PublicArea },
  { area: "app", areaMask: PhiCmsVisibilityContext.AppArea },
  { area: "admin", areaMask: PhiCmsVisibilityContext.AdminArea },
] as const;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function restoreFirstPartyAuthInAreaTree(tree: Record<string, unknown>) {
  const preset = toRecord(tree.preset);
  const config = toRecord(preset.config);
  const modules = toRecord(config[PHI_AREA_CONFIG_MODULES_NAMESPACE]);
  const currentModuleIds = Array.isArray(modules.runtimeModules)
    ? modules.runtimeModules.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const previousProviderModuleId = typeof modules.authUiProviderModuleId === "string"
    ? modules.authUiProviderModuleId.trim()
    : null;
  const removedProviderModuleIds = previousProviderModuleId && previousProviderModuleId !== PHI_FIRST_PARTY_AUTH_UI_MODULE_ID
    ? [previousProviderModuleId]
    : [];
  // Selection order is preserved. Activation is a set question, so reordering an already correct
  // selection would write a revision that changes nothing -- and the contract calls this operation
  // idempotent. Only a genuinely missing activation is inserted, and it goes first because that is
  // where the first-party provider has always sat.
  const retainedModuleIds = currentModuleIds.filter(
    (moduleId) => !removedProviderModuleIds.includes(moduleId),
  );
  const runtimeModules = retainedModuleIds.includes(PHI_FIRST_PARTY_AUTH_UI_MODULE_ID)
    ? retainedModuleIds
    : [PHI_FIRST_PARTY_AUTH_UI_MODULE_ID, ...retainedModuleIds];
  const changed = previousProviderModuleId !== PHI_FIRST_PARTY_AUTH_UI_MODULE_ID ||
    runtimeModules.length !== currentModuleIds.length ||
    runtimeModules.some((moduleId, index) => moduleId !== currentModuleIds[index]);

  return {
    tree: {
      ...tree,
      preset: {
        ...preset,
        config: {
          ...config,
          [PHI_AREA_CONFIG_MODULES_NAMESPACE]: {
            ...modules,
            runtimeModules,
            authUiProviderModuleId: PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
          },
        },
      },
    },
    activated: !currentModuleIds.includes(PHI_FIRST_PARTY_AUTH_UI_MODULE_ID),
    changed,
    removedProviderModuleIds,
    runtimeModules,
  };
}

async function clonePatchedRevision(
  client: PoolClient,
  revisionId: number,
  areaScopeId: number,
) {
  const { rows } = await client.query<{
    flags: number;
    tree_json: Record<string, unknown>;
    meta_json: Record<string, unknown> | null;
  }>(
    `SELECT flags, tree_json, meta_json
     FROM phis.site_area_revisions
     WHERE id = $1 AND area_scope_id = $2
     LIMIT 1`,
    [revisionId, areaScopeId],
  );
  const revision = rows[0];
  if (!revision) throw new Error(`Area revision #${revisionId} no longer exists.`);
  const patched = restoreFirstPartyAuthInAreaTree(revision.tree_json ?? {});
  if (!patched.changed) {
    return { revisionId, ...patched };
  }
  const { rows: inserted } = await client.query<{ id: number }>(
    `INSERT INTO phis.site_area_revisions (
       area_scope_id, flags, tree_json, message, meta_json, source_revision_id, created_by_user_id
     ) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, NULL)
     RETURNING id`,
    [
      areaScopeId,
      revision.flags,
      JSON.stringify(patched.tree),
      "Restored first-party Auth UI preset with phis-cli",
      JSON.stringify({
        ...toRecord(revision.meta_json),
        authPresetRestore: {
          moduleId: PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
          restoredAt: new Date().toISOString(),
          removedProviderModuleIds: patched.removedProviderModuleIds,
        },
      }),
      revisionId,
    ],
  );
  return { revisionId: inserted[0]!.id, ...patched };
}

type AuthProviderObservation = {
  area: string;
  areaMask: number;
  revisionId: number;
  pointer: "published" | "draft";
  providerModuleId: string | null;
  activated: boolean;
};

function resolveAuthPresetAreaName(areaMask: number) {
  return AREA_NAME_BY_MASK.get(areaMask) ?? `area-${areaMask}`;
}

/**
 * Reads back what the Site now says about its Auth UI provider, one entry per effective revision.
 *
 * The control plane holds no Module metadata, so this cannot ask which Modules are Auth UI providers.
 * What it can do is read the value the Builder materialized into every Area preset, which is exactly
 * the value the runtime resolves the login surface from.
 */
async function observeAuthUiProviders(client: PoolClient, siteId: number) {
  const { rows: scopes } = await client.query<{
    area_id: number;
    published_revision_id: number | null;
    working_draft_revision_id: number | null;
  }>(
    `SELECT area_id, published_revision_id, working_draft_revision_id
     FROM phis.site_area_scopes
     WHERE site_id = $1`,
    [siteId],
  );

  const observations: AuthProviderObservation[] = [];
  for (const scope of scopes) {
    for (const [pointer, revisionId] of [
      ["published", scope.published_revision_id],
      ["draft", scope.working_draft_revision_id],
    ] as const) {
      if (revisionId == null) continue;
      const { rows } = await client.query<{
        provider_module_id: string | null;
        runtime_modules: unknown;
      }>(
        `SELECT tree_json #>> '{preset,config,modules,authUiProviderModuleId}' AS provider_module_id,
                tree_json #>  '{preset,config,modules,runtimeModules}'          AS runtime_modules
         FROM phis.site_area_revisions
         WHERE id = $1
         LIMIT 1`,
        [revisionId],
      );
      const row = rows[0];
      if (!row) continue;
      const runtimeModules = Array.isArray(row.runtime_modules) ? row.runtime_modules : [];
      observations.push({
        area: resolveAuthPresetAreaName(scope.area_id),
        areaMask: scope.area_id,
        revisionId,
        pointer,
        providerModuleId: row.provider_module_id?.trim() || null,
        activated: runtimeModules.includes(PHI_FIRST_PARTY_AUTH_UI_MODULE_ID),
      });
    }
  }
  return observations;
}

export async function restoreFirstPartyAuthPreset(pool: Pool, siteKeyInput: string) {
  const siteKey = siteKeyInput.trim().toLowerCase();
  if (!siteKey) throw new Error("Missing --site.");
  return withPoolTransaction(pool, async (client) => {
    const { rows: sites } = await client.query<{ id: number; key: string }>(
      `SELECT id, key FROM phis.sites WHERE key = $1 LIMIT 1 FOR UPDATE`,
      [siteKey],
    );
    const site = sites[0];
    if (!site) throw new Error(`Site ${siteKey} does not exist.`);

    const areas = [];
    for (const target of AUTH_PRESET_AREAS) {
      const { rows: scopes } = await client.query<{
        id: number;
        published_revision_id: number | null;
        working_draft_revision_id: number | null;
      }>(
        `SELECT id, published_revision_id, working_draft_revision_id
         FROM phis.site_area_scopes
         WHERE site_id = $1 AND area_id = $2
         LIMIT 1 FOR UPDATE`,
        [site.id, target.areaMask],
      );
      const scope = scopes[0];
      if (!scope || (!scope.published_revision_id && !scope.working_draft_revision_id)) {
        areas.push({
          area: target.area,
          source: "code-preset" as const,
          activated: false,
          changed: false,
          removedProviderModuleIds: [] as string[],
          publishedRevisionId: scope?.published_revision_id ?? null,
          workingDraftRevisionId: scope?.working_draft_revision_id ?? null,
        });
        continue;
      }

      const cloned = new Map<number, Awaited<ReturnType<typeof clonePatchedRevision>>>();
      for (const revisionId of new Set([
        scope.published_revision_id,
        scope.working_draft_revision_id,
      ].filter((value): value is number => value != null))) {
        cloned.set(revisionId, await clonePatchedRevision(client, revisionId, scope.id));
      }
      const published = scope.published_revision_id ? cloned.get(scope.published_revision_id)! : null;
      const draft = scope.working_draft_revision_id ? cloned.get(scope.working_draft_revision_id)! : null;
      await client.query(
        `UPDATE phis.site_area_scopes
         SET published_revision_id = $2, working_draft_revision_id = $3, updated_at = NOW()
         WHERE id = $1`,
        [scope.id, published?.revisionId ?? null, draft?.revisionId ?? null],
      );
      areas.push({
        area: target.area,
        source: "site-revision" as const,
        activated: Boolean(published?.activated || draft?.activated),
        changed: Boolean(published?.changed || draft?.changed),
        removedProviderModuleIds: Array.from(new Set([
          ...(published?.removedProviderModuleIds ?? []),
          ...(draft?.removedProviderModuleIds ?? []),
        ])),
        publishedRevisionId: published?.revisionId ?? null,
        workingDraftRevisionId: draft?.revisionId ?? null,
      });
    }

    const { rows: authPageScopes } = await client.query<{
      id: number;
      area_id: number;
      preset_key: string;
      tombstoned_at: Date | string | null;
      published_revision_id: number | null;
      working_draft_revision_id: number | null;
    }>(
      `SELECT id, area_id, preset_key, tombstoned_at, published_revision_id, working_draft_revision_id
       FROM phis.site_page_scopes
       WHERE site_id = $1 AND owner_module_id = $2
       FOR UPDATE`,
      [site.id, PHI_FIRST_PARTY_AUTH_UI_MODULE_ID],
    );
    const pagePresets = [];
    for (const scope of authPageScopes) {
      // The tombstone travels with the pointers. It mirrors a deleted revision rather than carrying
      // its own state, so leaving it behind would render the code preset again while every catalog
      // that reads the scope keeps calling the page deleted.
      const wasTombstoned = scope.tombstoned_at != null;
      const changed = wasTombstoned ||
        scope.published_revision_id != null ||
        scope.working_draft_revision_id != null;
      if (changed) {
        await client.query(
          `UPDATE phis.site_page_scopes
           SET published_revision_id = NULL,
               working_draft_revision_id = NULL,
               tombstoned_at = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [scope.id],
        );
      }
      pagePresets.push({
        area: resolveAuthPresetAreaName(scope.area_id),
        presetKey: scope.preset_key,
        changed,
        restoredFromDeleted: wasTombstoned,
        previousPublishedRevisionId: scope.published_revision_id,
        previousWorkingDraftRevisionId: scope.working_draft_revision_id,
      });
    }

    // Verify before committing. A recovery command that reports success while /login stays unowned
    // is worse than one that refuses: the operator stops looking.
    const observations = await observeAuthUiProviders(client, site.id);
    const publicObservations = observations.filter((entry) => entry.areaMask === PUBLIC_AREA_MASK);
    const unresolvedPublic = publicObservations.filter(
      (entry) => entry.providerModuleId !== PHI_FIRST_PARTY_AUTH_UI_MODULE_ID || !entry.activated,
    );
    if (unresolvedPublic.length > 0) {
      const detail = unresolvedPublic
        .map((entry) => `${entry.pointer} revision #${entry.revisionId} names ${entry.providerModuleId ?? "no provider"}`)
        .join("; ");
      throw new Error(
        `Public has no active canonical /login owner after the restore (${detail}). ` +
        "Nothing was changed. Publish the Public Area from the Builder with " +
        `${PHI_FIRST_PARTY_AUTH_UI_MODULE_ID} activated, then run this command again.`,
      );
    }

    const foreignProviders = Array.from(new Set(
      observations
        .filter((entry) => entry.providerModuleId != null &&
          entry.providerModuleId !== PHI_FIRST_PARTY_AUTH_UI_MODULE_ID)
        .map((entry) => `${entry.area}: ${entry.providerModuleId}`),
    ));
    const warnings = [
      ...(publicObservations.length === 0
        ? ["Public carries no Site revision; the installed code preset decides the login owner and cannot be verified from the control plane."]
        : []),
      ...(foreignProviders.length > 0
        ? [`Another Auth UI provider stays active outside Public, Admin and App -- ${foreignProviders.join(", ")}. This command does not touch those Areas.`]
        : []),
    ];

    return {
      ok: true,
      action: "auth.restore-preset",
      site: site.key,
      moduleId: PHI_FIRST_PARTY_AUTH_UI_MODULE_ID,
      publicLoginOwner: publicObservations.length === 0
        ? ("code-preset" as const)
        : ("site-revision" as const),
      areas,
      pagePresets,
      warnings,
    };
  });
}
