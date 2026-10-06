import "server-only";

import type { PoolClient } from "pg";

import {
  PhiCmsReferenceSourceKind,
  pruneSiteCmsReferencesToLiveRevisionsWithDb,
  replaceSiteCmsReferencesWithDb,
  type SiteCmsReferenceWrite,
} from "@/db/site-cms-references";
import { hasPhiFlag } from "@/lib/helpers/flags";
import { isPhiRecord, toPhiRecord } from "@/lib/helpers/record";
import { PhiCmsRevisionFlags } from "@phis/contracts/cms";
import { phiPrepared } from "@/lib/db-prepared";

/*
 * The draft/publish revision machine every authored scope kind shares: a scope row holding a published
 * and a Working Draft pointer, and an append-only revision table beneath it. Areas, Pages, Navigations
 * and Themes differ in how a scope is addressed and in what their trees mean, not in how revisions are
 * stored, pointed at and published; that part lives here once, and each kind names its tables through
 * a descriptor instead of carrying its own copy of the same queries.
 */

type DbQueryable = Pick<PoolClient, "query">;

export type SiteRevisionKind = "area" | "page" | "navigation" | "theme";

export type SiteRevisionTable = {
  kind: SiteRevisionKind;
  /** How messages name the kind, capitalised as a sentence starts. */
  label: "Area" | "Page" | "Navigation" | "Theme";
  scopeTable: "site_area_scopes" | "site_page_scopes" | "site_nav_scopes" | "site_theme_scopes";
  revisionTable:
    | "site_area_revisions"
    | "site_page_revisions"
    | "site_nav_revisions"
    | "site_theme_revisions";
  scopeColumn: "area_scope_id" | "page_scope_id" | "nav_scope_id" | "theme_scope_id";
  referenceSourceKind: PhiCmsReferenceSourceKind;
  /**
   * Whether the revision row numbers its nodes in a column of its own. Only a Navigation does; Pages
   * and Areas keep their sequence in `meta_json.draft`, and a Theme has no nodes to number.
   */
  sequenced: boolean;
  /**
   * Whether the trees hold Content widgets, whose rows a removed revision may leave unused. Only Area
   * and Page trees do, so only their removals sweep orphaned Content.
   */
  carriesContent: boolean;
};

export const SITE_REVISION_TABLES = {
  area: {
    kind: "area",
    label: "Area",
    scopeTable: "site_area_scopes",
    revisionTable: "site_area_revisions",
    scopeColumn: "area_scope_id",
    referenceSourceKind: PhiCmsReferenceSourceKind.Area,
    sequenced: false,
    carriesContent: true,
  },
  page: {
    kind: "page",
    label: "Page",
    scopeTable: "site_page_scopes",
    revisionTable: "site_page_revisions",
    scopeColumn: "page_scope_id",
    referenceSourceKind: PhiCmsReferenceSourceKind.Page,
    sequenced: false,
    carriesContent: true,
  },
  navigation: {
    kind: "navigation",
    label: "Navigation",
    scopeTable: "site_nav_scopes",
    revisionTable: "site_nav_revisions",
    scopeColumn: "nav_scope_id",
    referenceSourceKind: PhiCmsReferenceSourceKind.Navigation,
    sequenced: true,
    carriesContent: false,
  },
  theme: {
    kind: "theme",
    label: "Theme",
    scopeTable: "site_theme_scopes",
    revisionTable: "site_theme_revisions",
    scopeColumn: "theme_scope_id",
    referenceSourceKind: PhiCmsReferenceSourceKind.Theme,
    sequenced: false,
    carriesContent: false,
  },
} as const satisfies Record<SiteRevisionKind, SiteRevisionTable>;

export type SiteRevisionRecord = {
  id: number;
  scopeId: number;
  flags: number;
  treeJson: Record<string, unknown>;
  message: string | null;
  metaJson: Record<string, unknown>;
  sourceRevisionId: number | null;
  createdByUserId: number | null;
  createdAt: string;
};

