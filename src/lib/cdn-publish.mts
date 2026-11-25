import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable, Transform } from "node:stream";

import type { Pool, PoolClient } from "pg";

import {
  PHIS_CDN_FILE_ARCH_MASK,
  PHIS_CDN_FILE_OS_MASK,
  PhisCdnFileOrigin,
  PhisCdnPublishResultFlags,
  resolvePhiMediaUploadPartCount,
  resolvePhiMediaUploadPartSizeBytes,
} from "@phis/contracts/addon";
import type {
  PhiMediaUploadPlan,
  PhisCdnFileV1,
  PhisCdnImportRefusalV1,
  PhisCdnImportRequestV1,
  PhisCdnImportResultV1,
  PhisCdnLinkRefusalV1,
  PhisCdnLinkRequestV1,
  PhisCdnLinkResultV1,
  PhisCdnUploadInitV1,
  PhisMediaObjectHead,
  PhisMediaStorageAdapter,
} from "@phis/contracts/addon";

import {
  changeMediaSpaceUsedBytesWithDb,
  commitMediaSpaceReservationWithDb,
  readSiteMediaSpaceIdWithDb,
  releaseMediaSpaceReservationWithDb,
  reserveMediaSpaceQuotaWithDb,
} from "../db/media-space-quota.mts";
import {
  beatSiteCdnUploadHashing,
  claimStaleSiteCdnUploadHashing,
  countSiteCdnUploadMaintenance,
  endSiteCdnUpload,
  forgetEndedSiteCdnUploads,
  insertSiteCdnFile,
  insertSiteCdnUpload,
  isSiteCdnNameHeldByOthers,
  listExpiredSiteCdnUploads,
  readOpenSiteCdnUpload,
  readSiteCdnFile,
  renewSiteCdnUpload,
  setSiteCdnUploadProviderId,
  startSiteCdnUploadHashing,
  type SiteCdnFileOriginInput,
  type SiteCdnProfileRecord,
  type SiteCdnRecord,
  type SiteCdnUploadRecord,
} from "../db/site-cdn.mts";
import {
  encodePhisCdnPlatformFlags,
  explainPhisCdnKeyRefusal,
  isPhisCdnFileLinked,
  isPhisCdnPlatform,
  PhisCdnFileFlags,
  PhisCdnUploadStatusCode,
  presentPhisCdnFile,
  resolvePhisCdnContentType,
  type PhisCdnFileRow,
  type PhisCdnKeyParts,
} from "./cdn-core.ts";
import { PhiMediaStorageProfileFlags } from "./constants/media.ts";
import {
  buildPhisCdnImportPolicy,
  explainPhisOutboundUrlRefusal,
  fetchPhisOutbound,
  isPhisOutboundHtml,
  PhisOutboundFetchError,
  type PhisOutboundOptions,
} from "./outbound-fetch.ts";

/*
 * The one pipeline every file takes into a Site's CDN: the operator's `phis cdn publish`, a Maintainer's
 * upload on the CDN page (`/api/site/admin/cdn/uploads`), and an Add-on's import or link through
 * `cdn-publish:v1`. Each road moves the bytes its own way -- ranges of a file on disk, parts relayed from
 * a browser, a source Core fetches -- and every one of them goes through the same checks, the same
 * upload plans of the Provider, and the same write of the catalogue row, its origin and the Site Space's
 * bytes in one transaction.
 *
 * Loadable by the CLI as well as the Server: relative imports, no `server-only`, the storage and the pool
 * handed in. See GROUPS_AND_STORAGE.md, "A Site's CDN".
 */

/** What the pipeline calls on the CDN's storage. */
export type PhisCdnStorage = Pick<
  PhisMediaStorageAdapter,
  | "createUploadPlan" | "resumeUploadPlan" | "completeUpload" | "headObject" | "getObjectStream" | "getObjectRangeStream"
  | "deleteObject" | "listPrefix"
>;

/** One Site's CDN, opened: the catalogue's Site, its Profile and the storage behind it. */
export type PhisCdnTarget = {
  siteId: number;
  siteKey: string;
  cdn: SiteCdnRecord;
  profile: SiteCdnProfileRecord;
  storage: PhisCdnStorage;
};

/** Why a file was not taken. The import refusals, and two the CDN page answers on its own. */
export type PhisCdnPublishRefusalCode =
  | PhisCdnImportRefusalV1
  /** An object lies at the key in the bucket that the catalogue does not hold (check, then adopt). */
  | "object-present"
  /** The browser's part digests do not divide the size as the Media upload does. */
  | "part-digests"
  /** The Profile's Provider offers no direct upload (no public endpoint). */
  | "no-public-endpoint";

export class PhisCdnPublishRefusal extends Error {
  readonly code: PhisCdnPublishRefusalCode;
  readonly detail: Record<string, unknown>;

  constructor(code: PhisCdnPublishRefusalCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PhisCdnPublishRefusal";
    this.code = code;
    this.detail = detail;
  }
}

/** How long an upload lives without a heartbeat or a part; each one pushes it this far ahead. */
export const PHIS_CDN_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the CDN page says it is still sending. */
export const PHIS_CDN_UPLOAD_HEARTBEAT_INTERVAL_MS = 20_000;
/** How long an import may go without a part before the prune job ends it: its instance died. */
export const PHIS_CDN_IMPORT_TTL_MS = 15 * 60 * 1000;
/** How long a `hashing` upload may go without a heartbeat before the prune job takes it over. */
export const PHIS_CDN_HASHING_LAPSE_MS = 10 * 60 * 1000;
/** How long an ended upload's row is kept. */
export const PHIS_CDN_UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How many parts an import sends at once: its memory is this many parts, plus the one being read. */
export const PHIS_CDN_IMPORT_PART_CONCURRENCY = 2;

