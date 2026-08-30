import { chownSync, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/addon-contract";

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
