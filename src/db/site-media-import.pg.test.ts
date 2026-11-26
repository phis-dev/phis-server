import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/*
 * `phis media import` against the development database: the Folder made along its path, a file into it as
 * a ready, publicly delivered Asset with the quota booked, bytes already there answered as their Asset,
 * the refusals (Site limit, quota, unsafe content, a stated length the body does not keep), a file past
 * the image decode limit streamed rather than held, and the route's own reading of the request. The
 * Storage Service is an in-memory one; everything else is the real thing.
 */

const stored = vi.hoisted(() => new Map<string, Buffer>());
const streamed = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null, getApiV1TokenMode: () => "internal" }));
vi.mock("@/lib/media-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-storage")>()),
  createPhisMediaStorageServiceForProfile: async () => ({
    createStorageKey: ({ siteKey }: { siteKey: string }) => `pgtest/${siteKey}/${stored.size + 1}-${Math.random().toString(16).slice(2)}`,
    putObject: async (input: { storageKey: string; body: Buffer }) => {
      stored.set(input.storageKey, input.body);
      return { storageKey: input.storageKey, byteSize: input.body.byteLength, contentType: "x", etag: "x", lastModifiedAt: new Date().toISOString(), metadata: {} };
    },
    putObjectStream: async (input: { storageKey: string; body: ReadableStream<Uint8Array> }) => {
      streamed.count += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      stored.set(input.storageKey, body);
      return { storageKey: input.storageKey, byteSize: body.byteLength, contentType: "x", etag: "x", lastModifiedAt: new Date().toISOString(), metadata: {} };
    },
    deleteObject: async (key: string) => { stored.delete(key); },
  }),
}));

import {
  closePhiTestPool,
  createPhiTestSite,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { PhiMediaFolderFlags } from "@/lib/constants/media";
import { PhiMediaDeliveryPolicy, PhiMediaLifecycleStatus } from "@/db/media-spaces";
import { PHI_IMAGE_DECODE_LIMIT_BYTES } from "@/lib/media-content-check";
import { ensureSiteMediaImportFolder, importSiteMediaFile, type SiteMediaImportFileInput } from "@/lib/site-media-import";
import { importModuleMediaFile } from "@/lib/module-media-import";
import { POST as importRoute } from "@/app/api/v1/media/import/route";
import { POST as folderRoute } from "@/app/api/v1/media/import/folder/route";

const streamOf = (body: Buffer, chunk = 1 << 20) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (let offset = 0; offset < body.byteLength; offset += chunk) controller.enqueue(body.subarray(offset, offset + chunk));
    controller.close();
  },
});

