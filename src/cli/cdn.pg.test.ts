import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Pool } from "pg";

import {
  PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES,
  PhisCdnCheckObjectFlags,
  PhisCdnFileArch,
  PhisCdnFileOs,
} from "@phis/contracts/addon";

import { PhiTestCdnStorage } from "../../test/pg/cdn-fake-storage";
import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { buildPhisAddonCdnCapability } from "../lib/addons/cdn-capability";
import { PhiMediaStorageProfileFlags } from "../lib/constants/media";
import { runPhisCdnCommand, type PhisCdnCommandDeps } from "./cdn.mts";
import { useStorageProfile } from "./storage.mts";

const configured = process.env.PHIS_PG_TEST === "1";
const flags = (entries: Record<string, string | true>) => new Map<string, string | boolean>(Object.entries(entries));

describe.skipIf(!configured)("phis cdn", () => {
  let pool: Pool;
  let site: PhiTestSite;
  let profileId: number;
  let root: string;
  let files: string;
  const storage = new PhiTestCdnStorage();
  let deps: PhisCdnCommandDeps;
  const cdn = (command: string, entries: Record<string, string | true> = {}) =>
    runPhisCdnCommand(deps, command, flags({ site: site.key, ...entries }));

  beforeAll(async () => {
    pool = await requirePhiTestDatabase();
    await storage.start();
    root = mkdtempSync(path.join(os.tmpdir(), "phis-cdn-root-"));
    files = mkdtempSync(path.join(os.tmpdir(), "phis-cdn-files-"));
    deps = { root, pool, readSecret: async () => null, adapterFor: async () => storage.adapter(), progress: () => {} };
  });

  beforeEach(async () => {
    site = await createPhiTestSite("cdn");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO phis.media_storage_profiles (site_id, key, provider_id, flags, checksum_algorithm)
       VALUES ($1, 'cdn', '@pgtest/storage/s3', $2, 'sha256') RETURNING id`,
      [site.id, PhiMediaStorageProfileFlags.Cdn],
    );
    profileId = rows[0]!.id;
    storage.reset();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await storage.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
    await closePhiTestPool();
  });

  function file(name: string, bytes: Buffer) {
    const directory = path.join(files, randomUUID());
    mkdirSync(directory);
    const target = path.join(directory, name);
    writeFileSync(target, bytes);
    return target;
  }

  it("attaches only a CDN Profile, and a Space cannot write to one", async () => {
    await pool.query(`INSERT INTO phis.media_storage_profiles (site_id, key, provider_id) VALUES ($1, 'plain', '@pgtest/storage/s3')`, [site.id]);
    await expect(cdn("attach", { profile: "plain", "public-base-url": "https://cdn.example.invalid" })).rejects.toThrow(/not a CDN Profile/u);
    await expect(useStorageProfile(pool, flags({ site: site.key, key: "cdn" }))).rejects.toThrow(/CDN/u);

    const attached = await cdn("attach", { profile: "cdn", "public-base-url": "https://cdn.example.invalid/" });
    expect(attached).toMatchObject({ action: "cdn.attach", publicBaseUrl: "https://cdn.example.invalid" });
    // The host does not exist, which is a finding and not a failure; the probe object is gone again.
    expect(attached.action === "cdn.attach" && attached.delivery.delivers).toBe(false);
    expect(storage.objects.size).toBe(0);
    const { rows } = await pool.query(`SELECT storage_profile_id FROM phis.site_cdns WHERE site_id = $1`, [site.id]);
    expect(rows[0]).toEqual({ storage_profile_id: profileId });
  });

  it("publishes a file once, records it, and offers it through cdn:v1", async () => {
    await cdn("attach", { profile: "cdn", "public-base-url": "https://cdn.example.invalid" });
    const capability = buildPhisAddonCdnCapability({ siteId: site.id });
    expect(await capability.configured()).toBe(true);
    expect(await capability.files()).toEqual([]);

    const bytes = Buffer.from("weights\n");
    const source = file("model.gguf", bytes);
    const published = await cdn("publish", { name: "qwen", version: "1.0.0", file: source, as: "model.gguf" });
    expect(published).toMatchObject({ action: "cdn.publish", verified: true });
    expect(storage.objects.get("qwen/1.0.0/model.gguf")?.body.equals(bytes)).toBe(true);

    const offered = await capability.file("qwen/1.0.0/model.gguf");
    expect(offered).toMatchObject({
      name: "qwen", version: "1.0.0", fileName: "model.gguf", sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream",
      url: "https://cdn.example.invalid/qwen/1.0.0/model.gguf",
    });
    expect(await capability.files({ name: "qwen" })).toHaveLength(1);
    expect(await capability.files({ name: "other" })).toEqual([]);

    await expect(cdn("publish", { name: "qwen", version: "1.0.0", file: source, as: "model.gguf" })).rejects.toThrow(/written once/u);
    await expect(cdn("publish", { name: "qwen", version: "1.0.1", file: file("x.html", bytes) })).rejects.toThrow(/\.html/u);
  });

  it("uploads in parts and carries an interrupted upload on", async () => {
    await cdn("attach", { profile: "cdn", "public-base-url": "https://cdn.example.invalid" });
    const size = PHIS_MEDIA_UPLOAD_PART_SIZE_BYTES * 2 + 1234;
    const bytes = Buffer.alloc(size);
    for (let index = 0; index < size; index += 4096) bytes[index] = index % 251;
    const source = file("big.bin", bytes);

    storage.refuseParts.add(2);
    await expect(cdn("publish", { name: "big", version: "1", file: source })).rejects.toThrow(/refused the upload/u);
    expect(storage.objects.has("big/1/big.bin")).toBe(false);
    const [open] = [...storage.uploads.values()];
    expect([...open!.parts.keys()].sort()).toEqual([1, 3]);

    storage.refuseParts.clear();
    const published = await cdn("publish", { name: "big", version: "1", file: source });
    expect(published.action === "cdn.publish" && published.file.sizeBytes).toBe(size);
    expect(storage.objects.get("big/1/big.bin")?.body.equals(bytes)).toBe(true);
    expect(storage.uploads.size).toBe(0);
  });

  it("withdraws, deletes on request, and checks the bucket against the catalogue", async () => {
    await cdn("attach", { profile: "cdn", "public-base-url": "https://cdn.example.invalid" });
    await cdn("publish", { name: "a", version: "1", file: file("a.zip", Buffer.from("a")) });
    await cdn("publish", { name: "b", version: "1", file: file("b.zip", Buffer.from("b")) });
    const capability = buildPhisAddonCdnCapability({ siteId: site.id });

    await expect(cdn("detach")).rejects.toThrow(/still offers/u);
    await cdn("withdraw", { key: "a/1/a.zip" });
    expect(await capability.file("a/1/a.zip")).toBeNull();
    expect(storage.objects.has("a/1/a.zip")).toBe(true);
    await expect(cdn("publish", { name: "a", version: "1", file: file("a.zip", Buffer.from("a")) })).rejects.toThrow(/written once/u);

    await cdn("withdraw", { key: "b/1/b.zip", delete: true });
    expect(storage.objects.has("b/1/b.zip")).toBe(false);

    storage.objects.set("c/2/c.tar", { body: Buffer.from("cc"), contentType: "application/x-tar" });
    storage.objects.set("loose.txt", { body: Buffer.from("x"), contentType: "text/plain" });
    const checked = await cdn("check");
    expect(checked).toMatchObject({ action: "cdn.check", missing: [], adopted: [] });
    expect(checked.action === "cdn.check" && checked.unrecorded.map((entry) => [entry.key, entry.flags])).toEqual([
      ["c/2/c.tar", PhisCdnCheckObjectFlags.Adoptable],
      ["loose.txt", 0],
    ]);
    const adopted = await cdn("check", { adopt: true });
    expect(adopted.action === "cdn.check" && adopted.adopted).toEqual(["c/2/c.tar"]);
    expect(await capability.file("c/2/c.tar")).toMatchObject({ sizeBytes: 2, sha256: createHash("sha256").update("cc").digest("hex") });

    storage.objects.delete("c/2/c.tar");
    const missing = await cdn("check");
    expect(missing).toMatchObject({ ok: false, missing: ["c/2/c.tar"] });

    const listed = await cdn("list", { withdrawn: true });
    expect(listed.action === "cdn.list" && listed.files.map((entry) => [entry.key, entry.state, entry.origin.kind])).toEqual([
      ["a/1/a.zip", "withdrawn", "cli"], ["b/1/b.zip", "deleted", "cli"], ["c/2/c.tar", "offered", "cli"],
    ]);
    // a (1 byte) and the adopted c (2 bytes) are stored; b's byte left with its delete.
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 3, reserved: 0 });
  });

  it("states the platform from --os/--arch or the file name, and takes a tilde and an epoch", async () => {
    await cdn("attach", { profile: "cdn", "public-base-url": "https://cdn.example.invalid" });
    const deb = await cdn("publish", { name: "phis", version: "1:0.8.1~beta.1-1", file: file("phis_0.8.1~beta.1-1+trixie_amd64.deb", Buffer.from("deb")) });
    expect(deb.action === "cdn.publish" && deb.file).toMatchObject({
      key: "phis/1:0.8.1~beta.1-1/phis_0.8.1~beta.1-1+trixie_amd64.deb",
      storage: "cdn", os: PhisCdnFileOs.Linux, arch: PhisCdnFileArch.X64,
      url: "https://cdn.example.invalid/phis/1%3A0.8.1~beta.1-1/phis_0.8.1~beta.1-1%2Btrixie_amd64.deb",
    });
    const stated = await cdn("publish", { name: "tool", version: "2", file: file("tool.zip", Buffer.from("zip")), os: "macos,windows", arch: "arm64" });
    expect(stated.action === "cdn.publish" && [stated.file.os, stated.file.arch, stated.platform]).toEqual([
      PhisCdnFileOs.Windows | PhisCdnFileOs.MacOS, PhisCdnFileArch.Arm64, { os: ["windows", "macos"], arch: ["arm64"] },
    ]);
    await expect(cdn("publish", { name: "tool", version: "3", file: file("tool.zip", Buffer.from("zip")), os: "beos" })).rejects.toThrow(/--os "beos"/u);
    await expect(cdn("publish", { name: "a:b", version: "1", file: file("x.zip", Buffer.from("x")) })).rejects.toThrow(/--name/u);
    const { rows } = await pool.query<{ flags: number }>(`SELECT flags FROM phis.site_cdn_files WHERE site_id = $1 AND name = 'tool'`, [site.id]);
    expect(rows[0]!.flags).toBe(((PhisCdnFileOs.Windows | PhisCdnFileOs.MacOS) << 8) | (PhisCdnFileArch.Arm64 << 16));
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: 6, reserved: 0 });
  });

  it("answers empty on a Site without a CDN", async () => {
    const capability = buildPhisAddonCdnCapability({ siteId: site.id });
    expect(await capability.configured()).toBe(false);
    expect(await capability.files()).toEqual([]);
    expect(await capability.file("a/1/a.zip")).toBeNull();
    await expect(cdn("publish", { name: "a", version: "1", file: file("a.zip", Buffer.from("a")) })).rejects.toThrow(/no CDN/u);
  });
});
