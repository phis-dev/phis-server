import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

import type { PhisMediaStorageAdapter } from "@phis/contracts/addon";
import { PhisCdnCheckObjectFlags, PhisCdnCheckReportFlags } from "@phis/contracts/addon";

import { changeMediaSpaceUsedBytesWithDb, readSiteMediaSpaceIdWithDb } from "../db/media-space-quota.mts";
import {
  hasOpenSiteCdnUploads,
  listSiteCdnFiles,
  readSiteCdn,
  readSiteCdnProfile,
  sumSiteCdnStoredBytes,
  type SiteCdnProfileRecord,
} from "../db/site-cdn.mts";
import { adoptPhisCdnObjects, checkPhisCdnBucket, withdrawPhisCdnFile } from "../lib/cdn-catalogue.mts";
import {
  guessPhisCdnPlatform,
  isPhisCdnFileLinked,
  namePhisCdnPlatform,
  phisCdnPublicUrl,
  presentPhisCdnAdminFile,
  readPhisCdnArchNames,
  readPhisCdnOsNames,
  readPhisCdnPublicBaseUrl,
} from "../lib/cdn-core.ts";
import { prunePhisCdnUploads, publishPhisCdnFileFromDisk, type PhisCdnTarget } from "../lib/cdn-publish.mts";
import { PhiMediaStorageProfileFlags } from "../lib/constants/media.ts";
import { commandExists, obtainPhiCertificate, runPhiSystemCommand, type PhiCommandStep } from "./proxy.mts";
import { resolvePhiStorageAdapter, type StorageSecretReader } from "./storage.mts";

/**
 * `phis cdn`: a Site's CDN, as the operator runs it.
 *
 * The bucket is a Storage Profile flagged `Cdn` (`phis storage add --cdn`), and `attach` binds it to the
 * Site with the address it is served from. `publish` puts one file there and records it, straight from
 * the file to the storage over the Provider's own upload plan -- no serving process sees the bytes, and
 * the catalogue is written by the same command that uploaded, so nothing has to poll the bucket to learn
 * what it holds. The pipeline is the one the CDN page and `cdn-publish:v1` take (`src/lib/cdn-publish.mts`);
 * this file is its operator's caller.
 *
 * A key is `<name>/<version>/<file>` and is written once. `withdraw` takes a file out of the offer and
 * keeps its key taken; `--delete` removes the bytes as well.
 *
 * See GROUPS_AND_STORAGE.md, "A Site's CDN".
 */

type FlagMap = Map<string, string | boolean>;

export type PhisCdnCommandDeps = {
  root: string;
  pool: Pool;
  readSecret: StorageSecretReader;
  /** The Provider for a Profile; the installed artifact's by default, a fake in tests. */
  adapterFor?: (profile: SiteCdnProfileRecord) => Promise<PhisMediaStorageAdapter | null>;
  /** Progress lines while a file uploads; stderr by default. */
  progress?: (line: string) => void;
};

const NGINX_ACME_WEBROOT = "/var/www/phis-acme";