const PRESIGN_TTL_MS = 15 * 60 * 1000;
const PART_ATTEMPTS = 3;
const CLI_PART_CONCURRENCY = 4;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/** Whether the CDN's storage checks a signed SHA-256 of what it is sent (the Profile's probe). */
export function phisCdnVerifiesSha256(profile: Pick<SiteCdnProfileRecord, "checksumAlgorithm">) {
  return profile.checksumAlgorithm === "sha256";
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Checks every road shares                                                                       */
/* ---------------------------------------------------------------------------------------------- */

export function readPhisCdnKeyOrRefuse(name: string, version: string, fileName: string): PhisCdnKeyParts {
  const refusal = explainPhisCdnKeyRefusal(name, version, fileName);
  if (refusal) throw new PhisCdnPublishRefusal("invalid-key", refusal);
  return { key: `${name}/${version}/${fileName}`, name, version, fileName };
}

export function resolvePhisCdnContentTypeOrRefuse(fileName: string, stated?: string | null) {
  try {
    return resolvePhisCdnContentType(fileName, stated);
  } catch (error) {
    throw new PhisCdnPublishRefusal("content-type-refused", error instanceof Error ? error.message : String(error));
  }
}

function refuseTooLarge(sizeBytes: number, maxObjectBytes: number | null) {
  if (maxObjectBytes !== null && sizeBytes > maxObjectBytes) {
    throw new PhisCdnPublishRefusal(
      "too-large",
      `${sizeBytes} bytes is larger than the ${maxObjectBytes} bytes one object may be on this Site (Media settings).`,
      { sizeBytes, maxObjectBytes },
    );
  }
}

function refuseDisabled(target: PhisCdnTarget) {
  if ((target.profile.flags & PhiMediaStorageProfileFlags.Disabled) !== 0) {
    throw new PhisCdnPublishRefusal("storage-failed", `Storage Profile "${target.profile.key}" is disabled and takes no new files.`);
  }
}

async function refuseBusy(db: Pool | PoolClient, siteId: number, key: string) {
  if (await readOpenSiteCdnUpload(db, siteId, key)) {
    throw new PhisCdnPublishRefusal("busy", `An upload of ${key} is open elsewhere.`);
  }
}

async function refuseObjectPresent(target: PhisCdnTarget, key: string) {
  if (await target.storage.headObject(key)) {
    throw new PhisCdnPublishRefusal(
      "object-present",
      `An object already lies at ${key} in the bucket. Catalogue it through the CDN check (adopt), or choose another version.`,
    );
  }
}

/** The Site Space the CDN's copies are counted in; the Server makes it before it publishes. */
async function requireSiteSpaceId(db: Pool | PoolClient, siteId: number) {
  const spaceId = await readSiteMediaSpaceIdWithDb(db, siteId);
  if (spaceId === null) throw new Error("The Site has no Site Space to count its CDN files in.");
  return spaceId;
}

async function reserveSiteBytes(db: Pool | PoolClient, siteId: number, bytes: number) {
  const spaceId = await requireSiteSpaceId(db, siteId);
  if (!await reserveMediaSpaceQuotaWithDb(db, { spaceId, bytes })) {
    throw new PhisCdnPublishRefusal("quota-exceeded", "Storing it would pass the quota of the Site Space, which copied CDN files count in.", {
      requestedBytes: bytes,
    });
  }
}

async function releaseSiteBytes(db: Pool | PoolClient, siteId: number, bytes: number) {
  const spaceId = await readSiteMediaSpaceIdWithDb(db, siteId);
  if (spaceId !== null) await releaseMediaSpaceReservationWithDb(db, { spaceId, bytes });
}

/**
 * How a recorded copy is booked into the Site Space: `reserved` moves a reservation taken earlier to
 * used, `stored` adds to used without a quota check (the operator's publish, an adopted object), and
 * `none` books nothing (a link).
 */
type PhisCdnBooking = "reserved" | "stored" | "none";

/**
 * Writes the catalogue row and its origin, books the bytes and ends the upload row, in one transaction.
 * Throws `key-taken` where somebody recorded the key in the meantime.
 */
async function recordPhisCdnFile(pool: Pool, target: Pick<PhisCdnTarget, "siteId" | "cdn">, input: {
  parts: PhisCdnKeyParts;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  flags: number;
  origin: SiteCdnFileOriginInput;
  booking: PhisCdnBooking;
  uploadToken?: string | null;
}): Promise<PhisCdnFileRow> {
  return await inTransaction(pool, async (client) => {
    const recorded = await insertSiteCdnFile(client, {
      siteId: target.siteId,
      key: input.parts.key,
      name: input.parts.name,
      version: input.parts.version,
      fileName: input.parts.fileName,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      contentType: input.contentType,
      flags: input.flags,
      origin: input.origin,
    });
    if (!recorded) throw new PhisCdnPublishRefusal("key-taken", `${input.parts.key} was recorded by somebody else at the same time.`);
    if (input.booking === "reserved") {
      await commitMediaSpaceReservationWithDb(client, { spaceId: await requireSiteSpaceId(client, target.siteId), bytes: input.sizeBytes });
    } else if (input.booking === "stored") {
      // The operator's bytes are stored whether or not they fit; without a Site Space there is nothing to count in.
      const spaceId = await readSiteMediaSpaceIdWithDb(client, target.siteId);
      if (spaceId !== null) await changeMediaSpaceUsedBytesWithDb(client, { spaceId, delta: input.sizeBytes });
    }
    if (input.uploadToken) {
      await endSiteCdnUpload(client, input.uploadToken, PhisCdnUploadStatusCode.Published);
    }
    return (await readSiteCdnFile(client, target.siteId, input.parts.key, { includeWithdrawn: true }))!;
  });
}

/* ---------------------------------------------------------------------------------------------- */
/* Moving bytes                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export class PhisCdnStorageRefusal extends Error {
  readonly status: number;
  readonly storageCode: string | null;

  constructor(status: number, storageCode: string | null) {
    super(`The storage refused the upload (${status}${storageCode ? ` ${storageCode}` : ""}).`);
    this.name = "PhisCdnStorageRefusal";
    this.status = status;
    this.storageCode = storageCode;
  }

  /** A part whose bytes did not match the digest signed into its request. */
  get digestMismatch() {
    return this.status === 400 && /digest|checksum|sha256/iu.test(this.storageCode ?? "");
  }
}

export class PhisCdnBodyLengthError extends Error {
  constructor(expected: number, received: number) {
    super(`The body carried ${received} bytes where ${expected} were expected.`);
    this.name = "PhisCdnBodyLengthError";
  }
}

/** Stops a body that carries more or fewer bytes than its stated length, so a PUT is never left waiting. */
function exactLength(expected: number) {
  let received = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > expected) callback(new PhisCdnBodyLengthError(expected, received));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(received === expected ? null : new PhisCdnBodyLengthError(expected, received));
    },
  });
}

/**
 * One body to one presigned address, its length stated, streamed and never buffered here; answers the
 * entity tag. A body of another length fails as `PhisCdnBodyLengthError`, a refusal of the storage as
 * `PhisCdnStorageRefusal`.
 */
export function putPhisCdnBody(input: {
  url: string;
  headers?: Record<string, string>;
  body: Readable | Buffer;
  length: number;
  signal?: AbortSignal;
}) {
  const target = new URL(input.url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };
    const request = client.request(target, {
      method: "PUT",
      headers: { ...(input.headers ?? {}), "content-length": String(input.length) },
      ...(input.signal ? { signal: input.signal } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          resolve(String(response.headers.etag ?? ""));
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        reject(new PhisCdnStorageRefusal(status, /<Code>([^<]+)<\/Code>/u.exec(body)?.[1] ?? null));
      });
      response.on("error", fail);
    });
    request.on("error", fail);
    if (Buffer.isBuffer(input.body)) {
      if (input.body.length !== input.length) {
        fail(new PhisCdnBodyLengthError(input.length, input.body.length));
        return;
      }
      request.end(input.body);
      return;
    }
    const counted = input.body.pipe(exactLength(input.length));
    input.body.on("error", fail);
    counted.on("error", fail);
    counted.pipe(request);
  });
}

async function withRetry<T>(work: () => Promise<T>, attempts = PART_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      // A body that was the wrong length or bytes the storage refused by digest will be so again.
      if (error instanceof PhisCdnBodyLengthError || (error instanceof PhisCdnStorageRefusal && error.digestMismatch)) break;
    }
  }
  throw lastError;
}

/** The parts of an assembly in order, as `completeUpload` wants them. */
function sortParts(parts: readonly { partNumber: number; eTag: string }[]) {
  return [...parts].map((part) => ({ partNumber: part.partNumber, eTag: part.eTag }))
    .sort((left, right) => left.partNumber - right.partNumber);
}

/** Gives an assembly up: an empty completion is how a Provider is told to abort (`media-upload-staging.ts`). */
async function abandonAssembly(storage: PhisCdnStorage, key: string, uploadId: string | null) {
  if (!uploadId) return;
  await storage.completeUpload({ storageKey: key, completion: { uploadId, parts: [] } }).catch(() => null);
}

/**
 * The whole object's SHA-256 from the bucket, and each part's where it was sent in parts.
 *
 * Read range by range, one part (or 16 MiB) at a time, so each request stays bounded and every part's
 * digest falls out of the same pass. A whole GET would work too since @phis/storage-s3 validates
 * response checksums only when asked (6d7dd15; before it, an assembled object's composite checksum was
 * compared with the body's plain SHA-256 and refused, measured against Garage 2.3.0).
 */
