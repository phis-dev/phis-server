import { chownSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

/**
 * Whether the Local Storage Profiles are still owned by whoever runs the Server.
 *
 * Every file under a Local Storage root is written by the Server process. A file written by something
 * else -- a Server started by hand as root, an import run from a root shell -- stays readable, so
 * nothing looks wrong until the day that file has to be rewritten. Then a variant regeneration fails
 * with EACCES, an image turns into a question mark in the Media browser, and the cause is days old and
 * somewhere else entirely.
 *
 * The expected owner is not configured: it is whoever owns the storage root itself. That is the account
 * the Server was set up with, it needs no second place to go stale, and it makes the check correct on
 * an installation nobody told us about.
 */

export type PhiMediaOwnershipFinding = {
  path: string;
  uid: number;
  gid: number;
};

export type PhiMediaOwnershipRoot = {
  rootDir: string;
  profiles: number[];
  expectedUid: number;
  expectedGid: number;
  scanned: number;
  findings: PhiMediaOwnershipFinding[];
  missing: boolean;
  fixed: number;
};

function walk(directory: string, onEntry: (entryPath: string) => void) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    onEntry(entryPath);
    if (entry.isDirectory()) {
      walk(entryPath, onEntry);
    }
  }
}

export async function checkPhiMediaOwnership(
  pool: Pool,
  options?: { fix?: boolean },
): Promise<PhiMediaOwnershipRoot[]> {
  const { rows } = await pool.query<{ id: number; config: Record<string, unknown> }>(
    `SELECT id, config FROM phis.media_storage_profiles WHERE provider_id = $1 ORDER BY id`,
    [PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID],
  );

  // Two Sites can share one root, and a root that no Profile names is none of our business.
  const roots = new Map<string, number[]>();
  for (const row of rows) {
    const rootDir = typeof row.config?.rootDir === "string" ? row.config.rootDir.trim() : "";
    if (!rootDir) {
      continue;
    }
    roots.set(rootDir, [...(roots.get(rootDir) ?? []), row.id]);
  }

  const results: PhiMediaOwnershipRoot[] = [];
  for (const [rootDir, profiles] of roots) {
    if (!existsSync(rootDir)) {
      results.push({
        rootDir, profiles, expectedUid: -1, expectedGid: -1,
        scanned: 0, findings: [], missing: true, fixed: 0,
      });
      continue;
    }

    const root = statSync(rootDir);
    const findings: PhiMediaOwnershipFinding[] = [];
    let scanned = 0;
    walk(rootDir, (entryPath) => {
      scanned += 1;
      // lstat: a symlink's own ownership is what a write would trip over, not its target's.
      const entry = lstatSync(entryPath);
      if (entry.uid !== root.uid || entry.gid !== root.gid) {
        findings.push({ path: entryPath, uid: entry.uid, gid: entry.gid });
      }
    });

    let fixed = 0;
    if (options?.fix) {
      for (const finding of findings) {
        chownSync(finding.path, root.uid, root.gid);
        fixed += 1;
      }
    }

    results.push({
      rootDir,
      profiles,
      expectedUid: root.uid,
      expectedGid: root.gid,
      scanned,
      findings,
      missing: false,
      fixed,
    });
  }

  return results;
}

export type PhiMediaOrphanedStaging = {
  rootDir: string;
  /** Staged files with no upload session that names them, older than the lifecycle window. */
  orphans: { path: string; key: string; ageDays: number }[];
  /** Staged files with no session that are still younger than the window: a session may yet be written. */
  young: number;
  removed: number;
};

/**
 * Staged bodies a Local Profile is left holding: no upload session names them any more.
 *
 * For an S3 Profile this is the bucket's lifecycle rule; a Local root has none, and the expiry sweep only
 * removes what a session row still points at. A row deleted before the sweep learned to return its key,
 * or a removal that failed, leaves a file under `<prefix>/uploads-temp/<site>/` that nothing will ever
 * find. This is the deliberate operator command the maintenance contract names for that (AGENTS.md).
 *
 * Only files older than `minAgeDays` count: a file younger than an upload session may live can belong to
 * an upload whose row is being written right now. Removed only with `prune`.
 */
export async function findPhiMediaOrphanedLocalStaging(
  pool: Pool,
  options: { minAgeDays: number; prune?: boolean; now?: number },
): Promise<PhiMediaOrphanedStaging[]> {
  const { rows } = await pool.query<{ config: Record<string, unknown> }>(
    `SELECT config FROM phis.media_storage_profiles WHERE provider_id = $1`,
    [PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID],
  );
  const roots = new Set<string>();
  for (const row of rows) {
    const rootDir = typeof row.config?.rootDir === "string" ? row.config.rootDir.trim() : "";
    if (rootDir && existsSync(rootDir)) roots.add(rootDir);
  }

  const now = options.now ?? Date.now();
  const results: PhiMediaOrphanedStaging[] = [];
  for (const rootDir of roots) {
    const staged: { path: string; key: string; mtimeMs: number }[] = [];
    walk(rootDir, (entryPath) => {
      const key = path.relative(rootDir, entryPath).split(path.sep).join("/");
      if (!/(^|\/)uploads-temp\//u.test(key)) return;
      const entry = lstatSync(entryPath);
      if (entry.isFile()) staged.push({ path: entryPath, key, mtimeMs: entry.mtimeMs });
    });

    const known = new Set<string>();
    if (staged.length > 0) {
      const { rows: sessions } = await pool.query<{ key: string }>(
        `SELECT staging_storage_key AS key FROM phis.media_upload_sessions
          WHERE staging_storage_key = ANY($1::text[])`,
        [staged.map((entry) => entry.key)],
      );
      for (const session of sessions) known.add(session.key);
    }

    const result: PhiMediaOrphanedStaging = { rootDir, orphans: [], young: 0, removed: 0 };
    for (const entry of staged) {
      if (known.has(entry.key)) continue;
      const ageDays = (now - entry.mtimeMs) / 86_400_000;
      if (ageDays < options.minAgeDays) {
        result.young += 1;
        continue;
      }
      result.orphans.push({ path: entry.path, key: entry.key, ageDays: Math.floor(ageDays) });
    }
    if (options.prune) {
      for (const orphan of result.orphans) {
        rmSync(orphan.path, { force: true });
        result.removed += 1;
      }
    }
    results.push(result);
  }
  return results;
}