export type SiteSequencedRevisionRecord = SiteRevisionRecord & { nextNodeSequence: number };

/**
 * The record a table's revisions read as: a sequenced table's carry their node sequence too, and a
 * table not known until run time may or may not.
 */
export type SiteRevisionRecordOf<TTable extends SiteRevisionTable> = TTable["sequenced"] extends true
  ? SiteSequencedRevisionRecord
  : TTable["sequenced"] extends false
    ? SiteRevisionRecord
    : SiteRevisionRecord & { nextNodeSequence?: number };

/**
 * A request to publish a revision other than the Working Draft, or a Draft write against a Draft that
 * changed meanwhile. Routes answer it with 409: the caller acted on a state that no longer stands.
 */
export class SiteCmsDraftConflictError extends Error {
  readonly code = "cms_draft_conflict";

  constructor(message: string) {
    super(message);
    this.name = "SiteCmsDraftConflictError";
  }
}

/**
 * The one conflict a client is meant to run into: an Area nobody has saved yet has no revision for a
 * Module selection to patch, and the Builder answers by sending the Area's code-owned Shell as
 * `baseline`. A step of the first save rather than its failure, and logged as one.
 */
export class SiteCmsAreaBaselineRequiredError extends SiteCmsDraftConflictError {
  constructor() {
    super("This Area has no stored revision yet, so a Module selection needs its Shell baseline.");
    this.name = "SiteCmsAreaBaselineRequiredError";
  }
}

/**
 * JSON with its object keys sorted, so two trees compare equal whenever they hold the same data. What a
 * revision summary compares to tell a real change from a save of the same state.
 */
