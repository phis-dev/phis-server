import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { PHIS_SITE_KEY_HEADER, PHIS_TOKEN_HEADER } from "../lib/constants/http-headers.ts";
import {
  PHIS_MEDIA_IMPORT_FOLDER_ROUTE,
  PHIS_MEDIA_IMPORT_ROUTE,
  PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH,
  PhisMediaImportQuery,
  type PhisMediaImportFileOutcome,
  type PhisMediaImportFolderOutcome,
  type PhisMediaImportFolderRequest,
  type PhisMediaImportReportItem,
} from "../lib/media-import.ts";

/**
 * `phis media import`: local files into a Site's Media library, answered with their Asset ids.
 *
 * HTTP to the serving Core with the internal token, as `phis addon command`, and nothing to the database or
 * the storage: Core writes the object through its Storage Service. Every named file is checked here before
 * anything is sent; the Folder is resolved once (made along its path where missing); then each file is
 * streamed as its own request, never read into memory here, and answered on its own.
 *
 * Each file is its own import: one that Core refuses does not undo the ones before it, and does not stop
 * the ones after it. The report names every file, and the command fails when any was refused.
 */

export type MediaImportCore = { apiBaseUrl: string; internalToken: string; siteKey: string };

export type MediaImportLocalFile = { file: string; absolutePath: string; bytes: number };

