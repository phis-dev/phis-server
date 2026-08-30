import "server-only";

import { getPool } from "@/lib/db";
import {
  parsePhiFormDescriptor,
  type PhiFormDescriptor,
} from "@/lib/form-descriptor";

export const FORM_DEFINITION_FLAG_REQUIRES_GUARD = 1 << 0;
export const FORM_DEFINITION_STATUS_WORKING_DRAFT = 0;
export const FORM_DEFINITION_STATUS_PUBLISHED = 1;
export const FORM_DEFINITION_STATUS_ARCHIVED = 2;

type FormDefinitionRow = {
  id: number;
  site_id: number;
  owner_module_id: string;
  form_id: string;
  version: number;
  status: number;
  flags: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  descriptor: unknown;
  submit_handler_key: string | null;
  confirm_handler_key: string | null;
  preview_handler_key: string | null;
  default_config: Record<string, unknown> | null;
  variant: string | null;
  config: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type FormDefinitionRecord = {
  id: number;
  siteId: number;
  ownerModuleId: string;
  formId: string;
  version: number;
  status: number;
  flags: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[];
  descriptor: PhiFormDescriptor;
  submitHandlerKey: string | null;
  confirmHandlerKey: string | null;
  previewHandlerKey: string | null;
  defaultConfig: Record<string, unknown>;
  variant: string | null;
  config: Record<string, unknown>;
  previewUpstreamPath: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublishFormDefinitionInput = {
  siteId: number;
  ownerModuleId: string;
  formId: string;
  expectedPublishedVersion?: number | null;
  flags?: number;
  title: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  descriptor: PhiFormDescriptor;
  submitHandlerKey?: string | null;
  confirmHandlerKey?: string | null;
  previewHandlerKey?: string | null;
  defaultConfig?: Record<string, unknown>;
  variant?: string | null;
  config?: Record<string, unknown>;
};

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function isNamespacedFormId(value: string) {
  return /^@[^/]+\/[^/]+\/forms\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(value);
}

function mapFormDefinitionRow(row: FormDefinitionRow): FormDefinitionRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    ownerModuleId: row.owner_module_id,
    formId: row.form_id,
    version: row.version,
    status: row.status,
    flags: row.flags,
    title: row.title,
    description: row.description,
    category: row.category,
    tags: row.tags ?? [],
    descriptor: parsePhiFormDescriptor(row.descriptor),
    submitHandlerKey: row.submit_handler_key,
    confirmHandlerKey: row.confirm_handler_key,
    previewHandlerKey: row.preview_handler_key,
    defaultConfig: row.default_config ?? {},
    variant: row.variant,
    config: row.config ?? {},
    previewUpstreamPath: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const publishedFormDefinitionCache = new Map<string, FormDefinitionRecord | null>();
const publishedFormDefinitionsBySiteCache = new Map<number, FormDefinitionRecord[] | null>();

function buildFormDefinitionCacheKey(siteId: number, formId: string) {
  return `${siteId}:${normalizeKey(formId)}`;
}

export function clearFormDefinitionCache(siteId?: number, formId?: string) {
  if (typeof siteId === "number" && Number.isInteger(siteId) && siteId > 0) {
    if (typeof formId === "string" && formId.trim()) {
      publishedFormDefinitionCache.delete(buildFormDefinitionCacheKey(siteId, formId));
      publishedFormDefinitionsBySiteCache.delete(siteId);
      return;
    }
    publishedFormDefinitionsBySiteCache.delete(siteId);
    for (const key of publishedFormDefinitionCache.keys()) {
      if (key.startsWith(`${siteId}:`)) {
        publishedFormDefinitionCache.delete(key);
      }
    }
    return;
  }
  publishedFormDefinitionCache.clear();
  publishedFormDefinitionsBySiteCache.clear();
}

const FORM_DEFINITION_COLUMNS = `id,
  site_id,
  owner_module_id,
  form_id,
  version,
  status,
  flags,
  title,
  description,
  category,
  tags,
  descriptor,
  submit_handler_key,
  confirm_handler_key,
  preview_handler_key,
  default_config,
  variant,
  config,
  created_at,
  updated_at`;

export async function getPublishedFormDefinitionBySiteIdAndFormId(siteId: number, formId: string) {
  const normalizedFormId = normalizeKey(formId);
  if (!isNamespacedFormId(normalizedFormId)) {
    return null;
  }
  const cacheKey = buildFormDefinitionCacheKey(siteId, normalizedFormId);
  if (publishedFormDefinitionCache.has(cacheKey)) {
    return publishedFormDefinitionCache.get(cacheKey) ?? null;
  }

  const { rows } = await getPool().query<FormDefinitionRow>(
    `SELECT ${FORM_DEFINITION_COLUMNS}
     FROM phis.form_definitions
     WHERE site_id = $1
       AND form_id = $2
       AND status = $3
     LIMIT 1`,
    [siteId, normalizedFormId, FORM_DEFINITION_STATUS_PUBLISHED],
  );
  const definition = rows[0] ? mapFormDefinitionRow(rows[0]) : null;
  publishedFormDefinitionCache.set(cacheKey, definition);
  return definition;
}

export async function listPublishedFormDefinitionsBySiteId(siteId: number) {
  if (publishedFormDefinitionsBySiteCache.has(siteId)) {
    return publishedFormDefinitionsBySiteCache.get(siteId) ?? [];
  }
  const { rows } = await getPool().query<FormDefinitionRow>(
    `SELECT ${FORM_DEFINITION_COLUMNS}
     FROM phis.form_definitions
     WHERE site_id = $1
       AND status = $2
     ORDER BY form_id ASC`,
    [siteId, FORM_DEFINITION_STATUS_PUBLISHED],
  );
  const definitions = rows.map(mapFormDefinitionRow);
  publishedFormDefinitionsBySiteCache.set(siteId, definitions);
  for (const definition of definitions) {
    publishedFormDefinitionCache.set(
      buildFormDefinitionCacheKey(siteId, definition.formId),
      definition,
    );
  }
  return definitions;
}
