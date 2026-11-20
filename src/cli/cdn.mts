import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import type { Pool } from "pg";

import { resolvePhiMediaUploadPartCount, resolvePhiMediaUploadPartSizeBytes } from "@phis/contracts/addon";
import type { PhiMediaUploadPlan, PhisMediaObjectHead, PhisMediaStorageAdapter } from "@phis/contracts/addon";

import { insertSiteCdnFile, listSiteCdnFiles, readSiteCdn, readSiteCdnFile, withdrawSiteCdnFile } from "../db/site-cdn.mts";
import {
  buildPhisCdnKey,
  PhisCdnFileFlags,
  phisCdnPublicUrl,
  presentPhisCdnFile,
  readPhisCdnKey,
  readPhisCdnPublicBaseUrl,
  resolvePhisCdnContentType,
} from "../lib/cdn-core.ts";
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
 * what it holds. What an Add-on sees of it is `cdn:v1`, read-only.
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
  adapterFor?: (profile: CdnProfileRecord) => Promise<PhisMediaStorageAdapter | null>;
  /** Progress lines while a file uploads; stderr by default. */
  progress?: (line: string) => void;
};

type CdnProfileRecord = {
  id: number;
  key: string;
  providerId: string;
  config: Record<string, unknown>;
  secretReference: string | null;
  flags: number;
  checksumAlgorithm: string | null;
};

const PART_ATTEMPTS = 3;
const PART_CONCURRENCY = 4;
const UPLOAD_PLAN_TTL_MS = 15 * 60 * 1000;
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

async function readProfile(pool: Pool, siteId: number, where: { id: number } | { key: string }) {
  const byId = "id" in where;
  const { rows } = await pool.query<{
    id: number; key: string; provider_id: string; config: Record<string, unknown>;
    secret_reference: string | null; flags: number; checksum_algorithm: string | null;
  }>(
    `SELECT id, key, provider_id, config, secret_reference, flags, checksum_algorithm
       FROM phis.media_storage_profiles WHERE site_id = $1 AND ${byId ? "id = $2" : "key = $2"}`,
    [siteId, byId ? where.id : where.key],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    providerId: row.provider_id,
    config: row.config ?? {},
    secretReference: row.secret_reference,
    flags: row.flags,
    checksumAlgorithm: row.checksum_algorithm,
  } satisfies CdnProfileRecord;
}

async function adapterOf(deps: PhisCdnCommandDeps, profile: CdnProfileRecord) {
  const adapter = deps.adapterFor
    ? await deps.adapterFor(profile)
    : await resolvePhiStorageAdapter(deps.root, profile.providerId, profile.config, profile.secretReference, deps.readSecret);
  if (!adapter) throw new Error(`Storage Profile "${profile.key}" is Core's Local storage, which cannot hold a CDN.`);
  return adapter;
}

/** The Site, its CDN, the Profile behind it and the Provider for that Profile. */
async function openCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const site = await requireSite(deps.pool, flags);
  const cdn = await readSiteCdn(deps.pool, site.id);
  if (!cdn) throw new Error(`Site ${site.key} has no CDN. Attach one first: phis cdn attach --site ${site.key} --profile <key> --public-base-url <url>.`);
  const profile = await readProfile(deps.pool, site.id, { id: cdn.storageProfileId });
  if (!profile) throw new Error(`The CDN of ${site.key} names Storage Profile #${cdn.storageProfileId}, which is gone.`);
  return { site, cdn, profile, adapter: await adapterOf(deps, profile) };
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
  // The rows of withdrawn files go with it, and with them the record of which keys were taken.
  await deps.pool.query(`DELETE FROM phis.site_cdns WHERE site_id = $1`, [site.id]);
  return { ok: true, action: "cdn.detach" as const, site: site.key };
}

