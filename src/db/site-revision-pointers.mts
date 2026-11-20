import type { PoolClient } from "pg";

/*
 * What moving a Site revision scope's pointers costs the reference index, and nothing else.
 *
 * Kept in a module of its own, free of `server-only` and of the `@/` alias, because the same transaction
 * is run by two callers: the Server's database layer and the `phis page reset` command. The CLI cannot
 * import the `server-only` modules, and a second copy of this SQL would be a second implementation of what
 * a pointer change does. `site-revision-scopes.ts` and `site-cms-references.ts` re-export it.
 */

type DbQueryable = Pick<PoolClient, "query">;

/** The part of a revision table descriptor these statements read. */
export type SiteRevisionPointerTable = {
  scopeTable: string;
  referenceSourceKind: PhiCmsReferenceSourceKind;
};

export const PhiCmsReferenceSourceKind = {
  Page: 1,
  Navigation: 2,
  Content: 3,
  Area: 4,
  Theme: 5,
} as const;

export type PhiCmsReferenceSourceKind = typeof PhiCmsReferenceSourceKind[keyof typeof PhiCmsReferenceSourceKind];

/**
 * The pointers that keep a revision live, per source that has revisions.
 *
 * A scope's references are kept per revision because more than one revision is live at a time: the
 * published one and the working draft. An Area's Module selection has pointers of its own, but its
 * revisions hold `config.modules` and nothing a reference can sit in, so they index nothing and are not
 * listed here: the structure pointers are the ones whose revisions reference anything. The readers count rows
 * whose revision is one of these; so a write replaces its own revision's rows and leaves the others
 * standing, and a row falls when no pointer names its revision any more -- it would still hold its
 * target under the `RESTRICT` foreign keys while no reader counted it. Content has versions rather than
 * revisions, and only its latest version is live, so its set is still replaced whole.
 */
export const LIVE_REVISION_POINTERS: Partial<Record<PhiCmsReferenceSourceKind, {
  table: string;
  columns: readonly string[];
}>> = {
  [PhiCmsReferenceSourceKind.Page]: {
    table: "phis.site_page_scopes",
    columns: ["published_revision_id", "working_draft_revision_id"],
  },
  [PhiCmsReferenceSourceKind.Navigation]: {
    table: "phis.site_nav_scopes",
    columns: ["published_revision_id", "working_draft_revision_id"],
  },
  [PhiCmsReferenceSourceKind.Area]: {
    table: "phis.site_area_scopes",
    columns: ["published_revision_id", "working_draft_revision_id"],
  },
  [PhiCmsReferenceSourceKind.Theme]: {
    table: "phis.site_theme_scopes",
    columns: ["published_revision_id", "working_draft_revision_id"],
  },
};

/**
 * Drops the rows of revisions no pointer of the scope names any more. Called after every pointer change
 * and before every write; `keepRevisionId` spares the revision a write is about to point at, which a
 * draft save indexes before it moves the pointer.
 */
export async function pruneSiteCmsReferencesToLiveRevisionsWithDb(
  db: DbQueryable,
  input: {
    sourceKind: PhiCmsReferenceSourceKind;
    sourceScopeId: number;
    keepRevisionId?: number | null;
  },
) {
  const live = LIVE_REVISION_POINTERS[input.sourceKind];
  if (!live) return;
  const pointers = live.columns.map((column) => `scope.${column}`).join(", ");
  await db.query(
    `DELETE FROM phis.site_cms_references ref
     WHERE ref.source_kind = $1 AND ref.source_scope_id = $2
       AND ref.source_revision_id IS NOT NULL
       AND ref.source_revision_id IS DISTINCT FROM $3::integer
       AND NOT EXISTS (
         SELECT 1 FROM ${live.table} scope
         WHERE scope.id = ref.source_scope_id AND scope.site_id = ref.site_id
           AND ref.source_revision_id IN (${pointers})
       )`,
    [input.sourceKind, input.sourceScopeId, input.keepRevisionId ?? null],
  );
}

/**
 * Moves a scope's published and Working Draft pointers, then drops the reference rows of revisions no
 * pointer names any more. An Area's Module pointers are not touched here; the Area moves those in its
 * own statement, because only its scope row has them.
 */
export async function setSiteRevisionScopePointersWithDb(
  db: DbQueryable,
  table: SiteRevisionPointerTable,
  scopeId: number,
  input: {
    publishedRevisionId: number | null;
    workingDraftRevisionId: number | null;
  },
) {
  await db.query(
    `UPDATE phis.${table.scopeTable}
     SET published_revision_id = $2,
         working_draft_revision_id = $3,
         updated_at = NOW()
     WHERE id = $1`,
    [scopeId, input.publishedRevisionId, input.workingDraftRevisionId],
  );
  await pruneSiteRevisionScopeReferencesWithDb(db, table, scopeId);
}

/** After a revision stopped being live or was deleted: its reference rows go with it. */
export async function pruneSiteRevisionScopeReferencesWithDb(
  db: DbQueryable,
  table: SiteRevisionPointerTable,
  scopeId: number,
) {
  await pruneSiteCmsReferencesToLiveRevisionsWithDb(db, {
    sourceKind: table.referenceSourceKind,
    sourceScopeId: scopeId,
  });
}
