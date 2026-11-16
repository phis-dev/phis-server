/**
 * Module media: what a package declares and what the import answers (design/MODULE_MEDIA.md).
 *
 * Pure, and importable by both sides: the CLI reads the declaration out of a package's `package.json`
 * and posts it; Core validates what it receives against the same limits and answers with the same
 * vocabulary. Nothing here touches a file, the database or the network.
 */

/** A name the package gives a thing: lowercase letters, digits and hyphens, never changed once published. */
export const PHIS_MODULE_MEDIA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const PHIS_MODULE_MEDIA_KEY_MAX_LENGTH = 64;
/** An npm package name, scoped or not. */
export const PHIS_MODULE_MEDIA_PACKAGE_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
/** `media_folders.name`. */
export const PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH = 160;
/** `media_assets.alt_text`, `title` and `original_name`. */
export const PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH = 255;

export type PhisModuleMediaFolderDeclaration = {
  key: string;
  name: string;
  /** The key of another declared folder, or null for the Site Space's root. */
  parent: string | null;
};

export type PhisModuleMediaFileDeclaration = {
  key: string;
  /** Relative to the package root, with forward slashes. */
  file: string;
  /** The key of a declared folder, or null for the Site Space's root. */
  folder: string | null;
  alt: string;
  title: string | null;
};

export type PhisModuleMediaManifest = {
  folders: PhisModuleMediaFolderDeclaration[];
  files: PhisModuleMediaFileDeclaration[];
};

export function isPhisModuleMediaKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= PHIS_MODULE_MEDIA_KEY_MAX_LENGTH
    && PHIS_MODULE_MEDIA_KEY_PATTERN.test(value);
}

export function isPhisModuleMediaPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && PHIS_MODULE_MEDIA_PACKAGE_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The path as the package wrote it, judged without looking at a disk: relative, no `..`, no NUL. */
function checkRelativeFilePath(file: string): string | null {
  if (file.includes("\0")) return "contains a NUL character";
  if (file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:/.test(file)) return "is absolute";
  const segments = file.split(/[\\/]+/);
  if (segments.includes("..")) return 'contains ".."';
  if (segments.every((segment) => segment === "" || segment === ".")) return "names no file";
  return null;
}

/**
 * Reads the `media` declaration of one package's `phis` block and reports every violation.
 *
 * Strict: an unknown property, a wrong type, a key that is not a key, two things with one key (a folder
 * and a file share the package's one namespace), a folder naming a parent that is not a declared folder,
 * a cycle. `manifest` is null when the package declares no media or declares it wrongly; `issues` says
 * which, each with the package and the key it is about. What a path points at on a disk is the caller's
 * to check (`src/cli/module-media.mts`), because this reads no file.
 */
