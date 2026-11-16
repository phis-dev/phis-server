import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { PHIS_SITE_KEY_HEADER, PHIS_TOKEN_HEADER } from "../lib/constants/http-headers.ts";
import {
  orderPhisModuleMediaFolders,
  parsePhisModuleMediaManifest,
  type PhisModuleMediaFileDeclaration,
  type PhisModuleMediaManifest,
  type PhisModuleMediaMapping,
  type PhisModuleMediaOutcome,
} from "../lib/module-media.ts";

/**
 * `phis module media`: the Module packages' pictures, from the package to the Site's Media library.
 *
 * Everything here reads files and talks HTTP, and nothing reaches the database or the storage: writing an
 * object goes through Core's storage service, which lives in the server process (design/MODULE_MEDIA.md,
 * section 5). The CLI reads each installed package's `phis.media` declaration as text, runs no package code,
 * and posts one folder or one file per request to Core's internal routes with the Site's own token, from the
 * Site's `config/site-runtime.json`.
 */

export type ModuleMediaFileEntry = {
  declaration: PhisModuleMediaFileDeclaration;
  absolutePath: string;
  sha256: string;
};

export type ModuleMediaPackage = {
  packageName: string;
  /** False where the package is not in the Site's `node_modules` yet, which is not a fault of the package. */
  installed: boolean;
  manifest: PhisModuleMediaManifest | null;
  files: ModuleMediaFileEntry[];
  issues: string[];
};

/**
 * Where a declared file really is, or why it may not be read: inside the package root after every symlink is
 * resolved, and a regular file. `phis.media.files[].file` is the package author's word, and a package is
 * somebody else's code -- nothing outside its root is read on its say-so.
 */
function resolveDeclaredFile(realRoot: string, declared: string): { path: string } | { problem: string } {
  const candidate = path.resolve(realRoot, declared);
  if (!existsSync(candidate)) return { problem: `\`file\` "${declared}" does not exist in the package` };
  const real = realpathSync(candidate);
  const relative = path.relative(realRoot, real);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { problem: `\`file\` "${declared}" resolves outside the package root` };
  }
  if (!statSync(real).isFile()) return { problem: `\`file\` "${declared}" is not a regular file` };
  return { path: real };
}