export function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (isPhiRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Refuses a publish that names a revision other than the scope's Working Draft.
 *
 * Every publish clears the Draft pointer it publishes from. Naming an older revision therefore threw the
 * Draft away without a word, and naming the Area's Module Draft on a structure publish made one revision
 * both Draft and live. The published revision itself may be named again while no Draft is open: that
 * is a retry of the publish that already happened, and it drops nothing.
 */
export function assertPublishesWorkingDraft(
  requestedRevisionId: number | null | undefined,
  scope: { workingDraftRevisionId: number | null; publishedRevisionId: number | null },
  scopeLabel: string,
) {
  const republish =
    scope.workingDraftRevisionId == null && requestedRevisionId === scope.publishedRevisionId;
  if (requestedRevisionId == null || requestedRevisionId === scope.workingDraftRevisionId || republish) {
    return;
  }
  throw new SiteCmsDraftConflictError(
    `Revision #${requestedRevisionId} is not the ${scopeLabel} Working Draft; restore it to publish it.`,
  );
}

type SiteRevisionRow = {
  id: number;
  scope_id: number;
  flags: number;
  next_node_sequence?: string | number;
  tree_json: Record<string, unknown> | null;
  message: string | null;
  meta_json: Record<string, unknown> | null;
  source_revision_id: number | null;
  created_by_user_id: number | null;
  created_at: string;
};

function selectSiteRevisionColumns(table: SiteRevisionTable) {
  return `id, ${table.scopeColumn} AS scope_id, flags,${table.sequenced ? " next_node_sequence," : ""}
          tree_json, message, meta_json, source_revision_id, created_by_user_id, created_at`;
}

function mapSiteRevisionRow<TTable extends SiteRevisionTable>(
  table: TTable,
  row: SiteRevisionRow,
): SiteRevisionRecordOf<TTable> {
  const record: SiteRevisionRecord = {
    id: row.id,
    scopeId: row.scope_id,
    flags: row.flags,
    treeJson: toPhiRecord(row.tree_json),
    message: row.message,
    metaJson: toPhiRecord(row.meta_json),
    sourceRevisionId: row.source_revision_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
  // The one place the descriptor decides the record's shape; the column is selected exactly when set.
  return (table.sequenced
    ? { ...record, nextNodeSequence: Number(row.next_node_sequence) }
    : record) as SiteRevisionRecordOf<TTable>;
}

export async function getSiteRevisionByIdWithDb<TTable extends SiteRevisionTable>(
  db: DbQueryable,
  table: TTable,
  revisionId: number,
): Promise<SiteRevisionRecordOf<TTable> | null> {
  const { rows } = await db.query<SiteRevisionRow>(phiPrepared(
    `SELECT ${selectSiteRevisionColumns(table)}
     FROM phis.${table.revisionTable}
     WHERE id = $1
     LIMIT 1`,
    [revisionId],
  ));
  return rows[0] ? mapSiteRevisionRow(table, rows[0]) : null;
}

export async function insertSiteRevisionWithDb<TTable extends SiteRevisionTable>(
  db: DbQueryable,
  table: TTable,
  input: {
    scopeId: number;
    flags: number;
    treeJson: Record<string, unknown>;
    message?: string | null;
    metaJson?: Record<string, unknown> | null;
    sourceRevisionId?: number | null;
    createdByUserId?: number | null;
    /** Required by a sequenced table, and meaningless to any other. */
    nextNodeSequence?: number;
  },
): Promise<SiteRevisionRecordOf<TTable>> {
  if (table.sequenced !== (input.nextNodeSequence !== undefined)) {
    const rule = table.sequenced ? "need" : "take no";
    throw new Error(`${table.label} revisions ${rule} nextNodeSequence.`);
  }
  const values: unknown[] = [
    input.scopeId,
    input.flags,
    JSON.stringify(input.treeJson),
    input.message ?? null,
    JSON.stringify(input.metaJson ?? {}),
    input.sourceRevisionId ?? null,
    input.createdByUserId ?? null,
  ];
  if (table.sequenced) {
    values.push(input.nextNodeSequence);
  }
  const { rows } = await db.query<SiteRevisionRow>(
    `INSERT INTO phis.${table.revisionTable} (
       ${table.scopeColumn}, flags, tree_json, message, meta_json, source_revision_id, created_by_user_id
       ${table.sequenced ? ", next_node_sequence" : ""}
     )
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7${table.sequenced ? ", $8" : ""})
     RETURNING ${selectSiteRevisionColumns(table)}`,
    values,
  );
  return mapSiteRevisionRow(table, rows[0]!);
}

/**
 * Rewrites the scope's open Working Draft in place. A Draft that is gone by now was discarded or
 * published by another writer, and this save acted on a state that no longer stands.
 *
 * The row keeps its `created_at`, so every rewrite stamps `meta_json.saved` with when and by whom it
 * was saved last: that is what the revision list shows next to the message.
 */
export async function updateSiteDraftRevisionWithDb<TTable extends SiteRevisionTable>(
  db: DbQueryable,
  table: TTable,
  revisionId: number,
  scopeId: number,
  input: {
    flags: number;
    treeJson: Record<string, unknown>;
    message?: string | null;
    metaJson: Record<string, unknown>;
    savedByUserId: number | null;
  },
): Promise<SiteRevisionRecordOf<TTable>> {
  const { rows } = await db.query<SiteRevisionRow>(
    `UPDATE phis.${table.revisionTable}
     SET flags = $3,
         tree_json = $4::jsonb,
         message = $5,
         meta_json = $6::jsonb || jsonb_build_object(
           'saved', jsonb_build_object('at', NOW(), 'byUserId', $7::int)
         )
     WHERE id = $1
       AND ${table.scopeColumn} = $2
     RETURNING ${selectSiteRevisionColumns(table)}`,
    [
      revisionId,
      scopeId,
      input.flags,
      JSON.stringify(input.treeJson),
      input.message ?? null,
      JSON.stringify(input.metaJson),
      input.savedByUserId,
    ],
  );
  const row = rows[0];
  if (!row) {
    throw new SiteCmsDraftConflictError(`Working Draft revision #${revisionId} no longer exists.`);
  }
  return mapSiteRevisionRow(table, row);
}

/**
 * Moves a scope's published and Working Draft pointers, then drops the reference rows of revisions no
 * pointer names any more. An Area's Module draft pointer is not touched here; the Area moves that one
 * in its own statement, because only its scope row has it.
 */
export async function setSiteRevisionScopePointersWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
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
  table: SiteRevisionTable,
  scopeId: number,
) {
  await pruneSiteCmsReferencesToLiveRevisionsWithDb(db, {
    sourceKind: table.referenceSourceKind,
    sourceScopeId: scopeId,
  });
}

/** Indexes what one revision of the scope references, replacing that revision's earlier rows. */
export async function replaceSiteRevisionReferencesWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
  input: {
    siteId: number;
    scopeId: number;
    revisionId: number;
    references: readonly SiteCmsReferenceWrite[];
  },
) {
  await replaceSiteCmsReferencesWithDb(db, {
    siteId: input.siteId,
    sourceKind: table.referenceSourceKind,
    sourceScopeId: input.scopeId,
    sourceRevisionId: input.revisionId,
    references: input.references,
  });
}