/** The whole file's SHA-256 and, where it goes in parts, each part's, in one read. */
async function hashFile(file: string, partSizeBytes: number | null) {
  const whole = createHash("sha256");
  const parts: string[] = [];
  let part = partSizeBytes ? createHash("sha256") : null;
  let inPart = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }) as AsyncIterable<Buffer>) {
    whole.update(chunk);
    if (!part || !partSizeBytes) continue;
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(partSizeBytes - inPart, chunk.length - offset);
      part.update(chunk.subarray(offset, offset + take));
      inPart += take;
      offset += take;
      if (inPart === partSizeBytes) {
        parts.push(part.digest("hex"));
        part = createHash("sha256");
        inPart = 0;
      }
    }
  }
  if (part && inPart > 0) parts.push(part.digest("hex"));
  return { sha256: whole.digest("hex"), parts };
}

/** One range of the file to one presigned address, with its length stated; answers the entity tag. */
function putRange(url: string, headers: Record<string, string> | undefined, file: string, start: number, length: number) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise<string>((resolve, reject) => {
    const request = client.request(target, {
      method: "PUT",
      headers: { ...(headers ?? {}), "content-length": String(length) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(String(response.headers.etag ?? ""));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const code = /<Code>([^<]+)<\/Code>/u.exec(body)?.[1];
        reject(new Error(`The storage refused the upload (${status}${code ? ` ${code}` : ""}).`));
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (length === 0) {
      request.end();
      return;
    }
    const stream = createReadStream(file, { start, end: start + length - 1 });
    stream.on("error", (error) => request.destroy(error));
    stream.pipe(request);
  });
}

async function putRangeWithRetry(...args: Parameters<typeof putRange>) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    try {
      return await putRange(...args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/*
 * What lets an interrupted multipart upload carry on: the storage's name for the assembly, kept beside
 * the stage because nothing else outlives the command. The parts themselves are the storage's to report
 * (`resumeUploadPlan`), so this holds no tally that could disagree with it.
 */
type ResumeState = { key: string; sizeBytes: number; sha256: string; contentType: string; uploadId: string };

function resumeStatePath(root: string, siteKey: string, key: string) {
  return path.join(root, "cdn-uploads", `${siteKey}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json`);
}

function readResumeState(file: string): ResumeState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ResumeState;
  } catch {
    return null;
  }
}

function writeResumeState(file: string, state: ResumeState) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export async function publishCdnFile(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const progress = deps.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { site, cdn, profile, adapter } = await openCdn(deps, flags);
  if ((profile.flags & PhiMediaStorageProfileFlags.Disabled) !== 0) {
    throw new Error(`Storage Profile "${profile.key}" is disabled and takes no new files.`);
  }
  const file = path.resolve(required(flags, "file"));
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${file} is not a file.`);
  const parts = buildPhisCdnKey(required(flags, "name"), required(flags, "version"), optional(flags, "as") ?? path.basename(file));
  const contentType = resolvePhisCdnContentType(parts.fileName, optional(flags, "content-type"));

  if (await readSiteCdnFile(deps.pool, site.id, parts.key, { includeWithdrawn: true })) {
    throw new Error(`${parts.key} is already published on ${site.key}. A key is written once: publish a new version.`);
  }
  if (await adapter.headObject(parts.key)) {
    throw new Error(`An object already lies at ${parts.key} in the bucket. Catalogue it with phis cdn check --adopt, or choose another version.`);
  }

  const sizeBytes = stat.size;
  const partSizeBytes = resolvePhiMediaUploadPartSizeBytes(sizeBytes);
  const multipart = sizeBytes > partSizeBytes;
  progress(`Reading ${path.basename(file)} (${sizeBytes} bytes)...`);
  const digest = await hashFile(file, multipart ? partSizeBytes : null);
  if (multipart && digest.parts.length !== resolvePhiMediaUploadPartCount(sizeBytes)) {
    throw new Error("The file changed while it was read.");
  }
  // Digests go into the signature only where the probe found the storage verifies SHA-256.
  const verifies = profile.checksumAlgorithm === "sha256";
  const expiresAt = new Date(Date.now() + UPLOAD_PLAN_TTL_MS).toISOString();
  const stateFile = resumeStatePath(deps.root, site.key, parts.key);

  let plan: PhiMediaUploadPlan | null = null;
  let uploaded: { partNumber: number; eTag: string }[] = [];
  const previous = readResumeState(stateFile);
  if (multipart && previous && previous.key === parts.key && previous.sizeBytes === sizeBytes && previous.sha256 === digest.sha256) {
    const resumption = await adapter.resumeUploadPlan({
      storageKey: parts.key,
      uploadId: previous.uploadId,
      contentType: previous.contentType,
      sizeBytes,
      expiresAt,
      ...(verifies ? { partChecksums: digest.parts } : {}),
    });
    if (resumption) {
      plan = resumption.plan;
      uploaded = resumption.uploaded.map((part) => ({ partNumber: part.partNumber, eTag: part.eTag }));
      progress(`Carrying on an earlier upload: ${uploaded.length} of ${digest.parts.length} parts are there.`);
    }
  }
  if (!plan) {
    plan = await adapter.createUploadPlan({
      token: randomUUID(),
      storageKey: parts.key,
      contentType,
      sizeBytes,
      expiresAt,
      proxyUploadUrl: "",
      mayAssembleFromParts: multipart,
      ...(verifies && !multipart ? { checksum: { algorithm: "sha256" as const, value: digest.sha256 } } : {}),
      ...(verifies && multipart ? { partChecksums: digest.parts } : {}),
    });
  }

  let completion: unknown;
  if (plan.kind === "proxy-stream") {
    throw new Error(
      `Storage Profile "${profile.key}" has no public endpoint, so its Provider offers no direct upload. ` +
      "Set publicEndpoint to the address this host reaches the storage at (it may equal endpoint).",
    );
  } else if (plan.kind === "presigned-put") {
    progress("Uploading...");
    await putRangeWithRetry(plan.url, plan.headers, file, 0, sizeBytes);
  } else {
    writeResumeState(stateFile, { key: parts.key, sizeBytes, sha256: digest.sha256, contentType, uploadId: plan.uploadId });
    const queue = [...plan.parts];
    const total = digest.parts.length;
    const sent: { partNumber: number; eTag: string }[] = [];
    const partSize = plan.partSizeBytes;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const start = (next.partNumber - 1) * partSize;
        const length = Math.min(partSize, sizeBytes - start);
        const eTag = await putRangeWithRetry(next.url, next.headers, file, start, length);
        if (!eTag) throw new Error(`The storage answered part ${next.partNumber} without an entity tag.`);
        sent.push({ partNumber: next.partNumber, eTag });
        progress(`part ${uploaded.length + sent.length}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, worker));
    completion = {
      uploadId: plan.uploadId,
      parts: [...uploaded, ...sent].sort((left, right) => left.partNumber - right.partNumber),
    };
  }

  const head: PhisMediaObjectHead | null = await adapter.completeUpload({ storageKey: parts.key, completion });
  if (!head) throw new Error(`The storage holds nothing at ${parts.key} after the upload.`);
  if (head.byteSize !== sizeBytes) {
    throw new Error(`The storage holds ${head.byteSize} bytes at ${parts.key}, not ${sizeBytes}. Nothing was recorded.`);
  }
  if (head.checksum?.algorithm === "sha256" && head.checksum.value.toLowerCase() !== digest.sha256) {
    throw new Error(`The storage reports another SHA-256 for ${parts.key} than the file has. Nothing was recorded.`);
  }
  rmSync(stateFile, { force: true });

  const recorded = await insertSiteCdnFile(deps.pool, {
    siteId: site.id,
    key: parts.key,
    name: parts.name,
    version: parts.version,
    fileName: parts.fileName,
    sizeBytes,
    sha256: digest.sha256,
    contentType,
  });
  if (!recorded) throw new Error(`${parts.key} was published by somebody else at the same time.`);
  const row = await readSiteCdnFile(deps.pool, site.id, parts.key);
  return {
    ok: true,
    action: "cdn.publish" as const,
    site: site.key,
    file: presentPhisCdnFile(row!, cdn.publicBaseUrl),
    verified: verifies,
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
    files: rows.map((row) => ({
      ...presentPhisCdnFile(row, cdn.publicBaseUrl),
      withdrawn: (row.flags & PhisCdnFileFlags.Withdrawn) !== 0,
    })),
  };
}