export async function hashPhisCdnObject(
  storage: Pick<PhisCdnStorage, "getObjectRangeStream" | "headObject">,
  key: string,
  options: { sizeBytes?: number; partSizeBytes?: number | null; onProgress?: () => Promise<void> | void; progressEveryMs?: number } = {},
) {
  const size = options.sizeBytes ?? (await storage.headObject(key))?.byteSize;
  if (size === undefined) return null;
  const whole = createHash("sha256");
  const parts: string[] = [];
  const step = options.partSizeBytes ?? resolvePhiMediaUploadPartSizeBytes(Math.max(1, size));
  let bytes = 0;
  let lastBeat = Date.now();
  while (bytes < size) {
    const partStart = bytes;
    const part = createHash("sha256");
    while (bytes < Math.min(size, partStart + step)) {
      const served = await storage.getObjectRangeStream(key, { offset: bytes, length: Math.min(size, partStart + step) - bytes });
      if (!served) return null;
      let read = 0;
      for await (const raw of served.body as unknown as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        whole.update(chunk);
        part.update(chunk);
        read += chunk.length;
      }
      if (read === 0) return null;
      bytes += read;
      if (options.onProgress && Date.now() - lastBeat >= (options.progressEveryMs ?? PHIS_CDN_UPLOAD_HEARTBEAT_INTERVAL_MS)) {
        lastBeat = Date.now();
        await options.onProgress();
      }
    }
    if (options.partSizeBytes) parts.push(part.digest("hex"));
  }
  return { sha256: whole.digest("hex"), parts, bytes };
}

/* ---------------------------------------------------------------------------------------------- */
/* The operator's publish from a file on disk                                                     */
/* ---------------------------------------------------------------------------------------------- */

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

function noDirectUpload(target: PhisCdnTarget): never {
  throw new PhisCdnPublishRefusal(
    "no-public-endpoint",
    `Storage Profile "${target.profile.key}" has no public endpoint, so its Provider offers no direct upload. ` +
    "Set publicEndpoint to the address this host reaches the storage at (it may equal endpoint).",
  );
}

/**
 * `phis cdn publish`: one file from disk, straight to the storage over the Provider's upload plan, then
 * recorded with origin `cli`. The operator's: no Media limit applies, and the bytes count in the Site
 * Space whether or not they fit.
 */
export async function publishPhisCdnFileFromDisk(pool: Pool, target: PhisCdnTarget, input: {
  root: string;
  file: string;
  name: string;
  version: string;
  fileName: string;
  contentType?: string;
  os: number;
  arch: number;
  progress: (line: string) => void;
}) {
  refuseDisabled(target);
  const stat = statSync(input.file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${input.file} is not a file.`);
  const parts = readPhisCdnKeyOrRefuse(input.name, input.version, input.fileName);
  const contentType = resolvePhisCdnContentTypeOrRefuse(parts.fileName, input.contentType);
  const flags = encodePhisCdnPlatformFlags(input.os, input.arch);

  if (await readSiteCdnFile(pool, target.siteId, parts.key, { includeWithdrawn: true })) {
    throw new PhisCdnPublishRefusal("key-taken", `${parts.key} is already published on ${target.siteKey}. A key is written once: publish a new version.`);
  }
  await refuseBusy(pool, target.siteId, parts.key);
  await refuseObjectPresent(target, parts.key);

  const { storage } = target;
  const sizeBytes = stat.size;
  const partSizeBytes = resolvePhiMediaUploadPartSizeBytes(sizeBytes);
  const multipart = sizeBytes > partSizeBytes;
  input.progress(`Reading ${path.basename(input.file)} (${sizeBytes} bytes)...`);
  const digest = await hashFile(input.file, multipart ? partSizeBytes : null);
  if (multipart && digest.parts.length !== resolvePhiMediaUploadPartCount(sizeBytes)) {
    throw new Error("The file changed while it was read.");
  }
  // Digests go into the signature only where the probe found the storage verifies SHA-256.
  const verifies = phisCdnVerifiesSha256(target.profile);
  const expiresAt = new Date(Date.now() + PRESIGN_TTL_MS).toISOString();
  const stateFile = resumeStatePath(input.root, target.siteKey, parts.key);

  let plan: PhiMediaUploadPlan | null = null;
  let uploaded: { partNumber: number; eTag: string }[] = [];
  const previous = readResumeState(stateFile);
  if (multipart && previous && previous.key === parts.key && previous.sizeBytes === sizeBytes && previous.sha256 === digest.sha256) {
    const resumption = await storage.resumeUploadPlan({
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
      input.progress(`Carrying on an earlier upload: ${uploaded.length} of ${digest.parts.length} parts are there.`);
    }
  }
  if (!plan) {
    plan = await storage.createUploadPlan({
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
    noDirectUpload(target);
  } else if (plan.kind === "presigned-put") {
    input.progress("Uploading...");
    const single = plan;
    await withRetry(() => putPhisCdnBody({
      url: single.url, headers: single.headers, body: createReadStream(input.file), length: sizeBytes,
    }));
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
        const current = next;
        const eTag = await withRetry(() => putPhisCdnBody({
          url: current.url,
          headers: current.headers,
          body: length === 0 ? Buffer.alloc(0) : createReadStream(input.file, { start, end: start + length - 1 }),
          length,
        }));
        if (!eTag) throw new Error(`The storage answered part ${next.partNumber} without an entity tag.`);
        sent.push({ partNumber: next.partNumber, eTag });
        input.progress(`part ${uploaded.length + sent.length}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CLI_PART_CONCURRENCY, queue.length) }, worker));
    completion = { uploadId: plan.uploadId, parts: sortParts([...uploaded, ...sent]) };
  }

  const head: PhisMediaObjectHead | null = await storage.completeUpload({ storageKey: parts.key, completion });
  if (!head) throw new Error(`The storage holds nothing at ${parts.key} after the upload.`);
  if (head.byteSize !== sizeBytes) {
    throw new Error(`The storage holds ${head.byteSize} bytes at ${parts.key}, not ${sizeBytes}. Nothing was recorded.`);
  }
  if (head.checksum?.algorithm === "sha256" && head.checksum.value.toLowerCase() !== digest.sha256) {
    throw new Error(`The storage reports another SHA-256 for ${parts.key} than the file has. Nothing was recorded.`);
  }
  rmSync(stateFile, { force: true });

  const row = await recordPhisCdnFile(pool, target, {
    parts,
    sizeBytes,
    sha256: digest.sha256,
    contentType,
    flags,
    origin: { origin: PhisCdnFileOrigin.Cli, addonId: null, actorUserId: null, sourceUrl: null },
    booking: "stored",
  });
  return { file: presentPhisCdnFile(row, target.cdn.publicBaseUrl), verified: verifies };
}

/* ---------------------------------------------------------------------------------------------- */
/* A Maintainer's upload from the CDN page                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** The length of part `partNumber` of a body of `sizeBytes` cut at `partSizeBytes`. */
export function phisCdnPartLength(sizeBytes: number, partSizeBytes: number, partNumber: number) {
  const start = (partNumber - 1) * partSizeBytes;
  return Math.max(0, Math.min(partSizeBytes, sizeBytes - start));
}