/** Adds the Published flag to a revision whose tree goes live unchanged. */
export async function markSiteRevisionPublishedWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
  revision: Pick<SiteRevisionRecord, "id" | "flags">,
) {
  if (hasPhiFlag(revision.flags, PhiCmsRevisionFlags.Published)) {
    return;
  }
  await db.query(
    `UPDATE phis.${table.revisionTable}
     SET flags = flags | $2
     WHERE id = $1`,
    [revision.id, PhiCmsRevisionFlags.Published],
  );
}

/**
 * Stores the tree a publish materialised in place of the Draft's own, with the flags it goes live
 * with. Pages and Areas publish a validated, merged tree rather than the stored one.
 */
export async function writePublishedSiteRevisionWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
  revisionId: number,
  input: { flags: number; treeJson: Record<string, unknown> },
) {
  await db.query(
    `UPDATE phis.${table.revisionTable}
     SET flags = $2,
         tree_json = $3::jsonb
     WHERE id = $1`,
    [revisionId, input.flags, input.treeJson],
  );
}

/**
 * Deletes revisions of one scope and answers with the trees they held, so a kind whose trees carry
 * Content can sweep what the removal left unused. Ids of another scope are not deleted and not counted.
 */
export async function deleteSiteRevisionsWithDb(
  db: DbQueryable,
  table: SiteRevisionTable,
  scopeId: number,
  revisionIds: readonly number[],
): Promise<{ deletedCount: number; trees: Record<string, unknown>[] }> {
  const result = await db.query<{ tree_json: Record<string, unknown> }>(
    `DELETE FROM phis.${table.revisionTable}
     WHERE id = ANY($1::int[])
       AND ${table.scopeColumn} = $2
     RETURNING tree_json`,
    [revisionIds, scopeId],
  );
  return { deletedCount: result.rowCount ?? 0, trees: result.rows.map((row) => row.tree_json) };
}

/*
 * Scopes addressed by a key alone -- Navigations and Themes. Their scope rows are laid out alike, so
 * they are read, created and listed alike; Pages and Areas are addressed by Area, path or preset and
 * keep their own scope queries.
 */

export type SiteKeyedRevisionTable =
  | typeof SITE_REVISION_TABLES.navigation
  | typeof SITE_REVISION_TABLES.theme;

/** What a keyed Draft save is built on: the scope, and the revision it was in before this save. */
export type SiteKeyedDraftSource<TTable extends SiteKeyedRevisionTable> = {
  scope: SiteKeyedScopeRecord;
  revisionId: number | null;
  revision: SiteRevisionRecordOf<TTable> | null;
};

export type SiteKeyedScopeRecord = {
  id: number;
  siteId: number;
  key: string;
  label: string | null;
  flags: number;
  publishedRevisionId: number | null;
  workingDraftRevisionId: number | null;
};

