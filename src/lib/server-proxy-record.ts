/**
 * The stage's proxy record, `config/phis-proxy.json`.
 *
 * `phis proxy config|tls` (src/cli/proxy.mts) writes it; the operator's Sites panel reads it on the server
 * to put the web server this stage actually runs first. Node built-ins and relative imports only, so the
 * CLI bundle and the Next server can both load it.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PhiProxyKind } from "./proxy-tls-blocks.ts";

export type { PhiProxyKind } from "./proxy-tls-blocks.ts";

/**
 * What `phis proxy config --write` and `phis proxy tls` put on this host, kept in the stage they serve.
 *
 * Removal takes exactly this and nothing else: the file as it was written (an edited one is the operator's
 * and stays), the modules that were off before phis switched them on, the challenge directory, and the
 * certificate `proxy tls` obtained. Kept beside the stage's own configuration in
 * `config/phis-proxy.json`, because the proxy serves that stage's ports and goes when it goes. A host where
 * the file was written by hand, or by a release before this record existed, has none, and removal then
 * lists rather than guesses.
 */
export type PhiServerProxyRecord = {
  version: 1;
  kind: PhiProxyKind;
  domain: string;
  tls: boolean;
  path: string;
  /** The enabled link `proxy config` made (nginx) or `a2ensite` made (Apache). */
  enabledPath: string;
  sha256: string;
  enabledModules: string[];
  acmeWebroot: string;
  /** certbot's certificate name, which `proxy tls` makes the domain. */
  certificate: string | null;
  writtenAt: string;
};

export function resolvePhiProxyRecordPath(root: string) {
  return path.join(/* turbopackIgnore: true */ root, "config", "phis-proxy.json");
}

export function readPhiServerProxyRecord(root: string): PhiServerProxyRecord | null {
  const file = resolvePhiProxyRecordPath(root);
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<PhiServerProxyRecord>;
  if (value.version !== 1 || (value.kind !== "apache" && value.kind !== "nginx") || typeof value.path !== "string") {
    throw new Error(`${file} is not a proxy record this release reads.`);
  }
  return value as PhiServerProxyRecord;
}

export type PhiStageWebServer = {
  /** null when neither the record nor the host names one, or the host has both. */
  kind: PhiProxyKind | null;
  /** Only from the record: `phis proxy tls` is what puts the certificate and the redirect in place. */
  tls: boolean;
};

/**
 * The web server in front of this stage: the record's when `phis proxy` wrote one, else whichever of
 * Apache and nginx has a configuration directory on this host.
 *
 * No `command -v` as `isPhiProxyInstalled` does: the Next server spawns nothing for a page render, and a
 * configuration directory is enough to pick which snippet to show first.
 */
export function resolvePhiStageWebServer(
  root: string,
  exists: (file: string) => boolean = existsSync,
): PhiStageWebServer {
  const record = readPhiServerProxyRecord(root);
  if (record) return { kind: record.kind, tls: record.tls === true };
  const apache = exists("/etc/apache2");
  const nginx = exists("/etc/nginx");
  return { kind: apache === nginx ? null : apache ? "apache" : "nginx", tls: false };
}