/** The part numbers the storage holds for an upload: the assembly's, or the single object once it landed. */
export async function listPhisCdnUploadedParts(target: PhisCdnTarget, upload: SiteCdnUploadRecord) {
  if (upload.providerUploadId) {
    const resumption = await target.storage.resumeUploadPlan({
      storageKey: upload.key,
      uploadId: upload.providerUploadId,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      expiresAt: new Date(Date.now() + PRESIGN_TTL_MS).toISOString(),
      ...(phisCdnVerifiesSha256(target.profile) && upload.partSha256 ? { partChecksums: upload.partSha256 } : {}),
    });
    if (!resumption) return { uploaded: [] as number[], resumption: null };
    return { uploaded: resumption.uploaded.map((part) => part.partNumber).sort((a, b) => a - b), resumption };
  }
  return { uploaded: (await target.storage.headObject(upload.key)) ? [1] : [], resumption: null };
}

function readPartDigests(sizeBytes: number, value: unknown) {
  const count = resolvePhiMediaUploadPartCount(sizeBytes);
  if (!Array.isArray(value) || value.length !== count || value.some((entry) => typeof entry !== "string" || !SHA256_PATTERN.test(entry))) {
    throw new PhisCdnPublishRefusal(
      "part-digests",
      `A body of ${sizeBytes} bytes is described by ${count} part digest(s), each 64 lowercase hex digits.`,
      { partCount: count },
    );
  }
  return value as string[];
}

function samePartDigests(left: readonly string[] | null, right: readonly string[]) {
  return left !== null && left.length === right.length && left.every((digest, index) => digest === right[index]);
}

/**
 * Opens a Maintainer's upload, or carries on the open one of the same key, size and part digests by the
 * same person. Answers the upload and the parts the storage holds already.
 */
export async function openPhisCdnBrowserUpload(pool: Pool, target: PhisCdnTarget, init: PhisCdnUploadInitV1, input: {
  actorUserId: number;
  maxObjectBytes: number | null;
}): Promise<{ upload: SiteCdnUploadRecord; uploaded: number[]; resumed: boolean }> {
  if (!Number.isSafeInteger(init.sizeBytes) || init.sizeBytes <= 0) {
    throw new PhisCdnPublishRefusal("invalid-key", "sizeBytes must be a positive integer.");
  }
  const parts = readPhisCdnKeyOrRefuse(init.name, init.version, init.fileName);
  const contentType = resolvePhisCdnContentTypeOrRefuse(parts.fileName, init.contentType);
  const os = init.os ?? 0;
  const arch = init.arch ?? 0;
  if (!isPhisCdnPlatform(os, arch)) {
    throw new PhisCdnPublishRefusal("invalid-key", "os and arch must be PhisCdnFileOs and PhisCdnFileArch bits.");
  }
  refuseTooLarge(init.sizeBytes, input.maxObjectBytes);
  const partSha256 = readPartDigests(init.sizeBytes, init.partSha256);
  refuseDisabled(target);

  const open = await readOpenSiteCdnUpload(pool, target.siteId, parts.key);
  if (open) {
    const mine = open.origin === PhisCdnFileOrigin.Upload && open.actorUserId === input.actorUserId;
    if (mine && open.status !== PhisCdnUploadStatusCode.Hashing && open.sizeBytes === init.sizeBytes
      && samePartDigests(open.partSha256, partSha256)) {
      await renewSiteCdnUpload(pool, open.token, PHIS_CDN_UPLOAD_TTL_MS);
      const { uploaded } = await listPhisCdnUploadedParts(target, open);
      return { upload: open, uploaded, resumed: true };
    }
    throw new PhisCdnPublishRefusal("busy", `An upload of ${parts.key} is open elsewhere.`, mine ? { token: open.token } : {});
  }
  if (await readSiteCdnFile(pool, target.siteId, parts.key, { includeWithdrawn: true })) {
    throw new PhisCdnPublishRefusal("key-taken", `${parts.key} is published already, or was and has been withdrawn. A key is written once.`);
  }
  await refuseObjectPresent(target, parts.key);

  const partSizeBytes = resolvePhiMediaUploadPartSizeBytes(init.sizeBytes);
  const multipart = init.sizeBytes > partSizeBytes;
  const token = randomUUID().replace(/-/gu, "") + randomUUID().replace(/-/gu, "");
  const upload = await insertSiteCdnUpload(pool, {
    token,
    siteId: target.siteId,
    key: parts.key,
    name: parts.name,
    version: parts.version,
    fileName: parts.fileName,
    sizeBytes: init.sizeBytes,
    contentType,
    partSizeBytes,
    partSha256,
    expectedSha256: null,
    fileFlags: encodePhisCdnPlatformFlags(os, arch),
    origin: PhisCdnFileOrigin.Upload,
    actorUserId: input.actorUserId,
    addonId: null,
    sourceUrl: null,
    providerUploadId: null,
    ttlMs: PHIS_CDN_UPLOAD_TTL_MS,
  });
  if (!upload) throw new PhisCdnPublishRefusal("busy", `An upload of ${parts.key} is open elsewhere.`);
  try {
    await reserveSiteBytes(pool, target.siteId, init.sizeBytes);
  } catch (error) {
    await endSiteCdnUpload(pool, token, PhisCdnUploadStatusCode.Aborted, { code: "quota_exceeded", message: String(error) });
    throw error;
  }
  try {
    const verifies = phisCdnVerifiesSha256(target.profile);
    const plan = await target.storage.createUploadPlan({
      token,
      storageKey: parts.key,
      contentType,
      sizeBytes: init.sizeBytes,
      expiresAt: new Date(Date.now() + PRESIGN_TTL_MS).toISOString(),
      proxyUploadUrl: "",
      mayAssembleFromParts: multipart,
      ...(verifies && !multipart ? { checksum: { algorithm: "sha256" as const, value: partSha256[0]! } } : {}),
      ...(verifies && multipart ? { partChecksums: partSha256 } : {}),
    });
    if (plan.kind === "proxy-stream") noDirectUpload(target);
    if (multipart && plan.kind !== "multipart-put") {
      throw new PhisCdnPublishRefusal("storage-failed", `Storage Profile "${target.profile.key}" did not offer an upload in parts.`);
    }
    if (plan.kind === "multipart-put") {
      await setSiteCdnUploadProviderId(pool, token, plan.uploadId);
      upload.providerUploadId = plan.uploadId;
    }
  } catch (error) {
    await abortPhisCdnUpload(pool, target, upload, PhisCdnUploadStatusCode.Aborted, null);
    throw error;
  }
  return { upload, uploaded: [], resumed: false };
}

/**
 * Relays one part of a Maintainer's upload from the request to the storage, streamed. The part's length
 * is the Media upload's division of the size; a body of another length is refused before or as it
 * streams, and a part the storage holds already is answered as there.
 */
export async function relayPhisCdnUploadPart(pool: Pool, target: PhisCdnTarget, upload: SiteCdnUploadRecord, input: {
  partNumber: number;
  body: Readable;
  declaredLength: number | null;
  signal?: AbortSignal;
}): Promise<{ uploaded: number }> {
  const count = resolvePhiMediaUploadPartCount(upload.sizeBytes);
  const length = phisCdnPartLength(upload.sizeBytes, upload.partSizeBytes, input.partNumber);
  if (input.partNumber < 1 || input.partNumber > count || length === 0) {
    throw new PhisCdnPublishRefusal("part-digests", `Part ${input.partNumber} is not one of the ${count} part(s) of this upload.`);
  }
  if (input.declaredLength !== null && input.declaredLength !== length) {
    throw new PhisCdnBodyLengthError(length, input.declaredLength);
  }
  if (!await renewSiteCdnUpload(pool, upload.token, PHIS_CDN_UPLOAD_TTL_MS)) {
    throw new PhisCdnPublishRefusal("busy", "This upload is not open for parts any more.");
  }
  const verifies = phisCdnVerifiesSha256(target.profile);
  if (upload.providerUploadId) {
    const { resumption, uploaded } = await listPhisCdnUploadedParts(target, upload);
    if (!resumption) throw new PhisCdnPublishRefusal("storage-failed", "The storage no longer knows this upload.");
    const part = resumption.plan.parts.find((entry) => entry.partNumber === input.partNumber);
    if (!part) {
      input.body.resume();
      return { uploaded: uploaded.length };
    }
    await putPhisCdnBody({ url: part.url, headers: part.headers, body: input.body, length, signal: input.signal });
    return { uploaded: uploaded.length + 1 };
  }
  const plan = await target.storage.createUploadPlan({
    token: upload.token,
    storageKey: upload.key,
    contentType: upload.contentType,
    sizeBytes: upload.sizeBytes,
    expiresAt: new Date(Date.now() + PRESIGN_TTL_MS).toISOString(),
    proxyUploadUrl: "",
    ...(verifies && upload.partSha256 ? { checksum: { algorithm: "sha256" as const, value: upload.partSha256[0]! } } : {}),
  });
  if (plan.kind !== "presigned-put") noDirectUpload(target);
  await putPhisCdnBody({ url: plan.url, headers: plan.headers, body: input.body, length, signal: input.signal });
  return { uploaded: 1 };
}