export type SiteKeyedScopeRow = {
  id: number;
  site_id: number;
  key: string;
  label: string | null;
  flags: number;
  published_revision_id: number | null;
  working_draft_revision_id: number | null;
};

export const SITE_KEYED_SCOPE_COLUMNS =
  "id, site_id, key, label, flags, published_revision_id, working_draft_revision_id";

export function mapSiteKeyedScopeRow(row: SiteKeyedScopeRow): SiteKeyedScopeRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    key: row.key,
    label: row.label,
    flags: row.flags,
    publishedRevisionId: row.published_revision_id,
    workingDraftRevisionId: row.working_draft_revision_id,
  };
}

/** `key` is taken as normalised; each kind has its own rule for that and applies it first. */
export async function getSiteKeyedScopeWithDb(
  db: DbQueryable,
  table: SiteKeyedRevisionTable,
  siteId: number,
  key: string,
  options?: { forUpdate?: boolean },
): Promise<SiteKeyedScopeRecord | null> {
  const { rows } = await db.query<SiteKeyedScopeRow>(
    `SELECT ${SITE_KEYED_SCOPE_COLUMNS}
     FROM phis.${table.scopeTable}
     WHERE site_id = $1 AND key = $2
     LIMIT 1${options?.forUpdate ? "\n     FOR UPDATE" : ""}`,
    [siteId, key],
  );
  return rows[0] ? mapSiteKeyedScopeRow(rows[0]) : null;
}

/** Creates the scope on its first save; a later save keeps the label it has unless it names one. */
export async function upsertSiteKeyedScopeWithDb(
  db: DbQueryable,
  table: SiteKeyedRevisionTable,
  siteId: number,
  input: { key: string; label?: string | null },
): Promise<SiteKeyedScopeRecord> {
  const { rows } = await db.query<SiteKeyedScopeRow>(
    `INSERT INTO phis.${table.scopeTable} (site_id, key, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key)
     DO UPDATE SET label = COALESCE(EXCLUDED.label, phis.${table.scopeTable}.label)
     RETURNING ${SITE_KEYED_SCOPE_COLUMNS}`,
    [siteId, input.key, input.label ?? null],
  );
  return mapSiteKeyedScopeRow(rows[0]!);
}

/** What a new revision says about itself in the history. */
export type SiteKeyedDraftSummary = { message: string; metaJson: Record<string, unknown> };

/**
 * Saves a new Working Draft on a keyed scope: the scope is created if needed, the Draft is built on the
 * scope's current state -- its open Draft, or else what is published -- and its references are indexed
 * in the same transaction, so a rolled-back save leaves no reference behind.
 *
 * `prepare` sees the source revision before anything is written and returns what the new revision
 * says about itself; a kind validates the save against its source there.
 */
export async function saveSiteKeyedDraftRevisionWithDb<TTable extends SiteKeyedRevisionTable>(
  db: DbQueryable,
  table: TTable,
  siteId: number,
  input: {
    key: string;
    label: string;
    treeJson: Record<string, unknown>;
    references: readonly SiteCmsReferenceWrite[];
    createdByUserId: number | null;
    prepare: (
      source: SiteKeyedDraftSource<TTable>,
    ) => Promise<SiteKeyedDraftSummary> | SiteKeyedDraftSummary;
    /** Required by a sequenced table, as for `insertSiteRevisionWithDb`. */
    nextNodeSequence?: number;
  },
) {
  const scope = await upsertSiteKeyedScopeWithDb(db, table, siteId, {
    key: input.key,
    label: input.label,
  });
  const sourceRevisionId = scope.workingDraftRevisionId ?? scope.publishedRevisionId ?? null;
  const sourceRevision = sourceRevisionId == null
    ? null
    : await getSiteRevisionByIdWithDb(db, table, sourceRevisionId);
  const summary = await input.prepare({ scope, revisionId: sourceRevisionId, revision: sourceRevision });
  const revision = await insertSiteRevisionWithDb(db, table, {
    scopeId: scope.id,
    flags: PhiCmsRevisionFlags.Draft,
    nextNodeSequence: input.nextNodeSequence,
    treeJson: input.treeJson,
    message: summary.message,
    metaJson: summary.metaJson,
    sourceRevisionId,
    createdByUserId: input.createdByUserId,
  });
  await setSiteRevisionScopePointersWithDb(db, table, scope.id, {
    publishedRevisionId: scope.publishedRevisionId,
    workingDraftRevisionId: revision.id,
  });
  await replaceSiteRevisionReferencesWithDb(db, table, {
    siteId,
    scopeId: scope.id,
    revisionId: revision.id,
    references: input.references,
  });
  return { scope, sourceRevision, revision };
}