describe("phis media import against PostgreSQL", () => {
  let site: PhiTestSite;
  let png: Buffer;
  let png2: Buffer;

  const ref = (s: PhiTestSite = site) => ({ id: s.id, key: s.key });
  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const pool = await requirePhiTestDatabase();
    return (await pool.query(text, params)).rows as T[];
  }
  const assetCount = async (s = site) => Number((await sql<{ n: string }>(`SELECT count(*) n FROM phis.media_assets WHERE site_id = $1`, [s.id]))[0]!.n);
  const file = (body: Buffer, extra: Partial<SiteMediaImportFileInput> = {}): SiteMediaImportFileInput => ({
    body: streamOf(body), byteLength: body.byteLength, folderId: null, originalName: "picture.png", alt: null, title: null, ...extra,
  });

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("mediaimport");
    await sql(`UPDATE phis.sites SET flags = flags | $2 WHERE id = $1`, [site.id, SITE_FLAG_ACTIVE]);
    png = await sharp({ create: { width: 12, height: 8, channels: 3, background: "#00ff00" } }).png().toBuffer();
    png2 = await sharp({ create: { width: 7, height: 7, channels: 3, background: "#ff00ff" } }).png().toBuffer();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("the folder", () => {
    it("makes every missing Folder along the path, and the second time finds them", async () => {
      const first = await ensureSiteMediaImportFolder(ref(), { path: ["Products", "PhiVoice"] });
      expect(first).toMatchObject({ status: "ready", path: ["Products", "PhiVoice"], created: ["Products", "PhiVoice"] });
      const again = await ensureSiteMediaImportFolder(ref(), { path: ["products", "PhiVoice"] });
      expect(again).toMatchObject({ status: "ready", created: [] });
      expect(again.status === "ready" && first.status === "ready" && again.folderId === first.folderId).toBe(true);
      const deeper = await ensureSiteMediaImportFolder(ref(), { path: ["Products", "PhiVoice", "Screens"] });
      expect(deeper).toMatchObject({ status: "ready", created: ["Screens"] });
    });

    it("names a Folder by id with its path, and refuses one of another Site or a locked one", async () => {
      const made = await ensureSiteMediaImportFolder(ref(), { path: ["By id", "Inner"] });
      if (made.status !== "ready") throw new Error("not made");
      expect(await ensureSiteMediaImportFolder(ref(), { id: made.folderId })).toEqual({
        status: "ready", folderId: made.folderId, path: ["By id", "Inner"], created: [],
      });
      const other = await createPhiTestSite("mediaimport-other");
      expect(await ensureSiteMediaImportFolder(ref(other), { id: made.folderId })).toMatchObject({ status: "refused", reason: "folder_not_found" });

      await sql(`UPDATE phis.media_folders SET flags = flags | $2 WHERE id = $1`, [made.folderId, PhiMediaFolderFlags.Locked]);
      expect(await ensureSiteMediaImportFolder(ref(), { id: made.folderId })).toMatchObject({ status: "refused", reason: "media_folder_locked" });
      expect(await ensureSiteMediaImportFolder(ref(), { path: ["By id", "Inner"] })).toMatchObject({ status: "refused", reason: "media_folder_locked" });
      expect(await ensureSiteMediaImportFolder(ref(), { path: ["By id", "Inner", "Below"] })).toMatchObject({ status: "refused", reason: "media_folder_locked" });
      expect(await sql(`SELECT 1 FROM phis.media_folders WHERE site_id = $1 AND name = 'Below'`, [site.id])).toHaveLength(0);
    });

    it("is read by the route: exactly one of path or id", async () => {
      const headers = { "user-agent": "t", "x-phis-site-key": site.key, "content-type": "application/json" };
      const post = (body: unknown) => folderRoute(new Request("https://core.test/x", { method: "POST", headers, body: JSON.stringify(body) }));
      expect((await post({ path: ["A"], id: 1 })).status).toBe(400);
      expect((await post({ path: [] })).status).toBe(400);
      expect((await post({ path: ["ok", " "] })).status).toBe(400);
      const ok = await post({ path: ["Route made"] });
      expect(ok.status).toBe(200);
      expect((await ok.json()).result).toMatchObject({ status: "ready", created: ["Route made"] });
    });
  });

  describe("a file", () => {
    it("becomes a ready, publicly delivered Asset in the Folder, with its texts, digest and dimensions, the quota booked", async () => {
      const folder = await ensureSiteMediaImportFolder(ref(), { path: ["Products"] });
      if (folder.status !== "ready") throw new Error("no folder");
      const before = (await readPhiTestSpaceBytes(site.siteSpaceId))!;
      const result = await importSiteMediaFile(ref(), file(png, { folderId: folder.folderId, alt: "A green box", title: "Box" }));
      expect(result).toMatchObject({ status: "created", name: "picture.png", contentType: "image/png", bytes: png.byteLength, folderId: folder.folderId });
      if (result.status !== "created") throw new Error("not created");
      const [row] = await sql(`SELECT folder_id, alt_text, title, width, height, checksum_algorithm, checksum_value, lifecycle_status,
          delivery_policy, meta, space_id FROM phis.media_assets WHERE id = $1`, [result.assetId]);
      expect(row).toEqual({
        folder_id: folder.folderId, alt_text: "A green box", title: "Box", width: 12, height: 8,
        checksum_algorithm: "sha256", checksum_value: createHash("sha256").update(png).digest("hex"),
        lifecycle_status: PhiMediaLifecycleStatus.Ready, delivery_policy: PhiMediaDeliveryPolicy.Public,
        meta: { source: "cli" }, space_id: site.siteSpaceId,
      });
      expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: before.used + png.byteLength, reserved: before.reserved });
    });

    it("answers bytes already in the Site Space as their Asset, and writes nothing", async () => {
      const first = await importSiteMediaFile(ref(), file(png2, { originalName: "second.png" }));
      const count = await assetCount();
      const objects = stored.size;
      const again = await importSiteMediaFile(ref(), file(png2, { originalName: "renamed.png", alt: "ignored" }));
      expect(first.status).toBe("created");
      expect(again).toMatchObject({ status: "existing", name: "second.png" });
      expect(again.status !== "refused" && first.status !== "refused" && again.assetId === first.assetId).toBe(true);
      expect(await assetCount()).toBe(count);
      expect(stored.size).toBe(objects);
    });

    it("refuses with a reason, books nothing and keeps no object", async () => {
      const count = await assetCount();
      const objects = stored.size;
      const used = (await readPhiTestSpaceBytes(site.siteSpaceId))!;
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const results = [
        await importSiteMediaFile(ref(), file(svg, { originalName: "evil.svg" })),
        await importSiteMediaFile(ref(), file(Buffer.alloc(0))),
        await importSiteMediaFile(ref(), file(png, { byteLength: png.byteLength + 5 })),
        await importSiteMediaFile(ref(), file(png, { folderId: 2_000_000_000 })),
        await importSiteMediaFile(ref(), file(png, { originalName: "x".repeat(300) })),
      ];
      expect(results.map((item) => item.status === "refused" ? item.reason : item.status)).toEqual([
        "unsafe_svg_upload", "empty_file", "body_length_mismatch", "folder_not_found", "invalid_name",
      ]);
      expect(await assetCount()).toBe(count);
      expect(stored.size).toBe(objects);
      expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual(used);
    });

    it("refuses a file over the Site's object limit, and one the quota has no room for", async () => {
      const own = await createPhiTestSite("mediaimport-limits");
      await sql(`INSERT INTO phis.site_media_config (site_id, max_object_bytes) VALUES ($1, $2)
        ON CONFLICT (site_id) DO UPDATE SET max_object_bytes = EXCLUDED.max_object_bytes`, [own.id, png.byteLength - 1]);
      expect(await importSiteMediaFile(ref(own), file(png))).toMatchObject({ status: "refused", reason: "media_asset_too_large" });
      await sql(`UPDATE phis.site_media_config SET max_object_bytes = 1048576 WHERE site_id = $1`, [own.id]);
      await sql(`UPDATE phis.media_spaces SET quota_bytes = 10 WHERE id = $1`, [own.siteSpaceId]);
      expect(await importSiteMediaFile(ref(own), file(png))).toMatchObject({ status: "refused", reason: "media_quota_exceeded" });
      expect(await readPhiTestSpaceBytes(own.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
      expect(await assetCount(own)).toBe(0);
    });

    it("streams a file past the image decode limit to the Provider instead of holding it", async () => {
      const big = Buffer.alloc(PHI_IMAGE_DECODE_LIMIT_BYTES + 3 * 1024 * 1024);
      png.copy(big, 0, 0, 64);
      big.write("streamed tail", big.byteLength - 20);
      const before = streamed.count;
      const result = await importSiteMediaFile(ref(), file(big, { originalName: "big.png" }));
      expect(streamed.count).toBe(before + 1);
      expect(result).toMatchObject({ status: "created", contentType: "image/png", bytes: big.byteLength });
      if (result.status !== "created") throw new Error("not created");
      const [row] = await sql<{ checksum_value: string; width: number | null; storage_key: string }>(
        `SELECT checksum_value, width, storage_key FROM phis.media_assets WHERE id = $1`, [result.assetId],
      );
      expect(row!.checksum_value).toBe(createHash("sha256").update(big).digest("hex"));
      expect(row!.width).toBeNull();
      expect(stored.get(row!.storage_key)!.equals(big)).toBe(true);
      await sql(`DELETE FROM phis.media_assets WHERE id = $1`, [result.assetId]);
      stored.delete(row!.storage_key);
    });

    it("refuses a streamed body that carries more than it stated, and keeps no object", async () => {
      // Stated past the decode limit, so the body is past holding when it overruns: the stream itself stops it.
      const big = Buffer.alloc(PHI_IMAGE_DECODE_LIMIT_BYTES + 3 * 1024 * 1024);
      png.copy(big, 0, 0, 64);
      big.write("other tail", big.byteLength - 20);
      const objects = stored.size;
      const before = streamed.count;
      const result = await importSiteMediaFile(ref(), file(big, { byteLength: big.byteLength - 1024 * 1024 }));
      expect(streamed.count).toBe(before + 1);
      expect(result).toMatchObject({ status: "refused", reason: "body_length_mismatch" });
      expect(stored.size).toBe(objects);
    });

    it("is read by the route from the raw body, its length and the query", async () => {
      const headers = { "user-agent": "t", "x-phis-site-key": site.key, "content-type": "application/octet-stream" };
      const post = (query: string, body: Buffer, length: string | null = String(body.byteLength)) => importRoute(new Request(
        `https://core.test/api/v1/media/import?${query}`,
        { method: "POST", headers: { ...headers, ...(length !== null ? { "content-length": length } : {}) }, body: streamOf(body), duplex: "half" } as RequestInit,
      ));
      expect((await post("folder=1", png)).status).toBe(400);
      expect((await post("name=a.png&folder=x", png)).status).toBe(400);
      expect((await post("name=a.png", png, null)).status).toBe(400);
      const third = await sharp({ create: { width: 3, height: 5, channels: 3, background: "#123456" } }).png().toBuffer();
      const ok = await post(`name=${encodeURIComponent("dir/route.png")}&alt=${encodeURIComponent("Ä alt")}`, third);
      expect(ok.status).toBe(200);
      const { result } = await ok.json();
      expect(result).toMatchObject({ status: "created", name: "route.png", contentType: "image/png", bytes: third.byteLength, folderId: null });
      const [row] = await sql(`SELECT alt_text, title FROM phis.media_assets WHERE id = $1`, [result.assetId]);
      expect(row).toEqual({ alt_text: "Ä alt", title: null });
    });
  });

  it("leaves the Module media import as it was: one writer, one row per name", async () => {
    const result = await importModuleMediaFile(ref(), {
      packageName: "@pgtest/import", key: "icon", folderKey: null, alt: "Icon", title: null, originalName: "icon.png",
      body: await sharp({ create: { width: 4, height: 4, channels: 3, background: "#abcdef" } }).png().toBuffer(),
    });
    expect(result).toMatchObject({ status: "created" });
    const [row] = await sql(`SELECT a.meta, a.delivery_policy FROM phis.site_module_media m JOIN phis.media_assets a ON a.id = m.asset_id
      WHERE m.site_id = $1 AND m.key = 'icon'`, [site.id]);
    expect(row).toEqual({ meta: { source: "module", package: "@pgtest/import", key: "icon" }, delivery_policy: PhiMediaDeliveryPolicy.Public });
  });
});
