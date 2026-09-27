import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { resolvePhiAppPath } from "./app-paths";
import { readMergedPhiConfigSync } from "./config-files";
import { buildPhiMediaUploadStagingKeyPrefix } from "./media-storage-policies-core";
import { resolvePhiSecret } from "./secrets/resolver";

/**
 * The Provider-facing half of this module lives in `@phis/contracts`.
 *
 * A Storage Provider is an Add-on, and an Add-on cannot type against a file inside this application.
 * Re-exported here so nothing inside phi-server had to change its imports, and so there is exactly one
 * definition of what a Provider implements.
 */
export type {
  PhiMediaUploadCompletionInput,
  PhiMediaUploadPlan,
  PhiMediaUploadPlanInput,
  PhiMediaUploadPlanKindKey,
  PhiMediaUploadResumeInput,
  PhiMediaUploadResumption,
  PhisMediaObjectHead,
  PhisMediaObjectInput,
  PhisMediaObjectRange,
  PhisMediaObjectRangeStream,
  PhisMediaObjectStreamInput,
  PhisMediaStorageAdapter,
  PhisMediaStorageConfig,
  PhisMediaStorageProbe,
  PhisMediaStorageProviderId,
  PhisMediaStorageServiceContext,
} from "@phis/contracts/addon";
export { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

import type {
  PhisMediaLifecyclePolicy,
  PhiMediaUploadCompletionInput,
  PhiMediaUploadPlan,
  PhiMediaUploadPlanInput,
  PhiMediaUploadResumeInput,
  PhisMediaObjectHead,
  PhisMediaObjectInput,
  PhisMediaObjectRange,
  PhisMediaObjectRangeStream,
  PhisMediaObjectStreamInput,
  PhisMediaStorageAdapter,
  PhisMediaStorageConfig,
  PhisMediaStorageProbe,
  PhisMediaStorageProviderId,
  PhisMediaStorageServiceContext,
} from "@phis/contracts/addon";
import { PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID } from "@phis/contracts/addon";

export type PhisMediaStorageServiceOptions = {
  profile?: {
    providerId: PhisMediaStorageProviderId;
    config?: Partial<PhisMediaStorageConfig> | null;
    secretReference?: string | null;
    siteKey?: string | null;
  };
};

type LocalObjectMeta = {
  contentType: string;
  byteSize: number;
  metadata: Record<string, string>;
  lastModifiedAt: string;
  etag: string;
};

function normalizePathPart(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeStorageKey(input: string) {
  const normalized = normalizePathPart(input);
  if (!normalized || normalized.includes("..")) {
    throw new Error("Invalid media storage key.");
  }

  return normalized;
}

function normalizeStorageKeyPrefix(value: string | undefined) {
  const normalized = normalizePathPart(value ?? "");
  if (!normalized || normalized.includes("..")) {
    return "sites";
  }

  return normalized;
}

function buildEtag(body: Buffer) {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * What a probe writes: small, recognizable, and worth nothing if it is ever left behind.
 *
 * Its size is the point. A probe is run while an operator waits, against storage that may be on the
 * other side of a slow link, and what is being established -- can this endpoint be written to, does it
 * check what it is told -- is answered by a few bytes exactly as well as by a few megabytes.
 */
const PROBE_BODY = Buffer.from("phis storage probe\n", "utf-8");

/** An operator reads this, so it says what happened rather than what class the exception was. */
export function describeProbeError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "the storage gave no reason";
}

function ensureBuffer(body: Buffer | Uint8Array) {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function buildLocalMetaPath(filePath: string) {
  return `${filePath}.meta.json`;
}

function normalizeMetadata(metadata?: Record<string, string>) {
  if (!metadata) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as Record<string, string>;
}

export function resolvePhisMediaStorageConfig(
  overrides?: Partial<PhisMediaStorageConfig> | null,
): PhisMediaStorageConfig {
  const merged = readMergedPhiConfigSync();
  const media = merged.media ?? {};
  const storageKeyPrefix = normalizeStorageKeyPrefix(
    overrides?.storageKeyPrefix ?? media.storageKeyPrefix ?? "sites",
  );

  return {
    storageKeyPrefix,
    rootDir:
      overrides?.rootDir?.trim() ||
      media.local?.rootDir?.trim() ||
      resolvePhiAppPath("storage", "media"),
  };
}

export function buildPhisMediaStorageKey(input: {
  siteKey: string;
  storageKeyPrefix?: string | null;
}) {
  const siteKey = normalizePathPart(input.siteKey);
  if (!siteKey) {
    throw new Error("Missing site key for media storage key.");
  }

  const storageKeyPrefix = normalizeStorageKeyPrefix(input.storageKeyPrefix ?? "sites");
  const randomPart = randomUUID().replace(/-/g, "");
  return normalizeStorageKey(`${storageKeyPrefix}/${siteKey}/${randomPart}`);
}

export function buildPhisMediaUploadTempStorageKey(input: {
  siteKey: string;
  token: string;
  originalName: string;
  storageKeyPrefix?: string | null;
}) {
  const siteKey = normalizePathPart(input.siteKey);
  const token = normalizePathPart(input.token);
  if (!siteKey) {
    throw new Error("Missing site key for upload temp storage key.");
  }
  if (!token) {
    throw new Error("Missing upload token for upload temp storage key.");
  }

  // The prefix comes from the shared helper, which the storage lifecycle rule also uses: one shape, so a
  // rule that expires staged objects points at the keys this actually writes.
  const stagingPrefix = buildPhiMediaUploadStagingKeyPrefix({
    storageKeyPrefix: input.storageKeyPrefix,
    siteKey: input.siteKey,
  });
  const ext = path.extname(input.originalName).trim().toLowerCase();
  const nameStem =
    path
      .basename(input.originalName, ext)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "asset";
  return normalizeStorageKey(`${stagingPrefix}${token}/${nameStem}${ext}`);
}

export class PhisLocalMediaStorageAdapter implements PhisMediaStorageAdapter {
  constructor(private readonly config: PhisMediaStorageConfig) {}

  private resolveRootDir() {
    return this.config.rootDir;
  }

  private resolveFilePath(storageKey: string) {
    const normalizedKey = normalizeStorageKey(storageKey);
    return path.join(this.resolveRootDir(), normalizedKey);
  }

  private resolveMetaPath(storageKey: string) {
    return buildLocalMetaPath(this.resolveFilePath(storageKey));
  }

  private async putObjectFromReadable(
    storageKey: string,
    readable: Readable,
    contentType: string,
    metadata?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<PhisMediaObjectHead> {
    const normalizedStorageKey = normalizeStorageKey(storageKey);
    const filePath = this.resolveFilePath(normalizedStorageKey);
    const metaPath = this.resolveMetaPath(normalizedStorageKey);
    const normalizedMetadata = normalizeMetadata(metadata);
    const hash = createHash("sha256");
    let byteSize = 0;

    await mkdir(path.dirname(filePath), { recursive: true });

    const fileStream = await import("node:fs").then(({ createWriteStream }) =>
      createWriteStream(filePath, { flags: "w" }),
    );

    const hashingTransform = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteSize += buffer.byteLength;
        hash.update(buffer);
        callback(null, buffer);
      },
    });

    try {
      // The abort reaches the file handle, not just the read: a half-written object left open is what
      // the sweep would later find and what the catch below is here to prevent.
      await pipeline(readable, hashingTransform, fileStream, signal ? { signal } : {});
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => {});
      await rm(metaPath, { force: true }).catch(() => {});
      throw error;
    }

    const etag = hash.digest("hex");
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          contentType,
          byteSize,
          metadata: normalizedMetadata,
          lastModifiedAt: new Date().toISOString(),
          etag,
        } satisfies LocalObjectMeta,
        null,
        2,
      ),
      "utf-8",
    );

    return {
      storageKey: normalizedStorageKey,
      byteSize,
      contentType,
      etag,
      // Core's own storage is the one Provider that can say what its digest is, because it computed it
      // over exactly the bytes it wrote rather than reporting whatever an ETag happens to hold.
      checksum: { algorithm: "sha256", value: etag },
      metadata: normalizedMetadata,
      lastModifiedAt: new Date().toISOString(),
    };
  }

  async putObject(input: PhisMediaObjectInput): Promise<PhisMediaObjectHead> {
    const storageKey = normalizeStorageKey(input.storageKey);
    const body = ensureBuffer(input.body);
    return await this.putObjectFromReadable(
      storageKey,
      Readable.from([body]),
      input.contentType,
      input.metadata,
    );
  }

  async putObjectStream(input: PhisMediaObjectStreamInput): Promise<PhisMediaObjectHead> {
    return await this.putObjectFromReadable(
      input.storageKey,
      Readable.fromWeb(input.body as Parameters<typeof Readable.fromWeb>[0]),
      input.contentType,
      input.metadata,
      input.signal,
    );
  }

  async getObject(storageKey: string): Promise<Buffer | null> {
    const filePath = this.resolveFilePath(storageKey);

    try {
      return await readFile(filePath);
    } catch {
      return null;
    }
  }

  async getObjectStream(storageKey: string): Promise<ReadableStream<Uint8Array> | null> {
    const filePath = this.resolveFilePath(storageKey);

    /*
     * Opened before the stream is built, so a missing object is `null` here rather than an error that
     * surfaces once somebody is already reading the response.
     */
    let handle: FileHandle;
    try {
      handle = await open(filePath, "r");
    } catch {
      return null;
    }

    return Readable.toWeb(
      handle.createReadStream({ autoClose: true }),
    ) as ReadableStream<Uint8Array>;
  }

  /**
   * A slice of a file, so a browser can seek in a video without fetching what came before it.
   *
   * `stat` on the open handle rather than on the path: the size that clamps the read has to be the size
   * of the file this stream will read, not of whatever the name pointed at a moment earlier.
   */
  async getObjectRangeStream(
    storageKey: string,
    range: PhisMediaObjectRange,
  ): Promise<PhisMediaObjectRangeStream | null> {
    const filePath = this.resolveFilePath(storageKey);

    let handle: FileHandle;
    try {
      handle = await open(filePath, "r");
    } catch {
      return null;
    }

    try {
      const { size } = await handle.stat();
      const offset = Math.max(0, Math.min(range.offset, size));
      const length = Math.max(0, Math.min(range.length, size - offset));

      if (length === 0) {
        // `end` is inclusive, so a zero-length read would ask for `end < start` and throw. Nothing to
        // read is an empty body, which is what a caller clamped to the end of the object gets.
        await handle.close().catch(() => {});
        return {
          body: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
          range: { offset, length: 0 },
          byteSize: size,
        };
      }

      return {
        body: Readable.toWeb(
          // `end` is inclusive: the last byte served, not the one after it.
          handle.createReadStream({ start: offset, end: offset + length - 1, autoClose: true }),
        ) as ReadableStream<Uint8Array>,
        range: { offset, length },
        byteSize: size,
      };
    } catch {
      await handle.close().catch(() => {});
      return null;
    }
  }

  async copyObject(input: {
    sourceKey: string;
    targetKey: string;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<PhisMediaObjectHead | null> {
    const source = this.resolveFilePath(input.sourceKey);
    const targetKey = normalizeStorageKey(input.targetKey);
    const target = this.resolveFilePath(targetKey);
    if (source === target) return this.headObject(targetKey);

    try {
      const existing = await this.headObject(input.sourceKey);
      if (!existing) return null;
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      await writeFile(
        buildLocalMetaPath(target),
        JSON.stringify(
          {
            contentType: input.contentType,
            byteSize: existing.byteSize,
            metadata: normalizeMetadata(input.metadata),
            lastModifiedAt: new Date().toISOString(),
            etag: existing.etag,
          } satisfies LocalObjectMeta,
          null,
          2,
        ),
        "utf-8",
      );
      return this.headObject(targetKey);
    } catch {
      return null;
    }
  }

  async readObjectHead(storageKey: string, byteLength: number): Promise<Buffer | null> {
    const filePath = this.resolveFilePath(storageKey);
    let handle: FileHandle | null = null;

    try {
      handle = await open(filePath, "r");
      const buffer = Buffer.alloc(byteLength);
      const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async headObject(storageKey: string): Promise<PhisMediaObjectHead | null> {
    const normalizedKey = normalizeStorageKey(storageKey);
    const filePath = this.resolveFilePath(normalizedKey);
    const metaPath = this.resolveMetaPath(normalizedKey);

    try {
      const fileStats = await stat(filePath);
      const metaRaw = await readFile(metaPath, "utf-8").catch(() => null);
      const meta = metaRaw ? (JSON.parse(metaRaw) as Partial<LocalObjectMeta>) : {};
      const body = await readFile(filePath).catch(() => null);

      return {
        storageKey: normalizedKey,
        byteSize: Number.isFinite(meta.byteSize ?? NaN) ? (meta.byteSize as number) : fileStats.size,
        contentType: typeof meta.contentType === "string" && meta.contentType.trim()
          ? meta.contentType
          : "application/octet-stream",
        etag:
          typeof meta.etag === "string" && meta.etag.trim()
            ? meta.etag
            : body
              ? buildEtag(body)
              : "",
        metadata: normalizeMetadata(meta.metadata),
        lastModifiedAt:
          typeof meta.lastModifiedAt === "string" && meta.lastModifiedAt.trim()
            ? meta.lastModifiedAt
            : fileStats.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }

  async deleteObject(storageKey: string): Promise<boolean> {
    const normalizedKey = normalizeStorageKey(storageKey);
    const filePath = this.resolveFilePath(normalizedKey);
    const metaPath = this.resolveMetaPath(normalizedKey);

    const fileDeleted = await rm(filePath, { force: true }).then(
      () => true,
      () => false,
    );
    await rm(metaPath, { force: true }).catch(() => {});

    return fileDeleted;
  }

  async listPrefix(prefix: string): Promise<PhisMediaObjectHead[]> {
    const normalizedPrefix = normalizeStorageKey(prefix);
    const rootDir = this.resolveRootDir();
    const prefixRoot = path.join(rootDir, normalizedPrefix);
    const results: PhisMediaObjectHead[] = [];

    async function walk(currentDir: string) {
      const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const nextPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(nextPath);
          continue;
        }

        if (!entry.isFile() || entry.name.endsWith(".meta.json")) {
          continue;
        }

        const fileStats = await stat(nextPath);
        const metaPath = buildLocalMetaPath(nextPath);
        const metaRaw = await readFile(metaPath, "utf-8").catch(() => null);
        const meta = metaRaw ? (JSON.parse(metaRaw) as Partial<LocalObjectMeta>) : {};
        const storageKey = path
          .relative(rootDir, nextPath)
          .replace(/\\/g, "/")
          .replace(/^\/+/, "");

        results.push({
          storageKey,
          byteSize:
            Number.isFinite(meta.byteSize ?? NaN) ? (meta.byteSize as number) : fileStats.size,
          contentType:
            typeof meta.contentType === "string" && meta.contentType.trim()
              ? meta.contentType
              : "application/octet-stream",
          etag: typeof meta.etag === "string" && meta.etag.trim() ? meta.etag : "",
          metadata: normalizeMetadata(meta.metadata),
          lastModifiedAt:
            typeof meta.lastModifiedAt === "string" && meta.lastModifiedAt.trim()
              ? meta.lastModifiedAt
              : fileStats.mtime.toISOString(),
        });
      }
    }

    const prefixStats = await stat(prefixRoot).catch(() => null);
    if (!prefixStats?.isDirectory()) {
      return [];
    }

    await walk(prefixRoot);
    return results;
  }

  /**
   * Local storage has no endpoint of its own a browser could reach, so the body comes through Core.
   *
   * This is the plan every Site starts on, and the one the Client already carried out implicitly
   * before there was a plan at all.
   */
  async createUploadPlan(input: PhiMediaUploadPlanInput): Promise<PhiMediaUploadPlan> {
    return { kind: "proxy-stream", url: input.proxyUploadUrl, method: "PUT" };
  }

  /** Nothing to assemble: the object is whole the moment Core finished writing it. */
  async completeUpload(input: PhiMediaUploadCompletionInput) {
    return this.headObject(input.storageKey);
  }

  /**
   * Nothing to carry on: this Provider never divides a body, so no assembly of it is ever open.
   *
   * A proxied body either finished streaming through Core or did not, and what a half-written staging file
   * holds is not something a second request may build on -- the bytes were never attested and the Client
   * cannot say which of them arrived. So the honest answer is the same one it would give for an upload it
   * has never heard of.
   */
  async resumeUploadPlan(): Promise<null> {
    return null;
  }

  /**
   * Nothing to permit: a browser never addresses this Provider.
   *
   * Local storage is only ever reached through Core's own routes, so every request to it is
   * same-origin by construction and there is no rule that could be written or withheld.
   */
  async applyCorsPolicy(): Promise<void> {
    return;
  }

  /**
   * Nothing to hand over either: these files are Core's own.
   *
   * A lifecycle rule exists because a remote storage holds things Core cannot see -- parts of an upload
   * nobody completed, billed and unlistable. Here every byte sits in a directory Core owns, an unfinished
   * upload is a file it wrote itself, and what removes it is an operator command rather than a rule the
   * storage enforces on its own.
   */
  async applyLifecyclePolicy(): Promise<void> {
    return;
  }

  /**
   * Answers about the directory, and answers `verifiesSha256: false` without trying.
   *
   * Not a shortcoming. The question is whether a *remote* endpoint checks what a client claims, and
   * here there is no client and no claim: every byte is written by Core through `putObjectStream`,
   * which hashes as it writes. There is nothing to verify because nothing was asserted.
   */
  async probeCapabilities(): Promise<PhisMediaStorageProbe> {
    const findings: string[] = [];
    const key = `.phis-probe/${randomUUID()}`;
    try {
      await this.putObject({ storageKey: key, body: PROBE_BODY, contentType: "application/octet-stream" });
      const read = await this.getObject(key);
      if (!read || Buffer.compare(Buffer.from(read), Buffer.from(PROBE_BODY)) !== 0) {
        findings.push("The object written by the probe did not read back unchanged.");
      }
    } catch (error) {
      findings.push(`The storage root did not accept a write: ${describeProbeError(error)}`);
    } finally {
      await this.deleteObject(key).catch(() => {});
    }
    // Nothing is asserted here, so nothing is verified: the digest on a Local upload is the SHA-256
    // Core computes while writing, which is a property of the proxy path rather than of this endpoint.
    return {
      writable: findings.length === 0,
      verifiedAlgorithms: [],
      findings,
    };
  }

  /** The directory is the storage. Two profiles on one root are one storage. */
  storageIdentity(): string {
    return `local:${this.config.rootDir}`;
  }
}

export function createPhisMediaStorageAdapter(
  config?: Partial<PhisMediaStorageConfig> | null,
): PhisMediaStorageAdapter {
  const resolved = resolvePhisMediaStorageConfig(config);
  return new PhisLocalMediaStorageAdapter(resolved);
}

/**
 * A Provider factory.
 *
 * `config` is the Storage Profile row as it was written, unvalidated: only the Provider knows what its
 * own settings mean, and section 5 makes that a schema it validates rather than a shape Core imposes.
 */
export type PhisMediaStorageProviderFactory = (
  config: unknown,
  context: PhisMediaStorageServiceContext,
) => PhisMediaStorageAdapter;

/**
 * Builds the context one Storage Profile's Provider is given.
 *
 * Exported so it can be examined on its own: what a Provider can reach is the whole security argument
 * here, and it should be readable without constructing a Provider to ask it.
 */
export function buildPhisMediaStorageServiceContext(
  profile: {
    providerId: PhisMediaStorageProviderId;
    secretReference?: string | null;
  },
  siteKey?: string | null,
): PhisMediaStorageServiceContext {
  const secretReference = profile.secretReference?.trim() || null;
  return {
    providerId: profile.providerId,
    siteKey: siteKey ?? null,
    // Bound to this profile's own reference here. A Provider cannot ask for another, because there is
    // no argument through which it could name one.
    readSecret: () =>
      secretReference ? resolveMediaStorageProfileSecret(secretReference) : Promise.resolve(null),
  };
}

/**
 * Resolves a Provider factory.
 *
 * The Local Provider is Core and is linked directly. Every other Provider comes from the static build
 * manifest through the service-provider registry, which is the only extension path section 10 admits:
 * a provider id out of a database row selects an entry a build already contains, never an import
 * specifier. There is deliberately no runtime registration to fall back to.
 */
export async function resolvePhisMediaStorageProviderFactory(
  providerId: PhisMediaStorageProviderId,
  options?: { siteId?: number | null },
): Promise<PhisMediaStorageProviderFactory> {
  if (providerId === PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID) {
    // The Local Provider's own schema happens to be Core's, so it resolves what it is handed.
    return (config) => createPhisMediaStorageAdapter(
      resolvePhisMediaStorageConfig(config as Partial<PhisMediaStorageConfig> | null),
    );
  }
  const { resolvePhisServiceProvider } = await import("./addons/services");
  const { PHIS_SERVICE_KINDS } = await import("./addons/core-services");
  const resolved = await resolvePhisServiceProvider(
    PHIS_SERVICE_KINDS.mediaStorage,
    providerId,
    options,
  );
  return resolved.factory as PhisMediaStorageProviderFactory;
}

/**
 * Resolves a Storage Profile's secret as Core, because Core owns the profile row.
 *
 * A Provider Add-on does not resolve its own reference: the profile that names it is Core-owned state,
 * and letting the Add-on ask would mean trusting it to ask for its own.
 */
function resolveMediaStorageProfileSecret(reference: string) {
  return resolvePhiSecret({ kind: "core" }, reference);
}

export class PhisMediaStorageService {
  private readonly adapter: PhisMediaStorageAdapter;
  private readonly config: PhisMediaStorageConfig;
  readonly providerId: PhisMediaStorageProviderId;

  constructor(factory: PhisMediaStorageProviderFactory, options?: PhisMediaStorageServiceOptions) {
    this.providerId = options?.profile?.providerId ?? PHI_LOCAL_MEDIA_STORAGE_PROVIDER_ID;
    this.config = resolvePhisMediaStorageConfig(options?.profile?.config ?? null);
    // The Provider gets the profile row as the operator wrote it, not Core's normalized view of it.
    // Every Provider validates its own configuration against its own schema; Core's storageKeyPrefix
    // and rootDir are Core's business, and a second Provider would find neither of them meaningful.
    this.adapter = factory(
      options?.profile?.config ?? null,
      buildPhisMediaStorageServiceContext(
        { providerId: this.providerId, secretReference: options?.profile?.secretReference ?? null },
        options?.profile?.siteKey ?? null,
      ),
    );
  }

  createStorageKey(input: {
    siteKey: string;
  }) {
    return buildPhisMediaStorageKey({
      ...input,
      storageKeyPrefix: this.config.storageKeyPrefix,
    });
  }

  createUploadTempStorageKey(input: { siteKey: string; token: string; originalName: string }) {
    return buildPhisMediaUploadTempStorageKey({
      ...input,
      storageKeyPrefix: this.config.storageKeyPrefix,
    });
  }

  putObject(input: PhisMediaObjectInput) {
    return this.adapter.putObject(input);
  }

  putObjectStream(input: PhisMediaObjectStreamInput) {
    return this.adapter.putObjectStream(input);
  }

  getObject(storageKey: string) {
    return this.adapter.getObject(storageKey);
  }

  getObjectStream(storageKey: string) {
    return this.adapter.getObjectStream(storageKey);
  }

  getObjectRangeStream(storageKey: string, range: PhisMediaObjectRange) {
    return this.adapter.getObjectRangeStream(storageKey, range);
  }

  readObjectHead(storageKey: string, byteLength: number) {
    return this.adapter.readObjectHead(storageKey, byteLength);
  }

  copyObject(input: {
    sourceKey: string;
    targetKey: string;
    contentType: string;
    metadata?: Record<string, string>;
  }) {
    return this.adapter.copyObject(input);
  }

  headObject(storageKey: string) {
    return this.adapter.headObject(storageKey);
  }

  deleteObject(storageKey: string) {
    return this.adapter.deleteObject(storageKey);
  }

  listPrefix(prefix: string) {
    return this.adapter.listPrefix(prefix);
  }

  createUploadPlan(input: PhiMediaUploadPlanInput) {
    return this.adapter.createUploadPlan(input);
  }

  /** States how the rest of an assembly a Client stopped delivering is to be delivered. */
  resumeUploadPlan(input: PhiMediaUploadResumeInput) {
    return this.adapter.resumeUploadPlan(input);
  }

  probeCapabilities() {
    return this.adapter.probeCapabilities();
  }

  completeUpload(input: PhiMediaUploadCompletionInput) {
    return this.adapter.completeUpload(input);
  }

  getResolvedConfig() {
    return this.config;
  }

  /** What makes two Storage Profiles the same physical storage. Opaque to Core, only ever compared. */
  storageIdentity() {
    return this.adapter.storageIdentity();
  }

  /** States which browser origins may deliver a body straight to this Provider. */
  async applyCorsPolicy(origins: readonly string[]) {
    return this.adapter.applyCorsPolicy(origins);
  }

  /** States what the storage is to clean up by itself, because Core cannot see it. */
  async applyLifecyclePolicy(policy: PhisMediaLifecyclePolicy) {
    return this.adapter.applyLifecyclePolicy(policy);
  }
}

/**
 * Builds the Service for one Storage Profile.
 *
 * Every caller went through the same three fields by hand, which is one field away from a Provider
 * that silently gets no credentials: a forgotten `secretReference` does not fail, it just resolves to
 * null at the first upload. One place assembles it now, so there is nothing to forget.
 */
export async function createPhisMediaStorageServiceForProfile(
  profile: {
    providerId: PhisMediaStorageProviderId;
    config: Record<string, unknown> | Partial<PhisMediaStorageConfig> | null;
    secretReference?: string | null;
    /**
     * The Site the profile belongs to, and the reason an Add-on Provider can be checked at all.
     *
     * Required rather than optional, although the resolver would accept a missing one. The check that
     * an Add-on is enabled for this Site sits behind exactly this value, so an optional field would let
     * any caller drop it by omission -- and the profile row has `site_id NOT NULL`, so there is never a
     * legitimate case where it is unknown.
     */
    siteId: number;
  },
  siteKey?: string | null,
  options?: { siteId?: number | null },
) {
  const factory = await resolvePhisMediaStorageProviderFactory(profile.providerId, {
    siteId: options?.siteId ?? profile.siteId,
  });
  return new PhisMediaStorageService(factory, {
    profile: {
      providerId: profile.providerId,
      config: profile.config as Partial<PhisMediaStorageConfig> | null,
      secretReference: profile.secretReference ?? null,
      siteKey: siteKey ?? null,
    },
  });
}