/** Every named file, or every reason why not: nothing is sent while one of them cannot be read. */
export function readMediaImportFiles(files: readonly string[], cwd = process.cwd()): MediaImportLocalFile[] {
  if (files.length === 0) throw new Error("Name at least one file with --file <path>.");
  const problems: string[] = [];
  const read: MediaImportLocalFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const absolutePath = path.resolve(cwd, file);
    if (!existsSync(absolutePath)) {
      problems.push(`${file}: no such file`);
      continue;
    }
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      problems.push(`${file}: not a regular file`);
      continue;
    }
    if (stat.size === 0) {
      problems.push(`${file}: empty`);
      continue;
    }
    if (path.basename(absolutePath).length > PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH) {
      problems.push(`${file}: the file name is longer than ${PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH} characters`);
      continue;
    }
    if (seen.has(absolutePath)) {
      problems.push(`${file}: named twice`);
      continue;
    }
    seen.add(absolutePath);
    read.push({ file, absolutePath, bytes: stat.size });
  }
  if (problems.length > 0) {
    throw new Error(`Nothing was imported:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  }
  return read;
}

/** `--alt` and `--title`, which apply to every file of the call. */
export function readMediaImportText(value: string | undefined, flag: string) {
  if (value === undefined || value === "") return null;
  if (value.length > PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH) {
    throw new Error(`--${flag} is at most ${PHIS_MEDIA_IMPORT_TEXT_MAX_LENGTH} characters.`);
  }
  return value;
}

function coreHeaders(core: MediaImportCore): Record<string, string> {
  return {
    [PHIS_TOKEN_HEADER]: core.internalToken,
    [PHIS_SITE_KEY_HEADER]: core.siteKey,
    "user-agent": "phis-cli/media-import",
    accept: "application/json",
  };
}

async function resolveFolder(core: MediaImportCore, folder: PhisMediaImportFolderRequest) {
  let response: Response;
  try {
    response = await fetch(`${core.apiBaseUrl}${PHIS_MEDIA_IMPORT_FOLDER_ROUTE}`, {
      method: "POST",
      headers: { ...coreHeaders(core), "content-type": "application/json" },
      body: JSON.stringify(folder),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Core at ${core.apiBaseUrl} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null) as { error?: string; result?: PhisMediaImportFolderOutcome } | null;
  if (!response.ok || !body?.result) {
    throw new Error(`Core answered ${response.status} on ${PHIS_MEDIA_IMPORT_FOLDER_ROUTE}: ${body?.error ?? "no reason given"}.`);
  }
  return body.result;
}

/**
 * One file as the body of one request, its length stated and streamed from the disk.
 *
 * Core may answer before it has read the body -- a file over the Site's limit, a full quota -- and the
 * answer is what counts: the upload is then stopped rather than sent to the end.
 */
export function postMediaImportFile(core: MediaImportCore, input: {
  absolutePath: string;
  bytes: number;
  name: string;
  folderId: number | null;
  alt: string | null;
  title: string | null;
}): Promise<PhisMediaImportFileOutcome> {
  const url = new URL(`${core.apiBaseUrl}${PHIS_MEDIA_IMPORT_ROUTE}`);
  url.searchParams.set(PhisMediaImportQuery.name, input.name);
  if (input.folderId !== null) url.searchParams.set(PhisMediaImportQuery.folder, String(input.folderId));
  if (input.alt !== null) url.searchParams.set(PhisMediaImportQuery.alt, input.alt);
  if (input.title !== null) url.searchParams.set(PhisMediaImportQuery.title, input.title);
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const source = createReadStream(input.absolutePath);
    const finish = (error: Error | null, value?: PhisMediaImportFileOutcome) => {
      if (settled) return;
      settled = true;
      source.destroy();
      request.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const request = client.request(url, {
      method: "POST",
      headers: {
        ...coreHeaders(core),
        "content-type": "application/octet-stream",
        "content-length": String(input.bytes),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => finish(error));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: { error?: string; result?: PhisMediaImportFileOutcome } | null = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        const status = response.statusCode ?? 0;
        if (status === 200 && body?.result) {
          finish(null, body.result);
          return;
        }
        finish(new Error(`Core answered ${status} on ${PHIS_MEDIA_IMPORT_ROUTE}: ${body?.error ?? "no reason given"}.`));
      });
    });
    request.on("error", (error) => finish(new Error(`Core at ${core.apiBaseUrl} is not reachable: ${error.message}`)));
    source.on("error", (error) => finish(new Error(`${input.absolutePath} could not be read: ${error.message}`)));
    source.pipe(request);
  });
}

export type MediaImportReport = {
  site: string;
  folder: { id: number; path: string[]; created: string[] } | null;
  items: PhisMediaImportReportItem[];
  refused: number;
};

/** The Folder, then every file in the order named. A refused Folder stops the run before any file is sent. */
export async function importMediaFiles(core: MediaImportCore, input: {
  files: readonly MediaImportLocalFile[];
  folder: PhisMediaImportFolderRequest | null;
  alt: string | null;
  title: string | null;
}): Promise<MediaImportReport> {
  let folder: MediaImportReport["folder"] = null;
  if (input.folder) {
    const resolved = await resolveFolder(core, input.folder);
    if (resolved.status === "refused") {
      throw new Error(`Nothing was imported: Core refused the folder (${resolved.reason}): ${resolved.detail}`);
    }
    folder = { id: resolved.folderId, path: resolved.path, created: resolved.created };
  }

  const items: PhisMediaImportReportItem[] = [];
  for (const file of input.files) {
    const result = await postMediaImportFile(core, {
      absolutePath: file.absolutePath,
      bytes: file.bytes,
      name: path.basename(file.absolutePath),
      folderId: folder?.id ?? null,
      alt: input.alt,
      title: input.title,
    });
    items.push(toReportItem(file.file, result, folder));
  }
  return { site: core.siteKey, folder, items, refused: items.filter((item) => item.status === "refused").length };
}

export function toReportItem(
  file: string,
  result: PhisMediaImportFileOutcome,
  folder: { id: number; path: string[] } | null,
): PhisMediaImportReportItem {
  if (result.status === "refused") {
    return {
      file, status: "refused", assetId: null, name: null, contentType: null, bytes: null, folder: null,
      reason: result.reason, detail: result.detail,
    };
  }
  return {
    file,
    status: result.status,
    assetId: result.assetId,
    name: result.name,
    contentType: result.contentType,
    bytes: result.bytes,
    // An existing Asset stays where it is, which may be another Folder than the one asked for.
    folder: result.folderId === null ? null : result.folderId === folder?.id ? { id: folder.id, path: folder.path } : { id: result.folderId, path: [] },
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

/** The short table of the text mode: one line per file, refusals with their reason. */
export function formatMediaImportReport(report: MediaImportReport) {
  const lines: string[] = [];
  if (report.folder?.created.length) {
    lines.push(`Made folder(s) ${report.folder.created.map((name) => `"${name}"`).join(", ")} in ${report.site}.`);
  }
  const rows = report.items.map((item) => [
    item.status,
    item.assetId === null ? "-" : String(item.assetId),
    item.file,
    item.contentType ?? "-",
    item.bytes === null ? "-" : String(item.bytes),
    item.folder ? (item.folder.path.length > 0 ? item.folder.path.join("/") : `#${item.folder.id}`) : "-",
  ]);
  const header = ["STATUS", "ASSET", "FILE", "TYPE", "BYTES", "FOLDER"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: readonly string[]) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  lines.push(line(header), ...rows.map(line));
  for (const item of report.items) {
    if (item.status === "refused") lines.push(`  ${item.file}: refused (${item.reason}): ${item.detail}`);
    else if (item.detail) lines.push(`  ${item.file}: ${item.detail}`);
  }
  return lines.join("\n");
}