export async function withdrawCdnFile(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, adapter } = await openCdn(deps, flags);
  const key = required(flags, "key");
  const row = await readSiteCdnFile(deps.pool, site.id, key, { includeWithdrawn: true });
  if (!row) throw new Error(`${key} is not published on ${site.key}.`);
  const withdrawn = await withdrawSiteCdnFile(deps.pool, site.id, key);
  const remove = flags.get("delete") === true;
  const deleted = remove ? await adapter.deleteObject(key) : false;
  return {
    ok: true,
    action: "cdn.withdraw" as const,
    site: site.key,
    key,
    alreadyWithdrawn: !withdrawn,
    deleted,
    note: remove
      ? "The bytes are gone from the bucket. A cache in front of the CDN may serve them until it expires."
      : "The file is no longer offered; a link already handed out keeps working. --delete removes the bytes.",
  };
}

/** Bucket against catalogue: what lies there unrecorded, what is recorded and gone, and sizes that disagree. */
export async function checkCdn(deps: PhisCdnCommandDeps, flags: FlagMap) {
  const { site, adapter } = await openCdn(deps, flags);
  const adopt = flags.get("adopt") === true;
  const objects = await adapter.listPrefix("");
  const rows = await listSiteCdnFiles(deps.pool, site.id, { includeWithdrawn: true, all: true });
  const byKey = new Map(rows.map((row) => [row.object_key, row]));
  const inBucket = new Set(objects.map((object) => object.storageKey));

  const unrecorded: { key: string; sizeBytes: number; adoptable: boolean; reason: string | null }[] = [];
  const adopted: string[] = [];
  const sizeMismatch: { key: string; recorded: number; stored: number }[] = [];
  for (const object of objects) {
    const row = byKey.get(object.storageKey);
    if (row) {
      if (Number(row.size_bytes) !== object.byteSize) {
        sizeMismatch.push({ key: object.storageKey, recorded: Number(row.size_bytes), stored: object.byteSize });
      }
      continue;
    }
    const parts = readPhisCdnKey(object.storageKey);
    let reason: string | null = parts ? null : "not <name>/<version>/<file>";
    let contentType: string | null = null;
    if (parts) {
      try {
        buildPhisCdnKey(parts.name, parts.version, parts.fileName);
        contentType = resolvePhisCdnContentType(parts.fileName, object.contentType);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (adopt && parts && contentType && !reason) {
      const stream = await adapter.getObjectStream(object.storageKey);
      if (!stream) continue;
      const hash = createHash("sha256");
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) hash.update(chunk);
      await insertSiteCdnFile(deps.pool, {
        siteId: site.id,
        key: parts.key,
        name: parts.name,
        version: parts.version,
        fileName: parts.fileName,
        sizeBytes: object.byteSize,
        sha256: hash.digest("hex"),
        contentType,
      });
      adopted.push(parts.key);
      continue;
    }
    unrecorded.push({ key: object.storageKey, sizeBytes: object.byteSize, adoptable: Boolean(parts && contentType && !reason), reason });
  }
  // A withdrawn file whose bytes are gone is what `withdraw --delete` leaves; only an offered one is missing.
  const missing = rows
    .filter((row) => (row.flags & PhisCdnFileFlags.Withdrawn) === 0 && !inBucket.has(row.object_key))
    .map((row) => row.object_key);
  return {
    ok: missing.length === 0 && sizeMismatch.length === 0,
    action: "cdn.check" as const,
    site: site.key,
    objects: objects.length,
    recorded: rows.length,
    unrecorded,
    adopted,
    missing,
    sizeMismatch,
  };
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
