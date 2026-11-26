/**
 * `phis media import`: what the CLI sends and what Core answers (docs/CLI.md, "Media import").
 *
 * Pure, and importable by both sides, as `module-media.ts` is for the Module packages' media. Nothing here
 * touches a file, the database or the network.
 *
 * One file per request, its bytes as the raw body with their length stated, so a file the size of the
 * Site's object limit is streamed to the Storage Provider instead of held. The texts travel in the query,
 * the Folder is resolved to an id once before the first file (`/api/v1/media/import/folder`).
 */

import { PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH, PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH } from "./module-media.ts";

export const PHIS_MEDIA_IMPORT_ROUTE = "/api/v1/media/import";
export const PHIS_MEDIA_IMPORT_FOLDER_ROUTE = "/api/v1/media/import/folder";

/** `media_assets.alt_text`, `title` and `original_name`, as for a Module's file. */
export const PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH = PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH;
/** `media_folders.name`, as for a Module's folder. */
export const PHIS_MEDIA_IMPORT_FOLDER_NAME_MAX_LENGTH = PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH;
/** Deeper than any library is organised, and a bound on the walk. */
export const PHIS_MEDIA_IMPORT_FOLDER_DEPTH_MAX = 16;

/** The query of `POST /api/v1/media/import`; the body is the file, `content-length` its size. */
export const PhisMediaImportQuery = {
  name: "name",
  folder: "folder",
  alt: "alt",
  title: "title",
} as const;

/** `POST /api/v1/media/import/folder`: a Folder by its path from the Site Space's root, or by id. */
export type PhisMediaImportFolderRequest = { path: string[] } | { id: number };

export type PhisMediaImportRefusal = { status: "refused"; reason: string; detail: string };

export type PhisMediaImportFolderOutcome =
  | {
    status: "ready";
    folderId: number;
    /** The names from the root down to the Folder, as they are stored. */
    path: string[];
    /** The names of the Folders this request made, top-most first; empty where all were there. */
    created: string[];
  }
  | PhisMediaImportRefusal;

export type PhisMediaImportFileOutcome =
  | {
    /** `created`: a new Asset; `existing`: these bytes were already an Asset of the Site Space, which is answered. */
    status: "created" | "existing";
    assetId: number;
    name: string;
    contentType: string;
    bytes: number;
    folderId: number | null;
    detail?: string;
  }
  | PhisMediaImportRefusal;

/** One line of the CLI's answer, per file, in the order the files were named. */
export type PhisMediaImportReportItem = {
  file: string;
  status: "created" | "existing" | "refused";
  assetId: number | null;
  name: string | null;
  contentType: string | null;
  bytes: number | null;
  folder: { id: number; path: string[] } | null;
  reason?: string;
  detail?: string;
};

function normalizeSegment(value: string) {
  return value.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * `--folder`: digits are a Folder id, anything else a path from the Site Space's root with `/` between
 * the names. A leading `/` makes digits a name (`/2026`). An empty name inside the path is refused rather
 * than skipped, so `a//b` is not quietly `a/b`.
 */
export function parsePhisMediaImportFolder(value: string): PhisMediaImportFolderRequest {
  const raw = value.trim();
  if (/^\d+$/u.test(raw)) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`--folder ${value} is not a Folder id.`);
    return { id };
  }
  const parts = raw.replace(/^\/+/u, "").replace(/\/+$/u, "").split("/").map(normalizeSegment);
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error(`--folder "${value}" is not a Folder path: name every Folder, separated by "/".`);
  }
  if (parts.length > PHIS_MEDIA_IMPORT_FOLDER_DEPTH_MAX) {
    throw new Error(`--folder "${value}" is deeper than ${PHIS_MEDIA_IMPORT_FOLDER_DEPTH_MAX} Folders.`);
  }
  const long = parts.find((part) => part.length > PHIS_MEDIA_IMPORT_FOLDER_NAME_MAX_LENGTH);
  if (long) throw new Error(`The Folder name "${long}" is longer than ${PHIS_MEDIA_IMPORT_FOLDER_NAME_MAX_LENGTH} characters.`);
  return { path: parts };
}

/** What Core accepts as a folder request, or null. */
export function readPhisMediaImportFolderRequest(value: unknown): PhisMediaImportFolderRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ("id" in record && !("path" in record)) {
    return typeof record.id === "number" && Number.isSafeInteger(record.id) && record.id > 0 ? { id: record.id } : null;
  }
  if ("path" in record && !("id" in record) && Array.isArray(record.path)) {
    const path = record.path.map((part) => typeof part === "string" ? normalizeSegment(part) : "");
    if (path.length === 0 || path.length > PHIS_MEDIA_IMPORT_FOLDER_DEPTH_MAX) return null;
    if (path.some((part) => part.length === 0 || part.length > PHIS_MEDIA_IMPORT_FOLDER_NAME_MAX_LENGTH)) return null;
    return { path };
  }
  return null;
}