/** What each installed package of the Site declares, with every violation reported by package and key. */
export function readModuleMediaPackages(siteRoot: string, packageNames: readonly string[]): ModuleMediaPackage[] {
  return packageNames.map((packageName) => {
    const root = path.join(siteRoot, "node_modules", ...packageName.split("/"));
    const manifestFile = path.join(root, "package.json");
    if (!existsSync(manifestFile)) {
      return { packageName, installed: false, manifest: null, files: [], issues: [] };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch (error) {
      return {
        packageName, installed: true, manifest: null, files: [],
        issues: [`${packageName}: package.json is not readable JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    const { manifest, issues } = parsePhisModuleMediaManifest(
      packageName,
      (parsedJson as { phis?: unknown } | null)?.phis,
    );
    if (!manifest) return { packageName, installed: true, manifest: null, files: [], issues };

    const realRoot = realpathSync(root);
    const files: ModuleMediaFileEntry[] = [];
    for (const declaration of manifest.files) {
      const resolved = resolveDeclaredFile(realRoot, declaration.file);
      if ("problem" in resolved) {
        issues.push(`${packageName}: file "${declaration.key}": ${resolved.problem}`);
        continue;
      }
      files.push({
        declaration,
        absolutePath: resolved.path,
        sha256: createHash("sha256").update(readFileSync(resolved.path)).digest("hex"),
      });
    }
    return { packageName, installed: true, manifest: issues.length > 0 ? null : manifest, files, issues };
  });
}

function throwOnIssues(packages: readonly ModuleMediaPackage[]) {
  const issues = packages.flatMap((entry) => entry.issues);
  if (issues.length > 0) {
    throw new Error(`The Module media declarations are invalid:\n${issues.map((line) => `  - ${line}`).join("\n")}`);
  }
}

/** Core's address and the internal token as the Site itself holds them. */
export function readSiteRuntimeCore(siteRoot: string) {
  const file = path.join(siteRoot, "config", "site-runtime.json");
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist; the Site's Core address and token are read from it.`);
  }
  let parsed: { phis?: { apiBaseUrl?: unknown; internalToken?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const apiBaseUrl = typeof parsed.phis?.apiBaseUrl === "string" ? parsed.phis.apiBaseUrl.trim().replace(/\/+$/, "") : "";
  const internalToken = typeof parsed.phis?.internalToken === "string" ? parsed.phis.internalToken.trim() : "";
  if (!apiBaseUrl || !internalToken) {
    throw new Error(`${file} needs phis.apiBaseUrl and phis.internalToken.`);
  }
  return { apiBaseUrl, internalToken };
}

type Core = ReturnType<typeof readSiteRuntimeCore> & { siteKey: string };

async function callCore(core: Core, route: string, init: { method: "GET" | "POST"; json?: unknown; form?: FormData }) {
  const headers: Record<string, string> = {
    [PHIS_TOKEN_HEADER]: core.internalToken,
    [PHIS_SITE_KEY_HEADER]: core.siteKey,
    "user-agent": "phis-cli/module-media",
    accept: "application/json",
  };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${core.apiBaseUrl}${route}`, {
      method: init.method,
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    throw new Error(`Core at ${core.apiBaseUrl} is not reachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null) as { error?: string; result?: unknown } | null;
  if (!response.ok) {
    throw new Error(`Core answered ${response.status} on ${route}: ${body?.error ?? "no reason given"}.`);
  }
  return body;
}

const rowKey = (packageName: string, key: string) => `${packageName}\u0000${key}`;

export type ModuleMediaSyncReport = {
  site: string;
  /** Names the packages declare; zero means Core was not contacted. */
  declared: number;
  items: PhisModuleMediaOutcome[];
  refused: PhisModuleMediaOutcome[];
};

/**
 * Posts what the Site's packages declare and Core does not hold yet.
 *
 * The mapping is read first, so a file Core already holds, written from these same bytes, is not uploaded
 * again on every `phis update`. A row bound by hand is not sent either. Core applies every rule itself and
 * would answer the same; this only keeps the traffic to what can change something. Folders go first,
 * parents before children, then files.
 *
 * A manifest violation stops the run before any request, naming every one. A refused item does not stop it:
 * the rest is imported and the report carries the refusals, for the caller to fail on.
 */
export async function syncModuleMedia(input: {
  siteKey: string;
  siteRoot: string;
  packageNames: readonly string[];
}): Promise<ModuleMediaSyncReport> {
  const packages = readModuleMediaPackages(input.siteRoot, input.packageNames);
  throwOnIssues(packages);
  const declaring = packages.filter((entry) => entry.manifest && (entry.manifest.folders.length + entry.manifest.files.length) > 0);
  const declared = declaring.reduce((sum, entry) => sum + entry.manifest!.folders.length + entry.manifest!.files.length, 0);
  if (declared === 0) return { site: input.siteKey, declared: 0, items: [], refused: [] };

  const core: Core = { ...readSiteRuntimeCore(input.siteRoot), siteKey: input.siteKey };
  const mapping = await callCore(core, "/api/v1/module-media", { method: "GET" }) as unknown as PhisModuleMediaMapping;
  const folderRows = new Map(mapping.folders.map((row) => [rowKey(row.packageName, row.key), row]));
  const fileRows = new Map(mapping.files.map((row) => [rowKey(row.packageName, row.key), row]));
  const items: PhisModuleMediaOutcome[] = [];

  for (const entry of declaring) {
    for (const folder of orderPhisModuleMediaFolders(entry.manifest!.folders)) {
      const row = folderRows.get(rowKey(entry.packageName, folder.key));
      if (row?.bound) {
        items.push({ kind: "folder", packageName: entry.packageName, key: folder.key, status: "bound-left", ...(row.folderId !== null ? { folderId: row.folderId } : {}) });
        continue;
      }
      if (row && row.folderId !== null) {
        items.push({ kind: "folder", packageName: entry.packageName, key: folder.key, status: "unchanged", folderId: row.folderId });
        continue;
      }
      const answer = await callCore(core, "/api/v1/module-media/folder", {
        method: "POST",
        json: { package: entry.packageName, key: folder.key, name: folder.name, ...(folder.parent ? { parent: folder.parent } : {}) },
      });
      items.push(answer!.result as PhisModuleMediaOutcome);
    }
  }

  for (const entry of declaring) {
    for (const file of entry.files) {
      const key = file.declaration.key;
      const row = fileRows.get(rowKey(entry.packageName, key));
      if (row?.bound) {
        items.push({ kind: "file", packageName: entry.packageName, key, status: "bound-left", ...(row.assetId !== null ? { assetId: row.assetId } : {}) });
        continue;
      }
      if (row && row.assetId !== null && row.sourceChecksum === file.sha256) {
        items.push({ kind: "file", packageName: entry.packageName, key, status: "unchanged", assetId: row.assetId });
        continue;
      }
      const form = new FormData();
      form.set("file", new Blob([readFileSync(file.absolutePath)]), path.basename(file.absolutePath));
      form.set("package", entry.packageName);
      form.set("key", key);
      if (file.declaration.folder) form.set("folder", file.declaration.folder);
      form.set("alt", file.declaration.alt);
      if (file.declaration.title) form.set("title", file.declaration.title);
      form.set("originalName", path.basename(file.absolutePath));
      const answer = await callCore(core, "/api/v1/module-media/file", { method: "POST", form });
      items.push(answer!.result as PhisModuleMediaOutcome);
    }
  }

  return { site: input.siteKey, declared, items, refused: items.filter((item) => item.status === "refused") };
}

export function describeModuleMediaOutcome(item: PhisModuleMediaOutcome) {
  const target = item.kind === "folder" ? (item.folderId !== undefined ? ` folder ${item.folderId}` : "") : (item.assetId !== undefined ? ` asset ${item.assetId}` : "");
  const why = item.status === "refused" ? ` (${item.reason}: ${item.detail ?? ""})` : item.detail ? ` -- ${item.detail}` : "";
  return `${item.status.padEnd(10)} ${item.kind} ${item.packageName} ${item.key}${target}${why}`;
}

export type ModuleMediaListRow = {
  kind: "folder" | "file";
  packageName: string;
  key: string;
  id: number | null;
  state: "package file" | "hand binding" | "missing" | "no longer declared";
};

/** Every declared name and every stored row, with what each stands for on the Site. */
export async function listModuleMedia(input: {
  siteKey: string;
  siteRoot: string;
  packageNames: readonly string[];
}): Promise<{ rows: ModuleMediaListRow[]; issues: string[] }> {
  const packages = readModuleMediaPackages(input.siteRoot, input.packageNames);
  const issues = packages.flatMap((entry) => entry.issues);
  const core: Core = { ...readSiteRuntimeCore(input.siteRoot), siteKey: input.siteKey };
  const mapping = await callCore(core, "/api/v1/module-media", { method: "GET" }) as unknown as PhisModuleMediaMapping;

  const stateOf = (row: { bound: boolean } | undefined, id: number | null | undefined): ModuleMediaListRow["state"] =>
    row && id != null ? (row.bound ? "hand binding" : "package file") : "missing";
  const rows: ModuleMediaListRow[] = [];
  const declared = new Set<string>();

  for (const entry of packages) {
    for (const folder of entry.manifest?.folders ?? []) {
      declared.add(`folder\u0000${rowKey(entry.packageName, folder.key)}`);
      const row = mapping.folders.find((candidate) => candidate.packageName === entry.packageName && candidate.key === folder.key);
      rows.push({ kind: "folder", packageName: entry.packageName, key: folder.key, id: row?.folderId ?? null, state: stateOf(row, row?.folderId) });
    }
    for (const file of entry.manifest?.files ?? []) {
      declared.add(`file\u0000${rowKey(entry.packageName, file.key)}`);
      const row = mapping.files.find((candidate) => candidate.packageName === entry.packageName && candidate.key === file.key);
      rows.push({ kind: "file", packageName: entry.packageName, key: file.key, id: row?.assetId ?? null, state: stateOf(row, row?.assetId) });
    }
  }
  for (const row of mapping.folders) {
    if (!declared.has(`folder\u0000${rowKey(row.packageName, row.key)}`)) {
      rows.push({ kind: "folder", packageName: row.packageName, key: row.key, id: row.folderId, state: "no longer declared" });
    }
  }
  for (const row of mapping.files) {
    if (!declared.has(`file\u0000${rowKey(row.packageName, row.key)}`)) {
      rows.push({ kind: "file", packageName: row.packageName, key: row.key, id: row.assetId, state: "no longer declared" });
    }
  }
  return { rows, issues };
}

export type ModuleMediaBindRequest =
  | { packageName: string; key: string; asset: number }
  | { packageName: string; key: string; folder: number }
  | { packageName: string; key: string; reset: true };

/**
 * Binds a declared name to an Asset or Folder of the Site, or resets a binding. Core validates the target;
 * what is checked here is only that the name is one the package declares, so a typo does not become a row.
 * A reset names no target and may name a row the package no longer declares.
 */
export async function bindModuleMedia(input: {
  siteKey: string;
  siteRoot: string;
  packageNames: readonly string[];
  request: ModuleMediaBindRequest;
}) {
  const { request } = input;
  if (!("reset" in request)) {
    const entry = readModuleMediaPackages(input.siteRoot, input.packageNames).find((candidate) => candidate.packageName === request.packageName);
    if (!entry) throw new Error(`${request.packageName} is not installed for site ${input.siteKey}.`);
    throwOnIssues([entry]);
    const wanted = "asset" in request ? entry.manifest?.files : entry.manifest?.folders;
    if (!wanted?.some((declaration) => declaration.key === request.key)) {
      throw new Error(
        `${request.packageName} declares no ${"asset" in request ? "file" : "folder"} "${request.key}" ` +
        `(--${"asset" in request ? "asset" : "folder"} binds a ${"asset" in request ? "file" : "folder"}).`,
      );
    }
  }
  const core: Core = { ...readSiteRuntimeCore(input.siteRoot), siteKey: input.siteKey };
  const { packageName, key, ...target } = request;
  const answer = await callCore(core, "/api/v1/module-media/bind", { method: "POST", json: { package: packageName, key, ...target } });
  return answer!.result as
    | { ok: true; action: "bound" | "reset"; kind: "file" | "folder" }
    | { ok: false; reason: string; detail: string };
}