function optional(flags: FlagMap, key: string) {
  const value = flags.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function required(flags: FlagMap, key: string) {
  const value = optional(flags, key);
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

async function requireSite(pool: Pool, flags: FlagMap) {
  const siteKey = required(flags, "site").toLowerCase();
  const { rows } = await pool.query<{ id: number; key: string }>(`SELECT id, key FROM phis.sites WHERE key = $1`, [siteKey]);
  if (!rows[0]) throw new Error(`Site ${siteKey} does not exist.`);
  return rows[0];
}

function readProfile(pool: Pool, siteId: number, where: { id: number } | { key: string }) {
  return readSiteCdnProfile(pool, siteId, where);
}

async function adapterOf(deps: PhisCdnCommandDeps, profile: SiteCdnProfileRecord) {
  const adapter = deps.adapterFor
    ? await deps.adapterFor(profile)
    : await resolvePhiStorageAdapter(deps.root, profile.providerId, profile.config, profile.secretReference, deps.readSecret);
  if (!adapter) throw new Error(`Storage Profile "${profile.key}" is Core's Local storage, which cannot hold a CDN.`);
  return adapter;
}

/** A Site's CDN opened for the pipeline, by id; null where it has none. What `phis maintain` opens. */
export async function openPhisCdnTargetForCli(deps: PhisCdnCommandDeps, siteId: number): Promise<PhisCdnTarget | null> {
  const { rows } = await deps.pool.query<{ key: string }>(`SELECT key FROM phis.sites WHERE id = $1`, [siteId]);
  const cdn = await readSiteCdn(deps.pool, siteId);
  if (!rows[0] || !cdn) return null;
  const profile = await readProfile(deps.pool, siteId, { id: cdn.storageProfileId });
  if (!profile) return null;
  return { siteId, siteKey: rows[0].key, cdn, profile, storage: await adapterOf(deps, profile) };
}

/** The Site, its CDN, the Profile behind it and the Provider for that Profile. */
async function openCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const cdn = await readSiteCdn(deps.pool, site.id);
  if (!cdn) throw new Error(`Site ${site.key} has no CDN. Attach one first: phis cdn attach --site ${site.key} --profile <key> --public-base-url <url>.`);
  const profile = await readProfile(deps.pool, site.id, { id: cdn.storageProfileId });
  if (!profile) throw new Error(`The CDN of ${site.key} names Storage Profile #${cdn.storageProfileId}, which is gone.`);
  const adapter = await adapterOf(deps, profile);
  const target: PhisCdnTarget = { siteId: site.id, siteKey: site.key, cdn, profile, storage: adapter };
  return { site, cdn, profile, adapter, target };
}

/*
 * Delivery check: one small object under a key no publish can produce (a dotted first segment), fetched
 * through the public address and removed again. A host that does not deliver yet -- DNS still missing,
 * no certificate -- is a finding, not a failure, so the CDN can be attached before its host exists.
 */
async function checkDelivery(adapter: PhisMediaStorageAdapter, publicBaseUrl: string) {
  const key = `.phis-cdn-probe/${randomUUID()}.txt`;
  const body = `phis cdn probe ${randomUUID()}\n`;
  await adapter.putObject({ storageKey: key, body: Buffer.from(body), contentType: "text/plain" });
  try {
    const url = phisCdnPublicUrl(publicBaseUrl, key);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    const text = await response.text();
    if (response.ok && text === body) return { delivers: true as const, finding: null };
    return { delivers: false as const, finding: `${url} answered ${response.status}${response.ok ? " with other bytes" : ""}.` };
  } catch (error) {
    return { delivers: false as const, finding: `${publicBaseUrl} did not answer: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await adapter.deleteObject(key).catch(() => false);
  }
}

export async function attachCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const profileKey = required(flags, "profile");
  const publicBaseUrl = readPhisCdnPublicBaseUrl(required(flags, "public-base-url"));
  const profile = await readProfile(deps.pool, site.id, { key: profileKey });
  if (!profile) throw new Error(`Site ${site.key} has no Storage Profile "${profileKey}".`);
  if ((profile.flags & PhiMediaStorageProfileFlags.Cdn) === 0) {
    throw new Error(`Storage Profile "${profileKey}" is not a CDN Profile. Add the bucket with phis storage add --cdn.`);
  }
  if ((profile.flags & PhiMediaStorageProfileFlags.Disabled) !== 0) {
    throw new Error(`Storage Profile "${profileKey}" is disabled. Enable it first (phis storage enable).`);
  }
  const existing = await readSiteCdn(deps.pool, site.id);
  if (existing && existing.storageProfileId !== profile.id) {
    const offered = await listSiteCdnFiles(deps.pool, site.id, { limit: 1 });
    if (offered.length > 0) {
      throw new Error(`The CDN of ${site.key} already offers files from another Profile. Withdraw them before moving it.`);
    }
  }
  const adapter = await adapterOf(deps, profile);
  await deps.pool.query(
    `INSERT INTO phis.site_cdns (site_id, storage_profile_id, public_base_url) VALUES ($1, $2, $3)
     ON CONFLICT (site_id) DO UPDATE SET storage_profile_id = EXCLUDED.storage_profile_id,
       public_base_url = EXCLUDED.public_base_url, updated_at = NOW()`,
    [site.id, profile.id, publicBaseUrl],
  );
  return {
    ok: true,
    action: "cdn.attach" as const,
    site: site.key,
    profile: profile.key,
    publicBaseUrl,
    delivery: await checkDelivery(adapter, publicBaseUrl),
  };
}

export async function detachCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const cdn = await readSiteCdn(deps.pool, site.id);
  if (!cdn) throw new Error(`Site ${site.key} has no CDN.`);
  const offered = await listSiteCdnFiles(deps.pool, site.id, { limit: 1 });
  if (offered.length > 0) throw new Error(`The CDN of ${site.key} still offers files. Withdraw them first.`);
  if (await hasOpenSiteCdnUploads(deps.pool, site.id)) {
    throw new Error(`The CDN of ${site.key} has uploads open. Abort them on the CDN page, or wait for cdn-uploads.prune.`);
  }
  // The rows of withdrawn files go with it, and with them the record of which keys were taken. The bytes
  // their copies still hold leave the Site Space's count with them: the bucket is no longer the Site's.
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const stored = await sumSiteCdnStoredBytes(client, site.id);
    const spaceId = await readSiteMediaSpaceIdWithDb(client, site.id);
    if (spaceId !== null && stored > 0) await changeMediaSpaceUsedBytesWithDb(client, { spaceId, delta: -stored });
    await client.query(`DELETE FROM phis.site_cdns WHERE site_id = $1`, [site.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, action: "cdn.detach" as const, site: site.key };
}

/** `--os`/`--arch` as stated, else what the file name makes obvious (`guessPhisCdnPlatform`). */
function readPlatform(flags: FlagMap, fileName: string) {
  const guessed = guessPhisCdnPlatform(fileName);
  const os = optional(flags, "os");
  const arch = optional(flags, "arch");
  return {
    os: os === undefined ? guessed.os : readPhisCdnOsNames(os),
    arch: arch === undefined ? guessed.arch : readPhisCdnArchNames(arch),
  };
}

export async function publishCdnFile(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const progress = deps.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { site, target } = await openCdn(deps, flags);
  const file = path.resolve(required(flags, "file"));
  const fileName = optional(flags, "as") ?? path.basename(file);
  const platform = readPlatform(flags, fileName);
  const published = await publishPhisCdnFileFromDisk(deps.pool, target, {
    root: deps.root,
    file,
    name: required(flags, "name"),
    version: required(flags, "version"),
    fileName,
    ...(optional(flags, "content-type") ? { contentType: optional(flags, "content-type") } : {}),
    os: platform.os,
    arch: platform.arch,
    progress,
  });
  return {
    ok: true,
    action: "cdn.publish" as const,
    site: site.key,
    file: published.file,
    platform: namePhisCdnPlatform(published.file.os, published.file.arch),
    verified: published.verified,
  };
}

export async function listCdnFiles(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const cdn = await readSiteCdn(deps.pool, site.id);
  if (!cdn) throw new Error(`Site ${site.key} has no CDN.`);
  const profile = await readProfile(deps.pool, site.id, { id: cdn.storageProfileId });
  const rows = await listSiteCdnFiles(deps.pool, site.id, {
    name: optional(flags, "name") ?? null,
    includeWithdrawn: flags.get("withdrawn") === true,
    all: true,
  });
  return {
    ok: true,
    action: "cdn.list" as const,
    site: site.key,
    profile: profile?.key ?? null,
    publicBaseUrl: cdn.publicBaseUrl,
    files: rows.map((row) => {
      const file = presentPhisCdnAdminFile(row, cdn.publicBaseUrl);
      return {
        ...file,
        withdrawn: file.state !== "offered",
        deleted: file.state === "deleted",
        platform: namePhisCdnPlatform(file.os, file.arch),
      };
    }),
  };
}

export async function withdrawCdnFile(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, target } = await openCdn(deps, flags);
  const key = required(flags, "key");
  const remove = flags.get("delete") === true;
  const outcome = await withdrawPhisCdnFile(deps.pool, target, key, { remove });
  const linked = isPhisCdnFileLinked(outcome.row);
  return {
    ok: true,
    action: "cdn.withdraw" as const,
    site: site.key,
    key,
    alreadyWithdrawn: outcome.flags !== 0,
    deleted: outcome.deleted,
    note: remove
      ? linked
        ? "The link is deleted; its source keeps the file, which was never in the bucket."
        : "The bytes are gone from the bucket. A cache in front of the CDN may serve them until it expires."
      : "The file is no longer offered; a link already handed out keeps working. --delete removes the bytes.",
  };
}

/** Bucket against catalogue: what lies there unrecorded, what is recorded and gone, and sizes that disagree. */
export async function checkCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, target } = await openCdn(deps, flags);
  let report = await checkPhisCdnBucket(deps.pool, target);
  let adopted: string[] = [];
  if (flags.get("adopt") === true) {
    const adoptable = report.unrecorded.filter((entry) => (entry.flags & PhisCdnCheckObjectFlags.Adoptable) !== 0).map((entry) => entry.key);
    if (adoptable.length > 0) {
      adopted = (await adoptPhisCdnObjects(deps.pool, target, adoptable)).adopted;
      report = await checkPhisCdnBucket(deps.pool, target);
    }
  }
  return {
    ok: (report.flags & PhisCdnCheckReportFlags.Consistent) !== 0,
    action: "cdn.check" as const,
    site: site.key,
    ...report,
    adopted,
  };
}

/** `phis maintain --task cdn-uploads`: the Core job's run, with the stores reached the CLI's way. */
export function prunePhisCdnUploadsForCli(deps: PhisCdnCommandDeps, options: { dryRun: boolean }) {
  return prunePhisCdnUploads(deps.pool, {
    dryRun: options.dryRun,
    openTarget: (siteId) => openPhisCdnTargetForCli(deps, siteId),
  });
}

/** The server block of the CDN's host: GET only, cached for good, never rendered, a proxy to the bucket. */
export function renderPhisCdnNginxConfig(input: { host: string; upstream: string; tls: boolean }) {
  // A map is http-wide, so its variable carries the host: two CDNs on one nginx must not clash.
  const cacheVariable = `phis_cdn_cache_${input.host.replace(/[^A-Za-z0-9]/gu, "_")}`;
  const proxy = [
    "    location / {",
    "        limit_except GET { deny all; }",
    `        proxy_pass ${input.upstream};`,
    "        proxy_http_version 1.1;",
    "        # Garage serves the bucket named after the host it is asked for.",
    "        proxy_set_header Host $host;",
    "        proxy_buffering off;",
    "        proxy_hide_header Cache-Control;",
    "        proxy_hide_header Content-Disposition;",
    "        # A key is written once, so its bytes never change; an answer without them may change.",
    `        add_header Cache-Control $${cacheVariable} always;`,
    "        # Downloaded, never rendered: a <video> or <img> still plays, a navigation saves the file.",
    "        add_header Content-Disposition \"attachment\" always;",
    "        add_header X-Content-Type-Options \"nosniff\" always;",
    ...(input.tls ? ["        add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;"] : []),
    "    }",
  ];
  const acme = [
    "    location /.well-known/acme-challenge/ {",
    `        root ${NGINX_ACME_WEBROOT};`,
    "    }",
  ];
  const lines = [
    `# The CDN of a phis Site, written by phis cdn nginx. Written whole each time: change the flags, not the file.`,
    "",
    "# Only a file is cached for good. A 404 must not outlive the publish that ends it.",
    `map $status $${cacheVariable} {`,
    "    200 \"public, max-age=31536000, immutable\";",
    "    206 \"public, max-age=31536000, immutable\";",
    "    304 \"public, max-age=31536000, immutable\";",
    "    default \"no-store\";",
    "}",
    "",
    "server {",
    "    listen 80;",
    "    listen [::]:80;",
    `    server_name ${input.host};`,
    "",
    ...acme,
    "",
    ...(input.tls ? ["    location / {", "        return 301 https://$host$request_uri;", "    }"] : proxy),
    "}",
  ];
  if (input.tls) {
    lines.push(
      "",
      "server {",
      "    listen 443 ssl;",
      "    listen [::]:443 ssl;",
      `    server_name ${input.host};`,
      "",
      `    ssl_certificate /etc/letsencrypt/live/${input.host}/fullchain.pem;`,
      `    ssl_certificate_key /etc/letsencrypt/live/${input.host}/privkey.pem;`,
      "",
      ...proxy,
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

function readUpstream(flags: FlagMap) {
  const upstream = required(flags, "upstream");
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error(`--upstream "${upstream}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--upstream must be http or https.");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("--upstream takes an origin, without a path.");
  return url.origin;
}

function writeNginx(host: string, content: string) {
  if (!existsSync("/etc/nginx/sites-available") || !commandExists("nginx")) {
    throw new Error("nginx is not installed here. Leave out --write and place the printed file yourself.");
  }
  const available = `/etc/nginx/sites-available/${host}.conf`;
  const enabled = `/etc/nginx/sites-enabled/${host}.conf`;
  const steps: PhiCommandStep[] = [];
  mkdirSync(path.join(NGINX_ACME_WEBROOT, ".well-known", "acme-challenge"), { recursive: true, mode: 0o755 });
  writeFileSync(available, content, { mode: 0o644 });
  if (!existsSync(enabled)) {
    symlinkSync(available, enabled);
    steps.push({ command: `ln -s ${available} ${enabled}`, ok: true, output: "" });
  }
  steps.push(runPhiSystemCommand("nginx", ["-t"]));
  steps.push(runPhiSystemCommand("systemctl", ["reload-or-restart", "nginx"]));
  return { path: available, steps };
}

async function readCdnHost(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const cdn = await readSiteCdn(deps.pool, site.id);
  if (!cdn) throw new Error(`Site ${site.key} has no CDN.`);
  const url = new URL(cdn.publicBaseUrl);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`The CDN of ${site.key} is served under a path (${cdn.publicBaseUrl}); its host is not this command's to configure.`);
  }
  return { site, host: url.hostname };
}

/** `phis cdn nginx`: prints the host's file, or with `--write` puts it in place and reloads. */
export async function configureCdnNginx(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, host } = await readCdnHost(deps, flags);
  const content = renderPhisCdnNginxConfig({ host, upstream: readUpstream(flags), tls: flags.get("tls") === true });
  if (flags.get("write") !== true) return { ok: true, action: "cdn.nginx" as const, site: site.key, host, written: null, content };
  return { ok: true, action: "cdn.nginx" as const, site: site.key, host, written: writeNginx(host, content), content };
}

/** `phis cdn tls`: the plain file, a certificate over its challenge, then the HTTPS file. */
export async function obtainCdnTls(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, host } = await readCdnHost(deps, flags);
  const upstream = readUpstream(flags);
  writeNginx(host, renderPhisCdnNginxConfig({ host, upstream, tls: false }));
  const certificate = obtainPhiCertificate({ kind: "nginx", domain: host, email: optional(flags, "email") ?? null });
  const written = writeNginx(host, renderPhisCdnNginxConfig({ host, upstream, tls: true }));
  return { ok: true, action: "cdn.tls" as const, site: site.key, host, certificate: certificate.command, written };
}

export async function runPhisCdnCommand(deps: PhisCdnCommandDeps, command: string | undefined, flags: FlagMap) {
  switch (command) {
    case "attach": return attachCdn(deps, flags);
    case "detach": return detachCdn(deps, flags);
    case "publish": return publishCdnFile(deps, flags);
    case "list": return listCdnFiles(deps, flags);
    case "withdraw": return withdrawCdnFile(deps, flags);
    case "check": return checkCdn(deps, flags);
    case "nginx": return configureCdnNginx(deps, flags);
    case "tls": return obtainCdnTls(deps, flags);
    default:
      throw new Error("Unknown cdn command. Use: attach, detach, publish, list, withdraw, check, nginx, tls");
  }
}
