import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/*
 * The import of one item of a media source into the Site Space (design/MEDIA_SOURCES.md, section 5)
 * against the development database's test Sites: the Asset row, its provenance, the quota counters, the
 * Folder rules, the same bytes twice, and the object removed when the write fails. The Storage Service
 * is an in-memory one; everything else is the real thing.
 */

const stored = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@/lib/media-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-storage")>()),
  createPhisMediaStorageServiceForProfile: async () => ({
    createStorageKey: ({ siteKey }: { siteKey: string }) => `pgtest/${siteKey}/${stored.size + 1}-${Math.random().toString(16).slice(2)}`,
    putObject: async (input: { storageKey: string; body: Buffer }) => {
      stored.set(input.storageKey, input.body);
      return { storageKey: input.storageKey, byteSize: input.body.byteLength, contentType: "x", etag: "x", lastModifiedAt: new Date().toISOString(), metadata: {} };
    },
    deleteObject: async (key: string) => { stored.delete(key); },
  }),
}));

import {
  closePhiTestPool,
  createPhiTestSite,
  createPhiTestUser,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { PhiMediaFolderFlags } from "@/lib/constants/media";
import {
  importMediaSourceItem,
  MediaSourceError,
  setMediaSourceTargetSourceForTests,
} from "@/lib/media-sources";

describe("media source import against PostgreSQL", () => {
  let site: PhiTestSite;
  let userId: number;
  let png: Buffer;
  let png2: Buffer;
  let next: { bytes: Buffer; credit?: string | null } = { bytes: Buffer.alloc(0) };

  const ref = () => ({ id: site.id, key: site.key });
  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const pool = await requirePhiTestDatabase();
    return (await pool.query(text, params)).rows as T[];
  }
  const assetCount = async () => Number((await sql<{ n: string }>(`SELECT count(*) n FROM phis.media_assets WHERE site_id = $1`, [site.id]))[0]!.n);
  const take = (over: Partial<Parameters<typeof importMediaSourceItem>[0]> = {}) =>
    importMediaSourceItem({ site: ref(), source: "pgsrc#stock", itemId: "item-1", folderId: null, actorUserId: userId, ...over });

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("mediasource");
    userId = await createPhiTestUser(site);
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#ff0000" } }).png().toBuffer();
    png2 = await sharp({ create: { width: 9, height: 9, channels: 3, background: "#0000ff" } }).png().toBuffer();
    setMediaSourceTargetSourceForTests(async () => [{
      providerKey: "pgsrc",
      providerId: "@pgtest/source",
      adapter: {
        probe: async () => ({ flags: 1, sources: [{ key: "stock", label: "Stock" }], findings: [] }),
        list: async () => ({ items: [], nextCursor: null }),
        take: async () => ({
          bytes: new Uint8Array(next.bytes), contentType: "image/png", fileName: "pic.png", title: "A picture",
          altText: "Alt", credit: next.credit ?? null,
        }),
      },
    }]);
  });

  afterAll(async () => {
    setMediaSourceTargetSourceForTests(null);
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  it("creates a ready Asset in the Site Space with its texts, provenance and the booked quota", async () => {
    next = { bytes: png, credit: "Photo: X" };
    const folder = (await sql<{ id: number }>(
      `INSERT INTO phis.media_folders (site_id, space_id, name) VALUES ($1, $2, 'Stock') RETURNING id`, [site.id, site.siteSpaceId]))[0]!;
    const asset = await take({ folderId: folder.id });
    expect(asset).toMatchObject({
      spaceId: site.siteSpaceId, folderId: folder.id, createdByUserId: userId, title: "A picture", altText: "Alt",
      contentType: "image/png", width: 8, height: 6, bytes: png.byteLength, checksumAlgorithm: "sha256",
      meta: { source: "media-source", providerKey: "pgsrc", sourceKey: "stock", itemId: "item-1", credit: "Photo: X" },
    });
    expect(stored.size).toBe(1);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: png.byteLength, reserved: 0 });
  });

  it("answers the same Asset for the same bytes and writes nothing the second time", async () => {
    const before = await assetCount();
    const again = await take();
    const [existing] = await sql<{ id: number }>(`SELECT id FROM phis.media_assets WHERE site_id = $1`, [site.id]);
    expect(again.id).toBe(existing!.id);
    expect(await assetCount()).toBe(before);
    expect(stored.size).toBe(1);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: png.byteLength, reserved: 0 });
  });

  it("refuses a locked Folder and a Folder of nowhere, and writes nothing", async () => {
    next = { bytes: png2 };
    const locked = (await sql<{ id: number }>(
      `INSERT INTO phis.media_folders (site_id, space_id, name, flags) VALUES ($1, $2, 'Locked', $3) RETURNING id`,
      [site.id, site.siteSpaceId, PhiMediaFolderFlags.Locked]))[0]!;
    const before = await assetCount();
    await expect(take({ folderId: locked.id })).rejects.toMatchObject({ code: "folder_locked", status: 409 });
    await expect(take({ folderId: 2_000_000_000 })).rejects.toMatchObject({ code: "folder_not_found", status: 404 });
    expect(await assetCount()).toBe(before);
  });

  it("refuses when the quota is used up, with nothing reserved or stored", async () => {
    next = { bytes: png2 };
    await sql(`UPDATE phis.media_spaces SET quota_bytes = $2 WHERE id = $1`, [site.siteSpaceId, png.byteLength + 1]);
    const objects = stored.size;
    await expect(take()).rejects.toMatchObject({ code: "media_quota_exceeded", status: 413 });
    expect(stored.size).toBe(objects);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: png.byteLength, reserved: 0 });
    await sql(`UPDATE phis.media_spaces SET quota_bytes = NULL WHERE id = $1`, [site.siteSpaceId]);
  });

  it("removes the object and the reservation when the write fails after the object was stored", async () => {
    next = { bytes: png2 };
    const objects = stored.size;
    const before = await assetCount();
    // No such user: the Asset row is refused after the object was written.
    await expect(take({ actorUserId: 2_000_000_000 })).rejects.not.toBeInstanceOf(MediaSourceError);
    expect(stored.size).toBe(objects);
    expect(await assetCount()).toBe(before);
    expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual({ used: png.byteLength, reserved: 0 });
  });
});