/**
 * Finds the revision a publish of a keyed scope makes live: the one named, or else the open Working
 * Draft. The scope row is held for the rest of the transaction and any revision but the Draft is
 * refused (see `assertPublishesWorkingDraft`), as for Pages and Areas.
 */
export async function selectSiteKeyedRevisionForPublishWithDb<TTable extends SiteKeyedRevisionTable>(
  db: DbQueryable,
  table: TTable,
  siteId: number,
  input: { key: string; revisionId?: number | null },
) {
  const noun = table.label.toLowerCase();
  const scope = await getSiteKeyedScopeWithDb(db, table, siteId, input.key, { forUpdate: true });
  if (!scope) {
    throw new Error(`${table.label} scope not found.`);
  }
  assertPublishesWorkingDraft(input.revisionId, scope, table.label);
  const revisionId = input.revisionId ?? scope.workingDraftRevisionId;
  if (typeof revisionId !== "number" || !Number.isInteger(revisionId) || revisionId <= 0) {
    throw new Error(`No ${noun} draft revision selected for publish.`);
  }
  const revision = await getSiteRevisionByIdWithDb(db, table, revisionId);
  if (!revision || revision.scopeId !== scope.id) {
    throw new Error(`${table.label} draft revision not found.`);
  }
  return { scope, revision };
}

/** Makes the revision the scope's published one and closes the Working Draft. */
export async function publishSiteKeyedRevisionWithDb(
  db: DbQueryable,
  table: SiteKeyedRevisionTable,
  scope: Pick<SiteKeyedScopeRecord, "id">,
  revision: Pick<SiteRevisionRecord, "id" | "flags">,
) {
  await markSiteRevisionPublishedWithDb(db, table, revision);
  await setSiteRevisionScopePointersWithDb(db, table, scope.id, {
    publishedRevisionId: revision.id,
    workingDraftRevisionId: null,
  });
}

/**
 * Discards a keyed scope's Working Draft. A scope that was never published goes with its only Draft,
 * so discarding leaves the Site as it was before the first save. The reference rows that Draft's save
 * indexed are pruned with it: no scope row is left whose pointers could still name them.
 */
export async function discardSiteKeyedDraftRevisionWithDb(
  db: DbQueryable,
  table: SiteKeyedRevisionTable,
  siteId: number,
  input: { key: string },
): Promise<{ deleted: boolean }> {
  const scope = await getSiteKeyedScopeWithDb(db, table, siteId, input.key);
  if (!scope?.workingDraftRevisionId) {
    return { deleted: false };
  }
  await deleteSiteRevisionsWithDb(db, table, scope.id, [scope.workingDraftRevisionId]);
  if (scope.publishedRevisionId == null) {
    await db.query(`DELETE FROM phis.${table.scopeTable} WHERE id = $1`, [scope.id]);
    await pruneSiteRevisionScopeReferencesWithDb(db, table, scope.id);
  } else {
    await setSiteRevisionScopePointersWithDb(db, table, scope.id, {
      publishedRevisionId: scope.publishedRevisionId,
      workingDraftRevisionId: null,
    });
  }
  return { deleted: true };
}
