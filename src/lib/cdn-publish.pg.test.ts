import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import {
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  PhisCdnFileArch,
  PhisCdnFileOrigin,
  PhisCdnFileOs,
  PhisCdnPublishResultFlags,
  type PhisCdnImportRequestV1,
} from "@phis/contracts/addon";

import { PhiTestCdnStorage } from "../../test/pg/cdn-fake-storage";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  setPhiTestMediaConfig,
  type PhiTestSite,
} from "../../test/pg/harness";
import { readSiteCdn, readSiteCdnProfile, withdrawSiteCdnFile } from "@/db/site-cdn.mts";
import { buildPhisAddonCdnCapability } from "@/lib/addons/cdn-capability";
import { buildPhisAddonCdnPublishCapability } from "@/lib/addons/cdn-publish-capability";
import { PhisCdnUploadStatusCode } from "@/lib/cdn-core";
import { PhiMediaStorageProfileFlags } from "@/lib/constants/media";
import {
  importPhisCdnFile,
  linkPhisCdnFile,
  prunePhisCdnUploads,
  type PhisCdnAddonCaller,
  type PhisCdnTarget,
} from "@/lib/cdn-publish.mts";
import type { PhisOutboundTransport } from "@/lib/outbound-fetch";

const configured = process.env.PHIS_PG_TEST === "1";
const ADDON = "@pgtest/releases";
const PUBLIC = "140.82.121.4";

/** What the source answers per path: bytes, a type, and whether to lie about them. */
type Source = { body: Buffer; type?: string; stall?: boolean };

