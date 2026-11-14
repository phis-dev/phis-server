import { accessSync, chmodSync, chownSync, constants, mkdirSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { PhisConfig } from "./config-core.ts";

/**
 * The three directories the configuration names and the server writes into: the Local media root and the
 * two Site roots.
 *
 * Nothing used to create them. A fresh `phis install` left all three missing, and the first upload or the
 * first `phis init` was where that showed -- as an EACCES or ENOENT that names a path nobody had been told
 * to make. So `phis install`, `phis site add`, `phis init` and the operator UI's "add Site" all go through
 * `ensurePhiConfiguredDirectories`, and `phis setup status` reports `checkPhiConfiguredDirectory` for each.
 *
 * The modes:
 * - the media root is 0750: it holds every Site's uploads, including those of Spaces that are not public,
 *   and the server is the only thing that reads them -- media is delivered through phis, never straight
 *   from disk by the web server, so nobody outside the service account and its group needs to look in;
 * - the two Site roots are 0755: they hold Site checkouts and the links to their releases, which carry no
 *   secret of the installation's (a Site's `config/site-runtime.json` sets its own mode), and the operator's
 *   own login, the build and the Sites' processes all read them.
 *
 * A directory that exists is left as it is, mode and owner both: it may be shared with something this
 * cannot know about. The check then says what is wrong with it, and the operator decides.
 */

export type PhiConfiguredDirectoryKey = "media" | "sources" | "instances";

export type PhiConfiguredDirectory = {
  key: PhiConfiguredDirectoryKey;
  /** The configuration key that names the path, for messages. */
  setting: "media.local.rootDir" | "sites.sourcePathRoot" | "sites.instancePathRoot";
  path: string;
  mode: number;
};

/** The account the server runs as. Who owns a directory is compared to this, and who may write it. */
export type PhiServiceAccount = { uid: number; gid: number };

export type PhiConfiguredDirectoryCheck = PhiConfiguredDirectory & {
  ok: boolean;
  exists: boolean;
  isDirectory: boolean;
  owner: PhiServiceAccount | null;
  writable: boolean;
  detail: string;
};

export type PhiConfiguredDirectoryResult = PhiConfiguredDirectoryCheck & {
  created: boolean;
  /** Why the directory could not be created; null when it was, or did not need to be. */
  error: string | null;
};

export const PHI_MEDIA_ROOT_MODE = 0o750;
export const PHI_SITE_ROOT_MODE = 0o755;

/**
 * The three paths from the merged configuration; one that is empty or not absolute is left out, since
 * there is nothing sensible to create for it (`phis config validate` reports the setting itself).
 */
export function listPhiConfiguredDirectories(config: PhisConfig): PhiConfiguredDirectory[] {
  const entries: PhiConfiguredDirectory[] = [
    { key: "media", setting: "media.local.rootDir", path: config.media?.local?.rootDir ?? "", mode: PHI_MEDIA_ROOT_MODE },
    { key: "sources", setting: "sites.sourcePathRoot", path: config.sites?.sourcePathRoot ?? "", mode: PHI_SITE_ROOT_MODE },
    { key: "instances", setting: "sites.instancePathRoot", path: config.sites?.instancePathRoot ?? "", mode: PHI_SITE_ROOT_MODE },
  ];
  return entries
    .map((entry) => ({ ...entry, path: entry.path.trim() }))
    .filter((entry) => entry.path && path.isAbsolute(entry.path))
    .map((entry) => ({ ...entry, path: path.resolve(/* turbopackIgnore: true */ entry.path) }));
}

/**
 * The account a stage's server runs as: whoever owns its `config/` directory.
 *
 * Not configured anywhere, for the reason `phis media check` gives for its own expected owner: the package
 * makes `config/` for the account the unit runs as (`phis:phis`, `phis@.service`), the runtime file is
 * written to keep that owner, and a second place to name the account would only be a second place to go
 * stale. A checkout started by hand is served by whoever owns it, which is the same answer.
 */
export function resolvePhiServiceAccount(configDirectory: string): PhiServiceAccount {
  const stats = statSync(configDirectory);
  return { uid: stats.uid, gid: stats.gid };
}

/** The account this process runs as: what the operator UI, which is the server itself, writes with. */
export function currentPhiProcessAccount(): PhiServiceAccount | null {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? null : { uid, gid };
}

function statOrNull(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

/**
 * Whether the account may create entries in the directory, by its mode bits. Supplementary groups are not
 * looked up -- that needs the account database, which Node does not read -- so a directory writable only
 * through one of them reads as not writable, which errs on the side of saying so. When the account is this
 * process, the kernel is asked instead, which also covers the directories above it.
 */
function isWritableBy(target: string, stats: Stats, account: PhiServiceAccount) {
  const self = currentPhiProcessAccount();
  if (self && self.uid === account.uid) {
    try {
      accessSync(target, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  if (account.uid === 0) return true;
  if (stats.uid === account.uid) return (stats.mode & 0o300) === 0o300;
  if (stats.gid === account.gid) return (stats.mode & 0o030) === 0o030;
  return (stats.mode & 0o003) === 0o003;
}

function formatOwner(stats: Stats) {
  return `${stats.uid}:${stats.gid}`;
}

export function checkPhiConfiguredDirectory(
  directory: PhiConfiguredDirectory,
  account: PhiServiceAccount,
): PhiConfiguredDirectoryCheck {
  const stats = statOrNull(directory.path);
  const fix = `install -d -o ${account.uid} -g ${account.gid} -m ${directory.mode.toString(8).padStart(4, "0")} ${directory.path}`;
  if (!stats) {
    return {
      ...directory, ok: false, exists: false, isDirectory: false, owner: null, writable: false,
      detail: `${directory.path} (${directory.setting}) does not exist (phis install, or as root: ${fix})`,
    };
  }
  const owner = { uid: stats.uid, gid: stats.gid };
  if (!stats.isDirectory()) {
    return {
      ...directory, ok: false, exists: true, isDirectory: false, owner, writable: false,
      detail: `${directory.path} (${directory.setting}) is not a directory`,
    };
  }
  const writable = isWritableBy(directory.path, stats, account);
  const owned = stats.uid === account.uid && stats.gid === account.gid;
  const problems = [
    owned ? null : `owned by ${formatOwner(stats)}, not the service account ${account.uid}:${account.gid}`,
    writable ? null : "not writable by the service account",
  ].filter(Boolean);
  return {
    ...directory, ok: problems.length === 0, exists: true, isDirectory: true, owner, writable,
    detail: problems.length === 0
      ? `${directory.path} (${directory.setting})`
      : `${directory.path} (${directory.setting}): ${problems.join(", ")} (as root: chown ${account.uid}:${account.gid} ${directory.path})`,
  };
}

/**
 * Creates each missing directory for the service account, then checks all of them. Idempotent: what exists
 * is only checked.
 *
 * As root it creates and hands the directory to the account. As the account itself -- the operator UI,
 * which is the server -- it creates what its permissions allow, which is the directory's owner already;
 * where they do not (a root-owned parent), the result carries the error and the command that fixes it.
 * As any other account it creates nothing, because the directory would belong to the wrong one.
 *
 * Only the directory itself is handed over. Parents it has to create on the way stay root's with mode
 * 0755, as `install -d` leaves them.
 */
export function ensurePhiConfiguredDirectories(
  directories: readonly PhiConfiguredDirectory[],
  account: PhiServiceAccount,
): PhiConfiguredDirectoryResult[] {
  const self = currentPhiProcessAccount();
  const asRoot = self?.uid === 0;
  const asAccount = self !== null && self.uid === account.uid;
  return directories.map((directory) => {
    let created = false;
    let error: string | null = null;
    if (!statOrNull(directory.path)) {
      if (asRoot || asAccount) {
        try {
          mkdirSync(directory.path, { recursive: true, mode: directory.mode });
          // mkdir applies the umask; the mode is meant as written.
          chmodSync(directory.path, directory.mode);
          if (asRoot) chownSync(directory.path, account.uid, account.gid);
          created = true;
        } catch (cause) {
          error = `${directory.path} (${directory.setting}) could not be created: ${(cause as Error).message}`;
        }
      } else {
        error = `${directory.path} (${directory.setting}) is missing, and this account (${self?.uid ?? "?"}) is neither `
          + `root nor the service account (${account.uid}); run phis install as root`;
      }
    }
    return { ...checkPhiConfiguredDirectory(directory, account), created, error };
  });
}

/** What did not work out, one line each, for a warning: the creation error where there is one, else the check. */
export function describePhiConfiguredDirectoryProblems(results: readonly PhiConfiguredDirectoryResult[]) {
  return results.filter((result) => !result.ok).map((result) => result.error ?? result.detail);
}