export function parsePhisModuleMediaManifest(
  packageName: string,
  phisBlock: unknown,
): { manifest: PhisModuleMediaManifest | null; issues: string[] } {
  const issues: string[] = [];
  const report = (where: string, message: string) => issues.push(`${packageName}: ${where}: ${message}`);

  if (!isPlainObject(phisBlock) || phisBlock.media === undefined) return { manifest: null, issues };
  const media = phisBlock.media;
  if (!isPlainObject(media)) {
    report("phis.media", "must be an object with `folders` and `files`");
    return { manifest: null, issues };
  }
  for (const name of Object.keys(media)) {
    if (name !== "folders" && name !== "files") report("phis.media", `unknown property "${name}"`);
  }
  for (const name of ["folders", "files"] as const) {
    if (media[name] !== undefined && !Array.isArray(media[name])) report(`phis.media.${name}`, "must be an array");
  }

  const folders: PhisModuleMediaFolderDeclaration[] = [];
  const files: PhisModuleMediaFileDeclaration[] = [];
  const kindOfKey = new Map<string, "folder" | "file">();

  const readKey = (entry: Record<string, unknown>, where: string, kind: "folder" | "file") => {
    const key = entry.key;
    if (!isPhisModuleMediaKey(key)) {
      report(where, `key ${JSON.stringify(key)} must be 1 to ${PHIS_MODULE_MEDIA_KEY_MAX_LENGTH} lowercase letters, digits or hyphens, not starting with a hyphen`);
      return null;
    }
    const earlier = kindOfKey.get(key);
    if (earlier) {
      report(`${where} (key "${key}")`, `key is already used by a ${earlier} of this package; keys are unique across folders and files`);
      return null;
    }
    kindOfKey.set(key, kind);
    return key;
  };

  const readText = (entry: Record<string, unknown>, field: string, where: string, max: number, required: boolean) => {
    const value = entry[field];
    if (value === undefined && !required) return null;
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
      report(where, `\`${field}\` must be ${required ? "a" : "an optional"} non-empty string of at most ${max} characters`);
      return null;
    }
    return value;
  };

  const strictFields = (entry: Record<string, unknown>, where: string, allowed: readonly string[]) => {
    for (const name of Object.keys(entry)) {
      if (!allowed.includes(name)) report(where, `unknown property "${name}"`);
    }
  };

  if (Array.isArray(media.folders)) {
    media.folders.forEach((entry: unknown, index: number) => {
      const where = `phis.media.folders[${index}]`;
      if (!isPlainObject(entry)) return report(where, "must be an object");
      strictFields(entry, where, ["key", "name", "parent"]);
      const key = readKey(entry, where, "folder");
      const at = key ? `${where} (key "${key}")` : where;
      const name = readText(entry, "name", at, PHIS_MODULE_MEDIA_FOLDER_NAME_MAX_LENGTH, true);
      let parent: string | null = null;
      if (entry.parent !== undefined) {
        if (typeof entry.parent !== "string") report(at, "`parent` must be the key of a declared folder");
        else parent = entry.parent;
      }
      if (key && name) folders.push({ key, name, parent });
    });
  }

  if (Array.isArray(media.files)) {
    media.files.forEach((entry: unknown, index: number) => {
      const where = `phis.media.files[${index}]`;
      if (!isPlainObject(entry)) return report(where, "must be an object");
      strictFields(entry, where, ["key", "file", "folder", "alt", "title"]);
      const key = readKey(entry, where, "file");
      const at = key ? `${where} (key "${key}")` : where;
      let file: string | null = null;
      if (typeof entry.file !== "string" || entry.file.trim() === "") {
        report(at, "`file` must be a path inside the package");
      } else {
        const problem = checkRelativeFilePath(entry.file);
        if (problem) report(at, `\`file\` ${JSON.stringify(entry.file)} ${problem}; it must be relative and inside the package`);
        else file = entry.file.replace(/\\/g, "/");
      }
      let folder: string | null = null;
      if (entry.folder !== undefined) {
        if (typeof entry.folder !== "string") report(at, "`folder` must be the key of a declared folder");
        else folder = entry.folder;
      }
      const alt = readText(entry, "alt", at, PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH, true);
      const title = readText(entry, "title", at, PHIS_MODULE_MEDIA_TEXT_MAX_LENGTH, false);
      if (key && file && alt) files.push({ key, file, folder, alt, title });
    });
  }

  const folderKeys = new Set(folders.map((folder) => folder.key));
  for (const folder of folders) {
    if (folder.parent !== null && !folderKeys.has(folder.parent)) {
      report(`folder "${folder.key}"`, `parent "${folder.parent}" is not a declared folder key`);
    }
  }
  for (const file of files) {
    if (file.folder !== null && !folderKeys.has(file.folder)) {
      report(`file "${file.key}"`, `folder "${file.folder}" is not a declared folder key`);
    }
  }
  const parentOf = new Map(folders.map((folder) => [folder.key, folder.parent]));
  for (const folder of folders) {
    const seen = new Set<string>([folder.key]);
    for (let next = folder.parent; next !== null && next !== undefined; next = parentOf.get(next) ?? null) {
      if (seen.has(next)) {
        report(`folder "${folder.key}"`, "its parents form a cycle");
        break;
      }
      seen.add(next);
    }
  }

  return issues.length > 0 ? { manifest: null, issues } : { manifest: { folders, files }, issues };
}

/** Folders in an order that puts every parent before its children. Declaration order is kept otherwise. */
export function orderPhisModuleMediaFolders(folders: readonly PhisModuleMediaFolderDeclaration[]) {
  const ordered: PhisModuleMediaFolderDeclaration[] = [];
  const placed = new Set<string>();
  const remaining = [...folders];
  while (remaining.length > 0) {
    const index = remaining.findIndex((folder) => folder.parent === null || placed.has(folder.parent));
    if (index < 0) break; // a cycle; the parser reports it, nothing here loops on it
    const [next] = remaining.splice(index, 1);
    ordered.push(next!);
    placed.add(next!.key);
  }
  return ordered;
}

/** What the import did with one declared name. */
export type PhisModuleMediaStatus = "unchanged" | "created" | "repaired" | "replaced" | "bound-left" | "refused";

export type PhisModuleMediaOutcome = {
  kind: "folder" | "file";
  packageName: string;
  key: string;
  status: PhisModuleMediaStatus;
  /** Why an item was refused. */
  reason?: string;
  /** A sentence for the operator where the status alone does not say enough. */
  detail?: string;
  assetId?: number;
  folderId?: number;
  /** For `replaced`: the Asset the name stood for before, which is left in the library. */
  previousAssetId?: number;
};

/** What `GET /api/v1/module-media` answers: every stored row of the Site, for `sync` and `list`. */
export type PhisModuleMediaMapping = {
  files: { packageName: string; key: string; assetId: number | null; sourceChecksum: string | null; bound: boolean }[];
  folders: { packageName: string; key: string; folderId: number | null; bound: boolean }[];
};

/** What `GET /api/v1/site/module-media` answers: ids only, for the Site's runtime. */
export type PhisModuleMediaSiteMapping = {
  assets: Record<string, Record<string, number>>;
  folders: Record<string, Record<string, number>>;
};