/**
 * Moves an upload whose parts are all in to `hashing`. Throws `parts_missing` (as `part-digests` with the
 * parts in `detail`) where some are not.
 */
export async function completePhisCdnBrowserUpload(pool: Pool, target: PhisCdnTarget, upload: SiteCdnUploadRecord) {
  const count = resolvePhiMediaUploadPartCount(upload.sizeBytes);
  const { uploaded } = await listPhisCdnUploadedParts(target, upload);
  if (uploaded.length !== count) {
    return { ok: false as const, uploaded };
  }
  if (!await startSiteCdnUploadHashing(pool, upload.token)) {
    throw new PhisCdnPublishRefusal("busy", "This upload is not open any more.");
  }
  return { ok: true as const, uploaded };
}

/**
 * Finishes a `hashing` upload: completes the assembly where it is still open, compares the size, hashes
 * the object from the bucket -- each part against the digest the page sent -- and records it with origin
 * `upload`. Safe to run again on an upload whose instance died half way (the prune job does).
 * A mismatch removes the object and ends the upload `failed`.
 */
export async function finishPhisCdnUpload(pool: Pool, target: PhisCdnTarget, upload: SiteCdnUploadRecord) {
  const fail = async (code: string, message: string, removeObject: boolean) => {
    if (removeObject) await target.storage.deleteObject(upload.key).catch(() => false);
    await abortPhisCdnUpload(pool, target, upload, PhisCdnUploadStatusCode.Failed, { code, message });
    return { ok: false as const, code, message };
  };
  try {
    let head = await target.storage.headObject(upload.key);
    if (!head) {
      if (upload.providerUploadId) {
        const { resumption } = await listPhisCdnUploadedParts(target, upload);
        if (!resumption) return await fail("storage_failed", "The storage holds neither the object nor the upload.", false);
        head = await target.storage.completeUpload({
          storageKey: upload.key,
          completion: { uploadId: upload.providerUploadId, parts: sortParts(resumption.uploaded) },
        });
      } else {
        head = await target.storage.completeUpload({ storageKey: upload.key });
      }
    }
    if (!head) return await fail("storage_failed", `The storage holds nothing at ${upload.key} after the upload.`, false);
    if (head.byteSize !== upload.sizeBytes) {
      return await fail("size_mismatch", `The storage holds ${head.byteSize} bytes at ${upload.key}, not ${upload.sizeBytes}.`, true);
    }
    const digest = await hashPhisCdnObject(target.storage, upload.key, {
      sizeBytes: head.byteSize,
      partSizeBytes: upload.partSizeBytes,
      onProgress: () => beatSiteCdnUploadHashing(pool, upload.token),
    });
    if (!digest || digest.bytes !== upload.sizeBytes) {
      return await fail("size_mismatch", `The object at ${upload.key} could not be read whole.`, true);
    }
    if (upload.partSha256 && !samePartDigests(upload.partSha256, digest.parts.length === 0 ? [digest.sha256] : digest.parts)) {
      return await fail("checksum_mismatch", "The bytes in the storage are not the ones the page hashed.", true);
    }
    const row = await recordPhisCdnFile(pool, target, {
      parts: { key: upload.key, name: upload.name, version: upload.version, fileName: upload.fileName },
      sizeBytes: upload.sizeBytes,
      sha256: digest.sha256,
      contentType: upload.contentType,
      flags: upload.fileFlags,
      origin: { origin: PhisCdnFileOrigin.Upload, addonId: null, actorUserId: upload.actorUserId, sourceUrl: null },
      booking: "reserved",
      uploadToken: upload.token,
    });
    return { ok: true as const, row };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const keyTaken = error instanceof PhisCdnPublishRefusal && error.code === "key-taken";
    return await fail(keyTaken ? "key_taken" : "storage_failed", message, false);
  }
}

/**
 * Ends an upload that will not be published -- aborted by its Maintainer, run out, failed -- gives its
 * reservation back and its assembly up. Only the caller that ends the row does either, so two callers
 * never release one reservation twice. An object that landed at the key is removed too: the key was never
 * recorded, so nothing else can own the object.
 */
export async function abortPhisCdnUpload(
  pool: Pool,
  target: PhisCdnTarget | null,
  upload: SiteCdnUploadRecord,
  status: number,
  error: { code: string; message: string } | null,
) {
  const ended = await endSiteCdnUpload(pool, upload.token, status, error);
  if (!ended) return false;
  await releaseSiteBytes(pool, upload.siteId, upload.sizeBytes);
  if (target) {
    await abandonAssembly(target.storage, upload.key, upload.providerUploadId);
    // What landed at the key -- a single body, or an assembly completed before the upload failed -- is
    // nobody else's: the key was never recorded, and an object of another origin was refused at the start.
    if (!await readSiteCdnFile(pool, upload.siteId, upload.key, { includeWithdrawn: true })) {
      await target.storage.deleteObject(upload.key).catch(() => false);
    }
  }
  return true;
}

/* ---------------------------------------------------------------------------------------------- */
/* An Add-on's import and link (`cdn-publish:v1`)                                                 */
/* ---------------------------------------------------------------------------------------------- */

/** A request that is not of the contract's shape is the caller's fault, and throws. */
function readRequestShape(request: PhisCdnImportRequestV1 | PhisCdnLinkRequestV1, sha256Required: boolean) {
  const fault = (message: string): never => {
    throw new TypeError(`cdn-publish: ${message}`);
  };
  if (!request || typeof request !== "object") fault("a request must be an object.");
  for (const field of ["name", "version", "fileName", "url"] as const) {
    if (typeof request[field] !== "string") fault(`\`${field}\` must be a string.`);
  }
  try {
    new URL(request.url);
  } catch {
    fault(`\`url\` "${request.url}" is not an address.`);
  }
  if (!Number.isSafeInteger(request.sizeBytes) || request.sizeBytes <= 0) fault("`sizeBytes` must be a positive integer.");
  if (request.sha256 === null) {
    if (sha256Required) fault("a link needs a `sha256`.");
  } else if (typeof request.sha256 !== "string" || !SHA256_PATTERN.test(request.sha256)) {
    fault("`sha256` must be 64 lowercase hex digits.");
  }
  if (request.contentType !== undefined && typeof request.contentType !== "string") fault("`contentType` must be a string.");
  const os = request.os ?? 0;
  const arch = request.arch ?? 0;
  if (!Number.isInteger(os) || os < 0 || (os & ~PHIS_CDN_FILE_OS_MASK) !== 0) fault("`os` holds bits PhisCdnFileOs does not name.");
  if (!Number.isInteger(arch) || arch < 0 || (arch & ~PHIS_CDN_FILE_ARCH_MASK) !== 0) fault("`arch` holds bits PhisCdnFileArch does not name.");
  return { os, arch };
}

