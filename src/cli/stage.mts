import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readPhiStagePorts } from "./proxy.mts";

/**
 * Taking one stage off a host again: `phis stage remove`.
 *
 * The counterpart of `phis install`. A teardown of a real installation left eight things behind after
 * `schema drop` and `apt purge`, every one removed by hand: the enabled vhost and certbot's copy of it, both
 * proxying to a dead backend; Apache modules switched on for phis; the certificate, still renewing; the
 * empty database and both roles; the stage directory with every secret in it; and the `phis` account.
 * This removes what phis itself made for the stage -- the database and roles its configuration names, the
 * proxy files `phis proxy` recorded, the certificate `phis proxy tls` obtained, the stage directory -- and
 * lists what it finds and did not make, rather than guessing whose it is.
 */

export const PHI_STAGES_ROOT = "/srv/phis/stages";

/** `prod` for `/srv/phis/stages/prod`; null for any root that is not a stage of this host's layout. */
export function resolvePhiStageName(root: string) {
  const match = /^\/srv\/phis\/stages\/([a-z0-9_-]+)\/?$/u.exec(path.resolve(root));
  return match ? match[1]! : null;
}

/** The stages left on this host, the given one excluded. */
export function listPhiOtherStages(stage: string, stagesRoot = PHI_STAGES_ROOT) {
  if (!existsSync(stagesRoot)) return [];
  return readdirSync(stagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== stage)
    .map((entry) => entry.name)
    .sort();
}

/**
 * Web server files and certificates that look like this stage's and that phis did not record.
 *
 * A site file that proxies to one of the stage's ports -- certbot's `-le-ssl` copy is the usual one, or a
 * file written by hand before `phis proxy` existed -- and a certificate for the recorded domain that is not
 * the recorded one. Listed, never removed: phis cannot know they are not somebody else's.
 */
export function findPhiStageProxyLeftovers(input: {
  root: string;
  recordedPaths: readonly string[];
  domain: string | null;
  recordedCertificate: string | null;
}) {
  const ports = readPhiStagePorts(input.root);
  const patterns = ports.map((port) => new RegExp(`(?:127\\.0\\.0\\.1|localhost):${port}\\b`, "u"));
  const files: string[] = [];
  for (const directory of ["/etc/apache2/sites-available", "/etc/nginx/sites-available", "/etc/nginx/conf.d"]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      if (input.recordedPaths.includes(file)) continue;
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (patterns.some((pattern) => pattern.test(content)) || (input.domain && content.includes(input.domain))) {
        files.push(file);
      }
    }
  }
  const certificates: string[] = [];
  const renewal = "/etc/letsencrypt/renewal";
  if (input.domain && existsSync(renewal)) {
    for (const name of readdirSync(renewal)) {
      const certificate = name.replace(/\.conf$/u, "");
      if (certificate === input.recordedCertificate) continue;
      if (certificate === input.domain || certificate.startsWith(`${input.domain}-`)) {
        certificates.push(certificate);
      }
    }
  }
  return { files, certificates };
}

/**
 * The stage's configuration and secrets in one archive, written before anything is removed.
 *
 * `config/` and `.env`, which between them hold every key and both database passwords; mode 0600, since the
 * archive is as secret as what it holds. Local media is not included: it can be large, and where it lives
 * is the storage profile's, not the stage directory's.
 */
export function archivePhiStageConfig(root: string, file: string) {
  const entries = ["config", ".env"].filter((entry) => existsSync(path.join(root, entry)));
  if (entries.length === 0) {
    throw new Error(`${root} holds neither config/ nor .env; there is nothing to back up.`);
  }
  const target = path.resolve(file);
  // Created first with its mode, exclusively, so the archive is never readable by others for a moment and
  // an existing file is never overwritten; tar keeps the mode of the file it truncates.
  try {
    writeFileSync(target, "", { mode: 0o600, flag: "wx" });
  } catch {
    throw new Error(`${target} exists or cannot be created; name a new file for the backup.`);
  }
  const result = spawnSync("tar", ["-czf", target, "-C", root, ...entries], { encoding: "utf8" });
  if (result.status !== 0) {
    rmSync(target, { force: true });
    throw new Error(`The backup could not be written: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { path: target, entries };
}

/**
 * Stops and disables `phis@<stage>`, and says which of the two there was to do; a host without systemd, or
 * a unit that was never enabled, is no error.
 */
export function stopPhiStageUnit(unit: string) {
  if (!existsSync("/run/systemd/system")) return { active: false, enabled: false };
  const state = (verb: string) => spawnSync("systemctl", ["--quiet", verb, unit]).status === 0;
  const before = { active: state("is-active"), enabled: state("is-enabled") };
  if (before.active || before.enabled) {
    const result = spawnSync("systemctl", ["disable", "--now", unit], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`systemctl disable --now ${unit} failed: ${(result.stderr || result.stdout).trim()}`);
    }
  }
  return before;
}

export function removePhiStageDirectory(root: string) {
  if (!resolvePhiStageName(root)) {
    throw new Error(`${root} is not a stage under ${PHI_STAGES_ROOT}; it is not removed.`);
  }
  rmSync(root, { recursive: true, force: true });
}
