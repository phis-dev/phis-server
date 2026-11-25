import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  resolvePhiMediaUploadPartCount,
  type PhiMediaUploadPlan,
  type PhisMediaObjectHead,
  type PhisMediaStorageAdapter,
} from "@phis/contracts/addon";

/*
 * A storage that takes presigned PUTs over a local HTTP server, the way an S3 endpoint does: a single
 * body to `/single/<key>`, a part to `/part/<upload>/<n>`. Enough of the Provider contract for what the
 * CDN pipeline calls. A digest signed into a plan travels as `?sha256=` and is checked like an endpoint
 * that verifies SHA-256 checks it (400 BadDigest); a part can be told to fail, so an interrupted upload
 * can be carried on; an empty completion aborts the assembly, as a Provider is told to.
 */
export class PhiTestCdnStorage {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  refuseParts = new Set<number>();
  aborted: string[] = [];
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://storage.invalid");
      const [, kind, first, second] = url.pathname.split("/");
      const signed = url.searchParams.get("sha256");
      if (signed && createHash("sha256").update(body).digest("hex") !== signed) {
        response.writeHead(400).end("<Error><Code>BadDigest</Code></Error>");
        return;
      }
      if (kind === "single") {
        this.objects.set(decodeURIComponent(first!), { body, contentType: String(request.headers["content-type"] ?? "") });
        response.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
        return;
      }
      const partNumber = Number(second);
      if (this.refuseParts.has(partNumber)) {
        response.writeHead(500).end("<Error><Code>InternalError</Code></Error>");
        return;
      }
      const upload = this.uploads.get(first!);
      if (!upload) {
        response.writeHead(404).end("<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      upload.parts.set(partNumber, body);
      response.writeHead(200, { etag: `"part-${partNumber}"` }).end();
    });
  });

  base = "";

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset() {
    this.objects.clear();
    this.uploads.clear();
    this.refuseParts.clear();
    this.aborted = [];
  }

  head(key: string): PhisMediaObjectHead | null {
    const object = this.objects.get(key);
    return object
      ? { storageKey: key, byteSize: object.body.length, contentType: object.contentType, etag: "x", metadata: {}, lastModifiedAt: new Date().toISOString() }
      : null;
  }

  private partsPlan(uploadId: string, numbers: number[], checksums?: readonly string[]): Extract<PhiMediaUploadPlan, { kind: "multipart-put" }> {
    return {
      kind: "multipart-put",
      method: "PUT",
      uploadId,
      partSizeBytes: PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
      parts: numbers.map((partNumber) => ({
        partNumber,
        url: `${this.base}/part/${uploadId}/${partNumber}${checksums ? `?sha256=${checksums[partNumber - 1]}` : ""}`,
      })),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  adapter(): PhisMediaStorageAdapter {
    const adapter: Partial<PhisMediaStorageAdapter> = {
      putObject: async (input) => {
        this.objects.set(input.storageKey, { body: Buffer.from(input.body), contentType: input.contentType });
        return this.head(input.storageKey)!;
      },
      headObject: async (key) => this.head(key),
      deleteObject: async (key) => this.objects.delete(key),
      listPrefix: async (prefix) => [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => this.head(key)!),
      getObjectStream: async (key) => {
        const object = this.objects.get(key);
        return object ? new Blob([new Uint8Array(object.body)]).stream() : null;
      },
      getObjectRangeStream: async (key, range) => {
        const object = this.objects.get(key);
        if (!object) return null;
        const slice = object.body.subarray(range.offset, range.offset + range.length);
        return { body: new Blob([new Uint8Array(slice)]).stream(), range: { offset: range.offset, length: slice.length }, byteSize: object.body.length };
      },
      createUploadPlan: async (input) => {
        if (input.mayAssembleFromParts && input.sizeBytes > PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES) {
          const uploadId = randomUUID();
          this.uploads.set(uploadId, { key: input.storageKey, contentType: input.contentType, parts: new Map() });
          const count = resolvePhiMediaUploadPartCount(input.sizeBytes);
          return this.partsPlan(uploadId, Array.from({ length: count }, (_unused, index) => index + 1), input.partChecksums);
        }
        const signed = input.checksum ? `?sha256=${input.checksum.value}` : "";
        return {
          kind: "presigned-put",
          url: `${this.base}/single/${encodeURIComponent(input.storageKey)}${signed}`,
          method: "PUT",
          headers: { "content-type": input.contentType },
          expiresAt: input.expiresAt,
        };
      },
      resumeUploadPlan: async (input) => {
        const upload = this.uploads.get(input.uploadId);
        if (!upload) return null;
        const count = resolvePhiMediaUploadPartCount(input.sizeBytes);
        const missing = Array.from({ length: count }, (_unused, index) => index + 1).filter((n) => !upload.parts.has(n));
        return {
          plan: this.partsPlan(input.uploadId, missing, input.partChecksums),
          uploaded: [...upload.parts].map(([partNumber, body]) => ({ partNumber, eTag: `"part-${partNumber}"`, sizeBytes: body.length })),
        };
      },
      completeUpload: async (input) => {
        const completion = input.completion as { uploadId: string; parts: { partNumber: number; eTag: string }[] } | undefined;
        if (completion) {
          const upload = this.uploads.get(completion.uploadId);
          if (!upload) return this.head(input.storageKey);
          if (completion.parts.length === 0) {
            this.uploads.delete(completion.uploadId);
            this.aborted.push(completion.uploadId);
            return null;
          }
          const body = Buffer.concat(completion.parts.map((part) => upload.parts.get(part.partNumber)!));
          this.objects.set(input.storageKey, { body, contentType: upload.contentType });
          this.uploads.delete(completion.uploadId);
        }
        return this.head(input.storageKey);
      },
    };
    return adapter as PhisMediaStorageAdapter;
  }
}