export type PhisCdnAddonCaller = {
  addonId: string;
  /** The stage's `cdn.importHosts`. */
  importHosts: readonly string[];
  /** The Site's `max_object_bytes`. */
  maxObjectBytes: number;
  /** Told of every refusal, for the Server's log. */
  onRefusal?: (refusal: { code: string; message: string; key: string | null }) => void;
  /** For tests: the resolver and the transport `fetchPhisOutbound` uses. */
  outbound?: Pick<PhisOutboundOptions, "resolve" | "transport">;
};

/** The checks import and link share, ahead of anything stored or fetched. */
async function checkAddonRequest(
  pool: Pool,
  target: PhisCdnTarget | null,
  request: PhisCdnImportRequestV1 | PhisCdnLinkRequestV1,
  caller: PhisCdnAddonCaller,
) {
  if (!target) throw new PhisCdnPublishRefusal("not-configured", "This Site has no CDN.");
  const parts = readPhisCdnKeyOrRefuse(request.name, request.version, request.fileName);
  const contentType = resolvePhisCdnContentTypeOrRefuse(parts.fileName, request.contentType);
  refuseTooLarge(request.sizeBytes, caller.maxObjectBytes);
  const hostRefusal = explainPhisOutboundUrlRefusal(new URL(request.url), buildPhisCdnImportPolicy(caller.importHosts));
  if (hostRefusal) throw new PhisCdnPublishRefusal("host-not-allowed", hostRefusal);
  if (await isSiteCdnNameHeldByOthers(pool, target.siteId, parts.name, caller.addonId)) {
    throw new PhisCdnPublishRefusal(
      "name-not-yours",
      `The name ${parts.name} holds files of another origin; ${caller.addonId} imports and links only under a name that is new or wholly its own.`,
    );
  }
  return { target, parts, contentType };
}

function asRefusal<T extends string>(error: unknown, allowed: readonly T[], fallback: T): { code: T; message: string } | null {
  if (error instanceof PhisCdnPublishRefusal) {
    const code = error.code === "object-present" ? "key-taken" : error.code;
    return { code: (allowed as readonly string[]).includes(code) ? code as T : fallback, message: error.message };
  }
  return null;
}

const IMPORT_REFUSALS: readonly PhisCdnImportRefusalV1[] = [
  "not-configured", "invalid-key", "name-not-yours", "key-taken", "busy", "host-not-allowed", "content-type-refused",
  "too-large", "quota-exceeded", "size-mismatch", "checksum-mismatch", "source-failed", "storage-failed",
];
const LINK_REFUSALS: readonly PhisCdnLinkRefusalV1[] = [
  "not-configured", "invalid-key", "name-not-yours", "key-taken", "busy", "host-not-allowed", "content-type-refused", "too-large",
];

type ImportFailure = { refusal: PhisCdnImportRefusalV1; message: string };

class ImportStop extends Error {
  readonly failure: ImportFailure;