class FakeSource {
  files = new Map<string, Source>();
  requests: string[] = [];
  server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://source.invalid").pathname;
    this.requests.push(path);
    const redirect = /^\/redirect(\/.*)$/u.exec(path);
    if (redirect) {
      response.writeHead(302, { location: `https://objects.example.com${redirect[1]}` }).end();
      return;
    }
    const file = this.files.get(path);
    if (!file) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200, { "content-type": file.type ?? "application/octet-stream" });
    if (file.stall) {
      // Half the bytes, then nothing: what an import aborted by its signal sees.
      response.write(file.body.subarray(0, file.body.length >> 1));
      return;
    }
    response.end(file.body);
  });
  port = 0;

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Every address the import asks, answered by this server; DNS answers a public address for them. */
  transport: PhisOutboundTransport = (url, options) => http.request({
    host: "127.0.0.1",
    port: this.port,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: options.headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!configured)("cdn-publish:v1 and the CDN pipeline", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let target: PhisCdnTarget;
  const storage = new PhiTestCdnStorage();
  const source = new FakeSource();
  const refusals: string[] = [];

  const caller = (rest: Partial<PhisCdnAddonCaller> = {}): PhisCdnAddonCaller => ({
    addonId: ADDON,
    importHosts: ["files.example.com", "objects.example.com"],
    maxObjectBytes: 64 * 1024 * 1024,
    onRefusal: ({ code }) => refusals.push(code),
    outbound: { transport: source.transport, resolve: async () => [{ address: PUBLIC, family: 4 }] },
    ...rest,
  });
  const request = (path: string, body: Buffer, rest: Partial<PhisCdnImportRequestV1> = {}): PhisCdnImportRequestV1 => ({
    name: "phis",
    version: "0.8.1-1",
    fileName: path.split("/").pop()!,
    url: `https://files.example.com${path}`,
    sizeBytes: body.length,
    sha256: sha(body),
    ...rest,
  });

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await storage.start();
    await source.start();
  });

  beforeEach(async () => {
    site = await createPhiTestSite("cdnpub");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, flags, checksum_algorithm)
       VALUES ($1, 'cdn', '@pgtest/storage/s3', $2, 'sha256') RETURNING id`,
      [site.id, PhiMediaStorageProfileFlags.Cdn],
    );
    await pool.query(
      `INSERT INTO phis.site_cdns (site_id, storage_profile_id, public_base_url) VALUES ($1, $2, 'https://cdn.example.invalid')`,
      [site.id, rows[0]!.id],
    );
    target = {
      siteId: site.id,
      siteKey: site.key,
      cdn: (await readSiteCdn(pool, site.id))!,
      profile: (await readSiteCdnProfile(pool, site.id, { id: rows[0]!.id }))!,
      storage: storage.adapter(),
    };
    storage.reset();
    source.files.clear();
    source.requests = [];
    refusals.length = 0;
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await storage.stop();
    source.server.close();
    await closePhiTestPool();
  });

  it("imports a file, records it with its origin and counts it in the Site Space; again is Already", async () => {
    const body = Buffer.from("a small package\n");
    source.files.set("/phis_0.8.1-1_amd64.deb", { body });
    const asked = request("/phis_0.8.1-1_amd64.deb", body, { os: PhisCdnFileOs.Linux, arch: PhisCdnFileArch.X64 });
    const imported = await importPhisCdnFile(pool, target, asked, caller());
    expect(imported).toMatchObject({
      ok: true, flags: 0,
      file: { key: "phis/0.8.1-1/phis_0.8.1-1_amd64.deb", storage: "cdn", sha256: sha(body), os: 1, arch: 1, sizeBytes: body.length },
    });
    expect(storage.objects.get("phis/0.8.1-1/phis_0.8.1-1_amd64.deb")?.body.equals(body)).toBe(true);
    const { rows } = await pool.query(
      `SELECT o.origin, o.addon_id, o.source_url FROM phis.site_cdn_file_origins o JOIN phis.site_cdn_files f ON f.id = o.file_id
        WHERE f.site_id = $1`, [site.id]);
    expect(rows).toEqual([{ origin: PhisCdnFileOrigin.Addon, addon_id: ADDON, source_url: asked.url }]);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: body.length, reserved: 0 });

    source.requests = [];
    const again = await importPhisCdnFile(pool, target, asked, caller());
    expect(again).toMatchObject({ ok: true, flags: PhisCdnPublishResultFlags.Already });
    expect(source.requests).toEqual([]);

    const other = await importPhisCdnFile(pool, target, { ...asked, sha256: "b".repeat(64) }, caller());
    expect(other).toMatchObject({ ok: false, refusal: "key-taken" });
    expect(await buildPhisAddonCdnCapability({ siteId: site.id }).file(asked.name + "/0.8.1-1/phis_0.8.1-1_amd64.deb"))
      .toMatchObject({ storage: "cdn", os: 1, arch: 1 });
  });

  it("streams a file of several parts through a redirect, hashing as it reads", async () => {
    const size = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 4321;
    const body = Buffer.alloc(size);
    for (let index = 0; index < size; index += 997) body[index] = index % 251;
    source.files.set("/big.bin", { body });
    const imported = await importPhisCdnFile(pool, target, { ...request("/big.bin", body), url: "https://files.example.com/redirect/big.bin" }, caller());
    expect(imported).toMatchObject({ ok: true, file: { sizeBytes: size, sha256: sha(body) } });
    expect(storage.objects.get("phis/0.8.1-1/big.bin")?.body.equals(body)).toBe(true);
    expect(storage.uploads.size).toBe(0);

    // The redirect leaves the host list: nothing is fetched from there, and nothing is left behind.
    source.files.set("/other.bin", { body });
    const refused = await importPhisCdnFile(pool, target, {
      ...request("/other.bin", body), url: "https://files.example.com/redirect/other.bin",
    }, caller({ importHosts: ["files.example.com"] }));
    expect(refused).toMatchObject({ ok: false, refusal: "host-not-allowed" });
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: size, reserved: 0 });
  });

  it("refuses what the source delivers differently, and leaves nothing behind", async () => {
    const body = Buffer.from("twelve bytes");
    source.files.set("/f.zip", { body });
    expect(await importPhisCdnFile(pool, target, request("/f.zip", body, { sizeBytes: body.length + 1 }), caller()))
      .toMatchObject({ ok: false, refusal: "size-mismatch" });
    expect(await importPhisCdnFile(pool, target, request("/f.zip", body, { sha256: sha("other") }), caller()))
      .toMatchObject({ ok: false, refusal: "checksum-mismatch" });
    source.files.set("/page.zip", { body: Buffer.from("<html>sorry</html>"), type: "text/html; charset=utf-8" });
    expect(await importPhisCdnFile(pool, target, request("/page.zip", Buffer.from("<html>sorry</html>")), caller()))
      .toMatchObject({ ok: false, refusal: "content-type-refused" });
    expect(await importPhisCdnFile(pool, target, request("/missing.zip", body), caller()))
      .toMatchObject({ ok: false, refusal: "source-failed" });

    const big = Buffer.alloc(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES + 10, 7);
    source.files.set("/big.zip", { body: big });
    expect(await importPhisCdnFile(pool, target, request("/big.zip", big, { sha256: sha("other") }), caller()))
      .toMatchObject({ ok: false, refusal: "checksum-mismatch" });
    expect(storage.aborted).toHaveLength(1);

    expect(storage.objects.size).toBe(0);
    expect(storage.uploads.size).toBe(0);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    const { rows } = await pool.query<{ status: number }>(`SELECT status FROM phis.site_cdn_uploads WHERE site_id = $1`, [site.id]);
    expect(rows.every((row) => row.status === PhisCdnUploadStatusCode.Failed)).toBe(true);
    expect(refusals).toEqual(["size-mismatch", "checksum-mismatch", "content-type-refused", "source-failed", "checksum-mismatch"]);
  });

  it("refuses what it may not know or hold before it fetches anything", async () => {
    const body = Buffer.from("x");
    const plain = request("/x.zip", body);
    expect(await importPhisCdnFile(pool, null, plain, caller())).toMatchObject({ ok: false, refusal: "not-configured" });
    expect(await importPhisCdnFile(pool, target, { ...plain, name: "api" }, caller())).toMatchObject({ refusal: "invalid-key" });
    expect(await importPhisCdnFile(pool, target, { ...plain, fileName: "x:y.zip" }, caller())).toMatchObject({ refusal: "invalid-key" });
    expect(await importPhisCdnFile(pool, target, { ...plain, fileName: "x.html" }, caller())).toMatchObject({ refusal: "content-type-refused" });
    expect(await importPhisCdnFile(pool, target, plain, caller({ maxObjectBytes: 0 }))).toMatchObject({ refusal: "too-large" });
    expect(await importPhisCdnFile(pool, target, { ...plain, url: "http://files.example.com/x.zip" }, caller())).toMatchObject({ refusal: "host-not-allowed" });
    expect(await importPhisCdnFile(pool, target, plain, caller({ importHosts: [] }))).toMatchObject({ refusal: "host-not-allowed" });
    await expect(importPhisCdnFile(pool, target, { ...plain, sha256: "ABC" }, caller())).rejects.toThrow(/sha256/u);
    await expect(importPhisCdnFile(pool, target, { ...plain, os: 1 << 6 }, caller())).rejects.toThrow(/os/u);
    await expect(importPhisCdnFile(pool, target, { ...plain, sizeBytes: 0 }, caller())).rejects.toThrow(/sizeBytes/u);

    // The quota of the Site Space, which copied files count in.
    await pool.query(`UPDATE phis.media_spaces SET quota_bytes = 0 WHERE id = $1`, [site.siteSpaceId]);
    source.files.set("/x.zip", { body });
    expect(await importPhisCdnFile(pool, target, plain, caller())).toMatchObject({ refusal: "quota-exceeded" });
    expect(source.requests).toEqual([]);
  });

  it("imports only under a name that is new or wholly the caller's", async () => {
    const body = Buffer.from("y");
    source.files.set("/y.zip", { body });
    await pool.query(
      `WITH f AS (INSERT INTO phis.site_cdn_files (site_id, object_key, name, version, file_name, size_bytes, sha256, content_type)
                  VALUES ($1, 'phis/0.1/old.zip', 'phis', '0.1', 'old.zip', 1, $2, 'application/zip') RETURNING id)
       INSERT INTO phis.site_cdn_file_origins (file_id, origin) SELECT id, 1 FROM f`,
      [site.id, sha("old")],
    );
    expect(await importPhisCdnFile(pool, target, request("/y.zip", body), caller())).toMatchObject({ refusal: "name-not-yours" });
    expect(await importPhisCdnFile(pool, target, request("/y.zip", body, { name: "mine" }), caller())).toMatchObject({ ok: true });
    expect(await importPhisCdnFile(pool, target, request("/y.zip", body, { name: "mine", version: "2" }), caller({ addonId: "@pgtest/other" })))
      .toMatchObject({ refusal: "name-not-yours" });
  });

  it("aborts on its caller's signal, and an open import of the key is busy", async () => {
    const big = Buffer.alloc(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2, 3);
    source.files.set("/stall.bin", { body: big, stall: true });
    const controller = new AbortController();
    const pending = importPhisCdnFile(pool, target, request("/stall.bin", big), caller(), { signal: controller.signal });
    await vi.waitFor(async () => {
      const { rows } = await pool.query(`SELECT 1 FROM phis.site_cdn_uploads WHERE site_id = $1 AND provider_upload_id IS NOT NULL`, [site.id]);
      expect(rows).toHaveLength(1);
    });
    expect(await importPhisCdnFile(pool, target, request("/stall.bin", big), caller())).toMatchObject({ refusal: "busy" });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, refusal: "source-failed" });
    const { rows } = await pool.query<{ status: number }>(`SELECT status FROM phis.site_cdn_uploads WHERE site_id = $1`, [site.id]);
    expect(rows.map((row) => row.status)).toEqual([PhisCdnUploadStatusCode.Aborted]);
    expect(storage.uploads.size).toBe(0);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
  });

  it("links a file without bytes, counting nothing; again is Already, a copy's key is taken", async () => {
    const link = {
      name: "phis", version: "0.8.1", fileName: "phis_0.8.1_arm64.deb",
      url: "https://files.example.com/phis_0.8.1_arm64.deb", sizeBytes: 5_000_000_000, sha256: "c".repeat(64),
      arch: PhisCdnFileArch.Arm64,
    };
    const linked = await linkPhisCdnFile(pool, target, link, caller({ maxObjectBytes: 10_000_000_000 }));
    expect(linked).toMatchObject({ ok: true, flags: 0, file: { storage: "link", url: link.url, arch: PhisCdnFileArch.Arm64 } });
    expect(await linkPhisCdnFile(pool, target, link, caller({ maxObjectBytes: 10_000_000_000 })))
      .toMatchObject({ ok: true, flags: PhisCdnPublishResultFlags.Already });
    expect(await linkPhisCdnFile(pool, target, { ...link, sha256: "d".repeat(64) }, caller({ maxObjectBytes: 10_000_000_000 })))
      .toMatchObject({ refusal: "key-taken" });
    expect(await linkPhisCdnFile(pool, target, { ...link, version: "2" }, caller())).toMatchObject({ refusal: "too-large" });
    expect(await linkPhisCdnFile(pool, target, { ...link, url: "https://elsewhere.example.com/x.deb", version: "3" }, caller({ maxObjectBytes: 10_000_000_000 })))
      .toMatchObject({ refusal: "host-not-allowed" });
    await expect(linkPhisCdnFile(pool, target, { ...link, sha256: null as unknown as string }, caller())).rejects.toThrow(/sha256/u);
    expect(storage.objects.size).toBe(0);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    const offered = await buildPhisAddonCdnCapability({ siteId: site.id }).files({ name: "phis" });
    expect(offered.map((file) => [file.key, file.storage])).toEqual([["phis/0.8.1/phis_0.8.1_arm64.deb", "link"]]);

    const body = Buffer.from("copy");
    source.files.set("/copy.zip", { body });
    await importPhisCdnFile(pool, target, request("/copy.zip", body), caller());
    expect(await linkPhisCdnFile(pool, target, { ...link, version: "0.8.1-1", fileName: "copy.zip", sha256: sha(body), sizeBytes: 4 }, caller()))
      .toMatchObject({ refusal: "key-taken" });
  });

  it("moves a link to the address its source names now, for the same bytes only", async () => {
    const link = {
      name: "phis", version: "0.8.2", fileName: "phis_0.8.2_amd64.deb",
      url: "https://files.example.com/old/phis_0.8.2_amd64.deb", sizeBytes: 1234, sha256: "e".repeat(64),
    };
    const moves: { key: string; from: string | null; to: string }[] = [];
    const moving = caller({ onLinkMoved: (move) => moves.push(move) });
    expect(await linkPhisCdnFile(pool, target, link, moving)).toMatchObject({ ok: true, flags: 0, file: { url: link.url } });

    const moved = { ...link, url: "https://objects.example.com/new/phis_0.8.2_amd64.deb" };
    expect(await linkPhisCdnFile(pool, target, moved, moving))
      .toMatchObject({ ok: true, flags: PhisCdnPublishResultFlags.Already, file: { url: moved.url, sha256: link.sha256, sizeBytes: 1234 } });
    expect(moves).toEqual([{ key: "phis/0.8.2/phis_0.8.2_amd64.deb", from: link.url, to: moved.url }]);
    // What cdn:v1 answers -- and the counting route redirects to -- is the new address.
    expect(await buildPhisAddonCdnCapability({ siteId: site.id }).file("phis/0.8.2/phis_0.8.2_amd64.deb"))
      .toMatchObject({ storage: "link", url: moved.url });
    // Asking again with the address it has now changes nothing.
    expect(await linkPhisCdnFile(pool, target, moved, moving)).toMatchObject({ ok: true, flags: PhisCdnPublishResultFlags.Already });
    expect(moves).toHaveLength(1);

    // Other bytes -- another SHA-256 or another size -- never move the link: the key stays as it was.
    const elsewhere = "https://files.example.com/other/phis_0.8.2_amd64.deb";
    expect(await linkPhisCdnFile(pool, target, { ...link, url: elsewhere, sha256: "f".repeat(64) }, moving)).toMatchObject({ refusal: "key-taken" });
    expect(await linkPhisCdnFile(pool, target, { ...link, url: elsewhere, sizeBytes: 1235 }, moving)).toMatchObject({ refusal: "key-taken" });
    expect(moves).toHaveLength(1);
    const { rows } = await pool.query<{ source_url: string }>(
      `SELECT o.source_url FROM phis.site_cdn_file_origins o JOIN phis.site_cdn_files f ON f.id = o.file_id
        WHERE f.site_id = $1 AND f.object_key = $2`,
      [site.id, "phis/0.8.2/phis_0.8.2_amd64.deb"],
    );
    expect(rows).toEqual([{ source_url: moved.url }]);

    // A withdrawn link stays where it was withdrawn.
    expect(await withdrawSiteCdnFile(pool, site.id, "phis/0.8.2/phis_0.8.2_amd64.deb")).toBe(true);
    expect(await linkPhisCdnFile(pool, target, { ...link, url: elsewhere }, moving)).toMatchObject({ refusal: "key-taken" });
    expect(moves).toHaveLength(1);
  });

  it("is not handed to an unverified hook", async () => {
    const capability = buildPhisAddonCdnPublishCapability({ addonId: ADDON, siteId: site.id, siteKey: site.key, unauthenticated: true });
    await expect(capability.import(request("/x.zip", Buffer.from("x")))).rejects.toThrow(/unverified hook/u);
    await expect(capability.link({ ...request("/x.zip", Buffer.from("x")), sha256: "a".repeat(64) })).rejects.toThrow(/unverified hook/u);
  });

  it("prunes an import whose instance died: its reservation back, its assembly given up", async () => {
    await setPhiTestMediaConfig(site, {});
    const big = Buffer.alloc(PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2, 1);
    source.files.set("/dead.bin", { body: big, stall: true });
    const controller = new AbortController();
    const pending = importPhisCdnFile(pool, target, request("/dead.bin", big), caller(), { signal: controller.signal });
    await vi.waitFor(async () => {
      const { rows } = await pool.query(`SELECT 1 FROM phis.site_cdn_uploads WHERE site_id = $1 AND provider_upload_id IS NOT NULL`, [site.id]);
      expect(rows).toHaveLength(1);
    });
    expect((await readPhiTestSpaceBytes(site.siteSpaceId))!.reserved).toBe(big.length);
    // As if the instance were gone: the row ran out.
    await pool.query(`UPDATE phis.site_cdn_uploads SET expires_at = NOW() - INTERVAL '1 minute' WHERE site_id = $1`, [site.id]);
    const pruned = await prunePhisCdnUploads(pool, { openTarget: async () => target });
    expect(pruned.detail).toMatch(/^1 upload\(s\) aborted/u);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    expect(storage.uploads.size).toBe(0);
    controller.abort();
    // The import notices it no longer owns the row and gives nothing back twice.
    expect(await pending).toMatchObject({ ok: false });
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
  });
});