  constructor(failure: ImportFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/** Reads the source into parts and sends them, at most `PHIS_CDN_IMPORT_PART_CONCURRENCY` at once, hashing as it reads. */
async function streamImportParts(input: {
  body: AsyncIterable<Buffer>;
  sizeBytes: number;
  partSizeBytes: number;
  send: (partNumber: number, bytes: Buffer) => Promise<string>;
}) {
  const whole = createHash("sha256");
  const sent: { partNumber: number; eTag: string }[] = [];
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  let received = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let partNumber = 0;

  const dispatch = async (bytes: Buffer) => {
    partNumber += 1;
    const number = partNumber;
    const task: Promise<void> = input.send(number, bytes)
      .then((eTag) => { sent.push({ partNumber: number, eTag }); })
      .catch((error: unknown) => { failure ??= error; })
      .finally(() => { inFlight.delete(task); });
    inFlight.add(task);
    if (inFlight.size >= PHIS_CDN_IMPORT_PART_CONCURRENCY) await Promise.race(inFlight);
    if (failure) throw failure;
  };

  for await (const chunk of input.body) {
    received += chunk.length;
    if (received > input.sizeBytes) {
      throw new ImportStop({ refusal: "size-mismatch", message: `The source sent more than the ${input.sizeBytes} bytes it stated.` });
    }
    whole.update(chunk);
    let offset = 0;
    while (offset < chunk.length) {
      const take = Math.min(input.partSizeBytes - pendingBytes, chunk.length - offset);
      pending.push(chunk.subarray(offset, offset + take));
      pendingBytes += take;
      offset += take;
      if (pendingBytes === input.partSizeBytes) {
        const bytes = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        await dispatch(bytes);
      }
    }
  }
  if (received !== input.sizeBytes) {
    throw new ImportStop({ refusal: "size-mismatch", message: `The source sent ${received} bytes, not the ${input.sizeBytes} it stated.` });
  }
  if (pendingBytes > 0) await dispatch(Buffer.concat(pending, pendingBytes));
  await Promise.all(inFlight);
  if (failure) throw failure;
  return { sha256: whole.digest("hex"), parts: sortParts(sent) };
}

async function readWhole(body: AsyncIterable<Buffer>, sizeBytes: number) {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body) {
    received += chunk.length;
    if (received > sizeBytes) {
      throw new ImportStop({ refusal: "size-mismatch", message: `The source sent more than the ${sizeBytes} bytes it stated.` });
    }
    chunks.push(chunk);
  }
  if (received !== sizeBytes) {
    throw new ImportStop({ refusal: "size-mismatch", message: `The source sent ${received} bytes, not the ${sizeBytes} it stated.` });
  }
  return Buffer.concat(chunks, received);
}

/**
 * `cdn-publish:v1.import`: Core fetches the source under the stage's import policy, uploads it to
 * `<name>/<version>/<file>` and records it with origin `addon` -- or answers why not. Idempotent: the
 * key published by this Add-on with the same SHA-256 (or, where the source states none, the same size
 * and address) answers `Already` without fetching anything.
 */
export async function importPhisCdnFile(
  pool: Pool,
  target: PhisCdnTarget | null,
  request: PhisCdnImportRequestV1,
  caller: PhisCdnAddonCaller,
  options: { signal?: AbortSignal } = {},
): Promise<PhisCdnImportResultV1> {
  const { os, arch } = readRequestShape(request, false);
  const refuse = (refusal: PhisCdnImportRefusalV1, message: string, key: string | null): PhisCdnImportResultV1 => {
    caller.onRefusal?.({ code: refusal, message, key });
    return { ok: false, refusal, message };
  };
  let checked: Awaited<ReturnType<typeof checkAddonRequest>>;
  try {
    checked = await checkAddonRequest(pool, target, request, caller);
    refuseDisabled(checked.target);
  } catch (error) {
    const refusal = asRefusal(error, IMPORT_REFUSALS, "storage-failed");
    if (!refusal) throw error;
    return refuse(refusal.code, refusal.message, null);
  }
  const { parts, contentType } = checked;
  const cdn = checked.target;

  const existing = await readSiteCdnFile(pool, cdn.siteId, parts.key, { includeWithdrawn: true });
  if (existing) {
    const same = !isPhisCdnFileLinked(existing) && (existing.flags & PhisCdnFileFlags.Withdrawn) === 0
      && (request.sha256 !== null
        ? existing.sha256 === request.sha256
        : Number(existing.size_bytes) === request.sizeBytes && existing.source_url === request.url
          && existing.origin_addon_id === caller.addonId);
    if (same) return { ok: true, file: presentPhisCdnFile(existing, cdn.cdn.publicBaseUrl), flags: PhisCdnPublishResultFlags.Already };
    return refuse("key-taken", `${parts.key} is published with other bytes, or was and has been withdrawn. A key is written once.`, parts.key);
  }
  try {
    await refuseObjectPresent(cdn, parts.key);
  } catch (error) {
    const refusal = asRefusal(error, IMPORT_REFUSALS, "storage-failed")!;
    return refuse(refusal.code, refusal.message, parts.key);
  }

  const partSizeBytes = resolvePhiMediaUploadPartSizeBytes(request.sizeBytes);
  const multipart = request.sizeBytes > partSizeBytes;
  const token = randomUUID().replace(/-/gu, "") + randomUUID().replace(/-/gu, "");
  const upload = await insertSiteCdnUpload(pool, {
    token,
    siteId: cdn.siteId,
    key: parts.key,
    name: parts.name,
    version: parts.version,
    fileName: parts.fileName,
    sizeBytes: request.sizeBytes,
    contentType,
    partSizeBytes,
    partSha256: null,
    expectedSha256: request.sha256,
    fileFlags: encodePhisCdnPlatformFlags(os, arch),
    origin: PhisCdnFileOrigin.Addon,
    actorUserId: null,
    addonId: caller.addonId,
    sourceUrl: request.url,
    providerUploadId: null,
    ttlMs: PHIS_CDN_IMPORT_TTL_MS,
  });
  if (!upload) return refuse("busy", `An upload of ${parts.key} is open elsewhere.`, parts.key);
  try {
    await reserveSiteBytes(pool, cdn.siteId, request.sizeBytes);
  } catch (error) {
    await endSiteCdnUpload(pool, token, PhisCdnUploadStatusCode.Aborted, { code: "quota_exceeded", message: String(error) });
    const refusal = asRefusal(error, IMPORT_REFUSALS, "storage-failed");
    if (!refusal) throw error;
    return refuse(refusal.code, refusal.message, parts.key);
  }

  const stop = async (failure: ImportFailure, status: number = PhisCdnUploadStatusCode.Failed) => {
    await abortPhisCdnUpload(pool, cdn, upload, status, { code: failure.refusal, message: failure.message });
    return refuse(failure.refusal, failure.message, parts.key);
  };

  let response: Awaited<ReturnType<typeof fetchPhisOutbound>> | null = null;
  try {
    response = await fetchPhisOutbound(request.url, buildPhisCdnImportPolicy(caller.importHosts), {
      ...(options.signal ? { signal: options.signal } : {}),
      headers: { accept: "*/*" },
      ...(caller.outbound ?? {}),
    });
    if (response.status !== 200) {
      response.discard();
      return await stop({ refusal: "source-failed", message: `${response.url} answered ${response.status}.` });
    }
    if (isPhisOutboundHtml(response.headers)) {
      response.discard();
      return await stop({ refusal: "content-type-refused", message: `${response.url} answered a page (text/html), not a file.` });
    }
    const declared = response.headers["content-length"];
    if (declared !== undefined && Number(declared) !== request.sizeBytes) {
      response.discard();
      return await stop({ refusal: "size-mismatch", message: `${response.url} states ${declared} bytes, not ${request.sizeBytes}.` });
    }
    const body = response.body as AsyncIterable<Buffer>;
    const verifies = phisCdnVerifiesSha256(cdn.profile);
    let sha256: string;
    if (!multipart) {
      const bytes = await readWhole(body, request.sizeBytes);
      sha256 = createHash("sha256").update(bytes).digest("hex");
      if (request.sha256 !== null && sha256 !== request.sha256) {
        return await stop({ refusal: "checksum-mismatch", message: `The source's bytes hash to ${sha256}, not ${request.sha256}.` });
      }
      const plan = await cdn.storage.createUploadPlan({
        token,
        storageKey: parts.key,
        contentType,
        sizeBytes: request.sizeBytes,
        expiresAt: new Date(Date.now() + PRESIGN_TTL_MS).toISOString(),
        proxyUploadUrl: "",
        ...(verifies ? { checksum: { algorithm: "sha256" as const, value: sha256 } } : {}),
      });
      if (plan.kind !== "presigned-put") {
        return await stop({ refusal: "storage-failed", message: `Storage Profile "${cdn.profile.key}" offers no direct upload.` });
      }
      await withRetry(() => putPhisCdnBody({
        url: plan.url, headers: plan.headers, body: bytes, length: bytes.length, ...(options.signal ? { signal: options.signal } : {}),
      }));
      const head = await cdn.storage.completeUpload({ storageKey: parts.key });
      if (!head || head.byteSize !== request.sizeBytes) {
        await cdn.storage.deleteObject(parts.key).catch(() => false);
        return await stop({ refusal: "storage-failed", message: `The storage does not hold ${request.sizeBytes} bytes at ${parts.key}.` });
      }
    } else {
      const plan = await cdn.storage.createUploadPlan({
        token,
        storageKey: parts.key,
        contentType,
        sizeBytes: request.sizeBytes,
        expiresAt: new Date(Date.now() + PRESIGN_TTL_MS).toISOString(),
        proxyUploadUrl: "",
        mayAssembleFromParts: true,
      });
      if (plan.kind !== "multipart-put") {
        return await stop({ refusal: "storage-failed", message: `Storage Profile "${cdn.profile.key}" did not offer an upload in parts.` });
      }
      await setSiteCdnUploadProviderId(pool, token, plan.uploadId);
      upload.providerUploadId = plan.uploadId;
      const addresses = new Map(plan.parts.map((part) => [part.partNumber, part]));
      const streamed = await streamImportParts({
        body,
        sizeBytes: request.sizeBytes,
        partSizeBytes: plan.partSizeBytes,
        send: async (partNumber, bytes) => {
          const address = addresses.get(partNumber);
          if (!address) throw new Error(`The storage named no address for part ${partNumber}.`);
          await renewSiteCdnUpload(pool, token, PHIS_CDN_IMPORT_TTL_MS);
          const eTag = await withRetry(() => putPhisCdnBody({
            url: address.url, headers: address.headers, body: bytes, length: bytes.length,
            ...(options.signal ? { signal: options.signal } : {}),
          }));
          if (!eTag) throw new Error(`The storage answered part ${partNumber} without an entity tag.`);
          return eTag;
        },
      });
      sha256 = streamed.sha256;
      if (request.sha256 !== null && sha256 !== request.sha256) {
        return await stop({ refusal: "checksum-mismatch", message: `The source's bytes hash to ${sha256}, not ${request.sha256}.` });
      }
      if (options.signal?.aborted) {
        return await stop({ refusal: "source-failed", message: "The import was aborted." }, PhisCdnUploadStatusCode.Aborted);
      }
      const head = await cdn.storage.completeUpload({
        storageKey: parts.key,
        completion: { uploadId: plan.uploadId, parts: streamed.parts },
      });
      if (!head || head.byteSize !== request.sizeBytes) {
        await cdn.storage.deleteObject(parts.key).catch(() => false);
        upload.providerUploadId = null;
        return await stop({ refusal: "storage-failed", message: `The storage does not hold ${request.sizeBytes} bytes at ${parts.key}.` });
      }
    }
    // The assembly is complete: nothing is left to abandon if recording fails, only the object to remove.
    upload.providerUploadId = null;
    try {
      const row = await recordPhisCdnFile(pool, cdn, {
        parts,
        sizeBytes: request.sizeBytes,
        sha256,
        contentType,
        flags: upload.fileFlags,
        origin: { origin: PhisCdnFileOrigin.Addon, addonId: caller.addonId, actorUserId: null, sourceUrl: request.url },
        booking: "reserved",
        uploadToken: token,
      });
      return { ok: true, file: presentPhisCdnFile(row, cdn.cdn.publicBaseUrl), flags: 0 };
    } catch (error) {
      await cdn.storage.deleteObject(parts.key).catch(() => false);
      throw error;
    }
  } catch (error) {
    response?.discard();
    if (error instanceof ImportStop) return await stop(error.failure);
    if (options.signal?.aborted || (error instanceof PhisOutboundFetchError && error.code === "aborted")) {
      return await stop({ refusal: "source-failed", message: "The import was aborted." }, PhisCdnUploadStatusCode.Aborted);
    }
    if (error instanceof PhisOutboundFetchError) {
      return await stop({
        refusal: error.code === "host-not-allowed" || error.code === "address-refused" ? "host-not-allowed" : "source-failed",
        message: error.message,
      });
    }
    if (error instanceof PhisCdnStorageRefusal || error instanceof PhisCdnBodyLengthError) {
      return await stop({ refusal: "storage-failed", message: error.message });
    }
    const refusal = asRefusal(error, IMPORT_REFUSALS, "storage-failed");
    if (refusal) return await stop({ refusal: refusal.code, message: refusal.message });
    // The body ended in a way that is the source's: a reset connection, an idle timeout.
    if (error instanceof Error && /aborted|socket|ECONNRESET|timeout/iu.test(error.message)) {
      return await stop({ refusal: "source-failed", message: error.message });
    }
    await abortPhisCdnUpload(pool, cdn, upload, PhisCdnUploadStatusCode.Failed, {
      code: "storage-failed", message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * `cdn-publish:v1.link`: records `url` under the key as a link, nothing fetched and nothing stored.
 * Idempotent: the key linked with the same SHA-256 answers `Already`.
 */
export async function linkPhisCdnFile(
  pool: Pool,
  target: PhisCdnTarget | null,
  request: PhisCdnLinkRequestV1,
  caller: PhisCdnAddonCaller,
): Promise<PhisCdnLinkResultV1> {
  const { os, arch } = readRequestShape(request, true);
  const refuse = (refusal: PhisCdnLinkRefusalV1, message: string, key: string | null): PhisCdnLinkResultV1 => {
    caller.onRefusal?.({ code: refusal, message, key });
    return { ok: false, refusal, message };
  };
  let checked: Awaited<ReturnType<typeof checkAddonRequest>>;
  try {
    checked = await checkAddonRequest(pool, target, request, caller);
  } catch (error) {
    const refusal = asRefusal(error, LINK_REFUSALS, "invalid-key");
    if (!refusal) throw error;
    return refuse(refusal.code, refusal.message, null);
  }
  const { parts, contentType } = checked;
  const cdn = checked.target;
  const present = async (row: PhisCdnFileRow, flags: number): Promise<PhisCdnLinkResultV1> =>
    ({ ok: true, file: presentPhisCdnFile(row, cdn.cdn.publicBaseUrl), flags });

  const sameLink = (row: PhisCdnFileRow) => isPhisCdnFileLinked(row) && (row.flags & PhisCdnFileFlags.Withdrawn) === 0
    && row.sha256 === request.sha256;
  const existing = await readSiteCdnFile(pool, cdn.siteId, parts.key, { includeWithdrawn: true });
  if (existing) {
    if (sameLink(existing)) return await present(existing, PhisCdnPublishResultFlags.Already);
    return refuse("key-taken", `${parts.key} is recorded with other bytes or as a copy, or was and has been withdrawn.`, parts.key);
  }
  if (await readOpenSiteCdnUpload(pool, cdn.siteId, parts.key)) {
    return refuse("busy", `An upload of ${parts.key} is open elsewhere.`, parts.key);
  }
  try {
    const row = await recordPhisCdnFile(pool, cdn, {
      parts,
      sizeBytes: request.sizeBytes,
      sha256: request.sha256,
      contentType,
      flags: PhisCdnFileFlags.Linked | encodePhisCdnPlatformFlags(os, arch),
      origin: { origin: PhisCdnFileOrigin.Addon, addonId: caller.addonId, actorUserId: null, sourceUrl: request.url },
      booking: "none",
    });
    return await present(row, 0);
  } catch (error) {
    if (error instanceof PhisCdnPublishRefusal && error.code === "key-taken") {
      const raced = await readSiteCdnFile(pool, cdn.siteId, parts.key, { includeWithdrawn: true });
      if (raced && sameLink(raced)) return await present(raced, PhisCdnPublishResultFlags.Already);
      return refuse("key-taken", error.message, parts.key);
    }
    throw error;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Housekeeping: `cdn-uploads.prune` and `phis maintain --task cdn-uploads`                         */
/* ---------------------------------------------------------------------------------------------- */

const PRUNE_BATCH = 200;

/**
 * Ends the uploads nobody finishes: aborts the open ones whose expiry passed (their reservation back,
 * their assembly given up), takes over the `hashing` ones whose instance died and finishes them, and
 * forgets ended rows after 30 days. `openTarget` opens a Site's CDN the way the caller can -- the Server
 * through its Provider registry, the CLI through the installed artifact.
 */
export async function prunePhisCdnUploads(
  pool: Pool,
  input: {
    openTarget: (siteId: number) => Promise<PhisCdnTarget | null>;
    dryRun?: boolean;
    signal?: AbortSignal;
  },
) {
  if (input.dryRun) {
    const counts = await countSiteCdnUploadMaintenance(pool, PHIS_CDN_HASHING_LAPSE_MS, PHIS_CDN_UPLOAD_RETENTION_MS);
    return {
      cleared: counts.expired + counts.stale + counts.ended,
      detail: `${counts.expired} upload(s) ran out, ${counts.stale} stalled while hashing, ${counts.ended} ended over 30 days ago.`,
    };
  }
  const targets = new Map<number, PhisCdnTarget | null>();
  const targetOf = async (siteId: number) => {
    if (!targets.has(siteId)) targets.set(siteId, await input.openTarget(siteId).catch(() => null));
    return targets.get(siteId)!;
  };
  let aborted = 0;
  for (const upload of await listExpiredSiteCdnUploads(pool, PRUNE_BATCH)) {
    if (input.signal?.aborted) break;
    if (await abortPhisCdnUpload(pool, await targetOf(upload.siteId), upload, PhisCdnUploadStatusCode.Aborted, {
      code: "expired", message: "Nothing was sent for this upload before it ran out.",
    })) aborted += 1;
  }
  let finished = 0;
  let failed = 0;
  for (const upload of await claimStaleSiteCdnUploadHashing(pool, PHIS_CDN_HASHING_LAPSE_MS, 20)) {
    if (input.signal?.aborted) break;
    const target = await targetOf(upload.siteId);
    if (!target) continue;
    const outcome = await finishPhisCdnUpload(pool, target, upload);
    if (outcome.ok) finished += 1;
    else failed += 1;
  }
  const forgotten = input.signal?.aborted ? 0 : await forgetEndedSiteCdnUploads(pool, PHIS_CDN_UPLOAD_RETENTION_MS, PRUNE_BATCH * 5);
  return {
    cleared: aborted + finished + failed + forgotten,
    detail: `${aborted} upload(s) aborted after they ran out, ${finished} finished and ${failed} failed after their hashing stalled, ` +
      `${forgotten} ended upload(s) forgotten.`,
  };
}

/** A file published by this pipeline, as `cdn:v1` answers it; for the callers that present one. */
export type PhisCdnPublishedFile = PhisCdnFileV1;
