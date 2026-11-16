import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/*
 * The Module media import against the development database: idempotency, repair, the hand binding, the
 * changed-file rule, folder-name reuse, quota, the Site lock, and the Site's read of the mapping. The
 * Storage Service is an in-memory one, so no file is written anywhere; everything else -- the Space, the
 * Asset rows, the quota counters, the rows of the two Module media tables -- is the real thing.
 */

const stored = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("@/lib/api-v1-guard", () => ({ guardApiV1: () => null, getApiV1TokenMode: () => "internal" }));
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
  createPhiTestGroupSpace,
  createPhiTestSite,
  dropPhiTestSites,
  readPhiTestSpaceBytes,
  requirePhiTestDatabase,
  type PhiTestSite,
} from "../../test/pg/harness";
import { SITE_FLAG_ACTIVE } from "@/lib/site-flags";
import { PhiMediaFolderFlags, PhisSiteModuleMediaFlag } from "@/lib/constants/media";
import {
  bindModuleMedia,
  importModuleMediaFile,
  importModuleMediaFolder,
  type PhisModuleMediaFileInput,
} from "@/lib/module-media-import";
import { GET as readSiteMapping } from "@/app/api/v1/site/module-media/route";
import { GET as readOperatorMapping } from "@/app/api/v1/module-media/route";
import { POST as bindRoute } from "@/app/api/v1/module-media/bind/route";

const PKG = "@pgtest/pictures";

describe("Module media import against PostgreSQL", () => {
  let site: PhiTestSite;
  let other: PhiTestSite;
  let png: Buffer;
  let png2: Buffer;

  const ref = (s: PhiTestSite) => ({ id: s.id, key: s.key });
  async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const pool = await requirePhiTestDatabase();
    return (await pool.query(text, params)).rows as T[];
  }
  function file(key: string, body: Buffer, extra: Partial<PhisModuleMediaFileInput> = {}): PhisModuleMediaFileInput {
    return { packageName: PKG, key, folderKey: null, alt: `Alt ${key}`, title: null, originalName: `${key}.png`, body, ...extra };
  }
  const assetCount = async (s = site) => Number((await sql<{ n: string }>(`SELECT count(*) n FROM phis.media_assets WHERE site_id = $1`, [s.id]))[0]!.n);

  beforeAll(async () => {
    await dropPhiTestSites();
    site = await createPhiTestSite("modmedia");
    other = await createPhiTestSite("modmedia-other");
    await sql(`UPDATE phis.sites SET flags = flags | $2 WHERE id = ANY($1)`, [[site.id, other.id], SITE_FLAG_ACTIVE]);
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#ff0000" } }).png().toBuffer();
    png2 = await sharp({ create: { width: 9, height: 9, channels: 3, background: "#0000ff" } }).png().toBuffer();
  });

  afterAll(async () => {
    await dropPhiTestSites();
    await closePhiTestPool();
  });

  describe("folders", () => {
    it("creates by name under the declared parent, and does nothing the second time", async () => {
      const root = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "root", name: "Acme", parentKey: null });
      expect(root).toMatchObject({ status: "created" });
      const child = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "shots", name: "Screenshots", parentKey: "root" });
      expect(child.status).toBe("created");
      const [row] = await sql<{ parent_id: number; space_id: number }>(`SELECT parent_id, space_id FROM phis.media_folders WHERE id = $1`, [child.folderId]);
      expect(row).toEqual({ parent_id: root.folderId, space_id: site.siteSpaceId });

      expect(await importModuleMediaFolder(ref(site), { packageName: PKG, key: "root", name: "Acme", parentKey: null }))
        .toMatchObject({ status: "unchanged", folderId: root.folderId });
      expect(Number((await sql<{ n: string }>(`SELECT count(*) n FROM phis.media_folders WHERE site_id = $1`, [site.id]))[0]!.n)).toBe(2);
    });

    it("binds to a folder of that name that is already there instead of making a second", async () => {
      const [existing] = await sql<{ id: number }>(
        `INSERT INTO phis.media_folders (site_id, space_id, name) VALUES ($1, $2, 'Handmade') RETURNING id`, [site.id, site.siteSpaceId]);
      const result = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "handmade", name: "handmade", parentKey: null });
      expect(result).toMatchObject({ status: "created", folderId: existing!.id });
      expect(result.detail).toMatch(/already there/);
    });

    it("makes a folder again when it is gone, and refuses a parent that has none", async () => {
      const before = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "shots", name: "Screenshots", parentKey: "root" });
      await sql(`DELETE FROM phis.media_folders WHERE id = $1`, [before.folderId]);
      expect(await sql(`SELECT folder_id FROM phis.site_module_media_folders WHERE site_id = $1 AND key = 'shots'`, [site.id]))
        .toEqual([{ folder_id: null }]);
      const after = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "shots", name: "Screenshots", parentKey: "root" });
      expect(after.status).toBe("repaired");
      expect(after.folderId).not.toBe(before.folderId);

      expect(await importModuleMediaFolder(ref(site), { packageName: PKG, key: "orphan", name: "O", parentKey: "nowhere" }))
        .toMatchObject({ status: "refused", reason: "parent_missing" });
    });
  });

  describe("files", () => {
    it("writes an ordinary Asset with its folder, texts, digest, size, dimensions and provenance, and books the quota", async () => {
      const folder = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "icons", name: "Icons", parentKey: null });
      const usedBefore = (await readPhiTestSpaceBytes(site.siteSpaceId))!.used;
      const result = await importModuleMediaFile(ref(site), file("icon", png, { folderKey: "icons", title: "The icon" }));
      expect(result).toMatchObject({ kind: "file", status: "created" });
      const [asset] = await sql<Record<string, unknown>>(`SELECT * FROM phis.media_assets WHERE id = $1`, [result.assetId]);
      expect(asset).toMatchObject({
        site_id: site.id, space_id: site.siteSpaceId, folder_id: folder.folderId, alt_text: "Alt icon", title: "The icon",
        content_type: "image/png", checksum_algorithm: "sha256", width: 8, height: 6, original_name: "icon.png",
        storage_profile_id: site.storageProfileId,
      });
      expect(asset!.checksum_value).toMatch(/^[0-9a-f]{64}$/);
      expect(asset!.meta).toEqual({ source: "module", package: PKG, key: "icon" });
      expect(stored.has(asset!.storage_key as string)).toBe(true);
      const used = (await readPhiTestSpaceBytes(site.siteSpaceId))!;
      expect(used.used - usedBefore).toBe(png.byteLength);
      expect(used.reserved).toBe(0);
      const [row] = await sql(`SELECT asset_id, source_checksum, flags FROM phis.site_module_media WHERE site_id = $1 AND key = 'icon'`, [site.id]);
      expect(row).toEqual({ asset_id: result.assetId, source_checksum: asset!.checksum_value, flags: 0 });
    });

    it("is idempotent: the same bytes again change nothing", async () => {
      const count = await assetCount();
      const used = (await readPhiTestSpaceBytes(site.siteSpaceId))!.used;
      const again = await importModuleMediaFile(ref(site), file("icon", png, { folderKey: "icons" }));
      expect(again.status).toBe("unchanged");
      expect(await assetCount()).toBe(count);
      expect((await readPhiTestSpaceBytes(site.siteSpaceId))!.used).toBe(used);
    });

    it("repairs a deleted Asset by writing the file again", async () => {
      const first = await importModuleMediaFile(ref(site), file("repair", png));
      await sql(`DELETE FROM phis.media_assets WHERE id = $1`, [first.assetId]);
      expect(await sql(`SELECT asset_id FROM phis.site_module_media WHERE site_id = $1 AND key = 'repair'`, [site.id]))
        .toEqual([{ asset_id: null }]);
      const second = await importModuleMediaFile(ref(site), file("repair", png));
      expect(second.status).toBe("repaired");
      expect(second.assetId).not.toBe(first.assetId);
    });

    it("follows a changed file while the Asset is still what the import wrote: a new Asset, the old one left", async () => {
      const first = await importModuleMediaFile(ref(site), file("follow", png));
      const changed = await importModuleMediaFile(ref(site), file("follow", png2));
      expect(changed).toMatchObject({ status: "replaced", previousAssetId: first.assetId });
      expect(changed.assetId).not.toBe(first.assetId);
      expect(changed.detail).toMatch(/cannot replace an Asset's content under its id/);
      expect(await sql(`SELECT id FROM phis.media_assets WHERE id = $1`, [first.assetId])).toHaveLength(1);
      const [row] = await sql<{ asset_id: number }>(`SELECT asset_id FROM phis.site_module_media WHERE site_id = $1 AND key = 'follow'`, [site.id]);
      expect(row!.asset_id).toBe(changed.assetId);
    });

    it("leaves an Asset somebody changed, though the package file changed", async () => {
      const first = await importModuleMediaFile(ref(site), file("touched", png));
      await sql(`UPDATE phis.media_assets SET checksum_value = repeat('a', 64) WHERE id = $1`, [first.assetId]);
      const count = await assetCount();
      const result = await importModuleMediaFile(ref(site), file("touched", png2));
      expect(result).toMatchObject({ status: "unchanged", assetId: first.assetId });
      expect(result.detail).toMatch(/no longer what the import wrote/);
      expect(await assetCount()).toBe(count);
    });

    it("never touches a row bound by hand, whether its target is there or not", async () => {
      const [mine] = await sql<{ id: number }>(
        `INSERT INTO phis.media_assets (site_id, space_id, storage_profile_id, storage_key, original_name, content_type)
         VALUES ($1, $2, $3, 'pgtest/mine', 'mine.png', 'image/png') RETURNING id`, [site.id, site.siteSpaceId, site.storageProfileId]);
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "bound", asset: mine!.id })).toEqual({ ok: true, action: "bound", kind: "file" });
      const count = await assetCount();
      expect(await importModuleMediaFile(ref(site), file("bound", png))).toMatchObject({ status: "bound-left", assetId: mine!.id });
      await sql(`DELETE FROM phis.media_assets WHERE id = $1`, [mine!.id]);
      expect(await importModuleMediaFile(ref(site), file("bound", png))).toMatchObject({ status: "bound-left" });
      expect(await assetCount()).toBe(count - 1);
      const [row] = await sql(`SELECT asset_id, flags FROM phis.site_module_media WHERE site_id = $1 AND key = 'bound'`, [site.id]);
      expect(row).toEqual({ asset_id: null, flags: PhisSiteModuleMediaFlag.Bound });
    });

    it("refuses with a reason, and books nothing", async () => {
      const used = (await readPhiTestSpaceBytes(site.siteSpaceId))!;
      const count = await assetCount();
      const refusals = await Promise.all([
        importModuleMediaFile(ref(site), file("svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))),
        importModuleMediaFile(ref(site), file("empty", Buffer.alloc(0))),
        importModuleMediaFile(ref(site), file("nofolder", png, { folderKey: "undeclared" })),
      ]);
      expect(refusals.map((item) => item.reason)).toEqual(["unsafe_svg_upload", "empty_file", "folder_missing"]);
      expect(refusals.every((item) => item.status === "refused")).toBe(true);
      expect(await assetCount()).toBe(count);
      expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual(used);
      expect(await sql(`SELECT 1 FROM phis.site_module_media WHERE site_id = $1 AND key IN ('svg', 'empty', 'nofolder')`, [site.id])).toHaveLength(0);
    });

    it("refuses when the Site Space's quota is used up, with the reservation rolled back", async () => {
      const own = await createPhiTestSite("modmedia-quota");
      await sql(`UPDATE phis.media_spaces SET quota_bytes = 10 WHERE id = $1`, [own.siteSpaceId]);
      const result = await importModuleMediaFile(ref(own), file("big", png));
      expect(result).toMatchObject({ status: "refused", reason: "media_quota_exceeded" });
      expect(await readPhiTestSpaceBytes(own.siteSpaceId)).toEqual({ used: 0, reserved: 0 });
    });

    it("refuses a file into a locked folder, a declared one or a hand-bound one, and books nothing", async () => {
      const locked = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "locked", name: "Locked", parentKey: null });
      await sql(`UPDATE phis.media_folders SET flags = flags | $2 WHERE id = $1`, [locked.folderId, PhiMediaFolderFlags.Locked]);
      const [mine] = await sql<{ id: number }>(`INSERT INTO phis.media_folders (site_id, space_id, name, flags) VALUES ($1, $2, 'Mine locked', $3) RETURNING id`, [site.id, site.siteSpaceId, PhiMediaFolderFlags.Locked]);
      await bindModuleMedia(ref(site), { packageName: PKG, key: "hand-locked", folder: mine!.id });
      const used = (await readPhiTestSpaceBytes(site.siteSpaceId))!;
      const count = await assetCount();
      const results = await Promise.all([
        importModuleMediaFile(ref(site), file("in-locked", png, { folderKey: "locked" })),
        importModuleMediaFile(ref(site), file("in-hand-locked", png, { folderKey: "hand-locked" })),
      ]);
      for (const result of results) {
        expect(result).toMatchObject({ status: "refused", reason: "media_folder_locked", detail: "The Media Folder is locked." });
      }
      expect(await assetCount()).toBe(count);
      expect(await readPhiTestSpaceBytes(site.siteSpaceId)).toEqual(used);
    });

    it("refuses a sub-folder under a locked parent", async () => {
      const result = await importModuleMediaFolder(ref(site), { packageName: PKG, key: "under-locked", name: "Under", parentKey: "locked" });
      expect(result).toMatchObject({ status: "refused", reason: "media_folder_locked" });
      expect(await sql(`SELECT 1 FROM phis.site_module_media_folders WHERE site_id = $1 AND key = 'under-locked'`, [site.id])).toHaveLength(0);
    });

    it("writes a name once when two requests race for it", async () => {
      const count = await assetCount();
      const results = await Promise.all([
        importModuleMediaFile(ref(site), file("race", png)),
        importModuleMediaFile(ref(site), file("race", png)),
        importModuleMediaFile(ref(site), file("race", png)),
      ]);
      expect(results.map((item) => item.status).sort()).toEqual(["created", "unchanged", "unchanged"]);
      expect(await assetCount()).toBe(count + 1);
    });
  });

  describe("binding by hand", () => {
    async function assetIn(spaceId: number, s: PhiTestSite, key: string) {
      const [row] = await sql<{ id: number }>(
        `INSERT INTO phis.media_assets (site_id, space_id, storage_profile_id, storage_key, original_name, content_type)
         VALUES ($1, $2, $3, $4, 'x.png', 'image/png') RETURNING id`, [s.id, spaceId, s.storageProfileId, key]);
      return row!.id;
    }

    it("takes only an Asset or Folder of this Site's Site Space", async () => {
      const group = await createPhiTestGroupSpace(site);
      const inGroup = await assetIn(group, site, "pgtest/in-group");
      const foreign = await assetIn(other.siteSpaceId, other, "pgtest/foreign");
      for (const id of [inGroup, foreign, 2_000_000_000]) {
        expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "x", asset: id })).toMatchObject({ ok: false, reason: "target_not_in_site_space" });
      }
      const [foreignFolder] = await sql<{ id: number }>(`INSERT INTO phis.media_folders (site_id, space_id, name) VALUES ($1, $2, 'F') RETURNING id`, [other.id, other.siteSpaceId]);
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "x", folder: foreignFolder!.id })).toMatchObject({ ok: false, reason: "target_not_in_site_space" });
      expect(await sql(`SELECT 1 FROM phis.site_module_media WHERE site_id = $1 AND key = 'x'`, [site.id])).toHaveLength(0);
    });

    it("keeps a key to one kind per package, and binds a folder that the import then leaves alone", async () => {
      const [mine] = await sql<{ id: number }>(`INSERT INTO phis.media_folders (site_id, space_id, name) VALUES ($1, $2, 'Mine') RETURNING id`, [site.id, site.siteSpaceId]);
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "root", asset: 1 })).toMatchObject({ ok: false, reason: "key_is_other_kind" });
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "icon", folder: mine!.id })).toMatchObject({ ok: false, reason: "key_is_other_kind" });
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "hand-folder", folder: mine!.id })).toEqual({ ok: true, action: "bound", kind: "folder" });
      expect(await importModuleMediaFolder(ref(site), { packageName: PKG, key: "hand-folder", name: "Other", parentKey: null }))
        .toMatchObject({ status: "bound-left", folderId: mine!.id });
    });

    it("resets a hand binding so the package's file is written again, and refuses to reset anything else", async () => {
      const mine = await assetIn(site.siteSpaceId, site, "pgtest/reset-mine");
      await bindModuleMedia(ref(site), { packageName: PKG, key: "rebind", asset: mine });
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "rebind", reset: true })).toEqual({ ok: true, action: "reset", kind: "file" });
      const result = await importModuleMediaFile(ref(site), file("rebind", png));
      expect(result.status).toBe("created");
      expect(result.assetId).not.toBe(mine);
      expect(await bindModuleMedia(ref(site), { packageName: PKG, key: "rebind", reset: true })).toMatchObject({ ok: false, reason: "not_bound" });
    });

    it("clears the digest a binding no longer follows", async () => {
      const mine = await assetIn(site.siteSpaceId, site, "pgtest/digest-mine");
      await importModuleMediaFile(ref(site), file("digest", png));
      await bindModuleMedia(ref(site), { packageName: PKG, key: "digest", asset: mine });
      expect(await sql(`SELECT asset_id, source_checksum FROM phis.site_module_media WHERE site_id = $1 AND key = 'digest'`, [site.id]))
        .toEqual([{ asset_id: mine, source_checksum: null }]);
    });

    it("is validated by the route too: exactly one of asset, folder, reset", async () => {
      const post = (body: unknown) => bindRoute(new Request("http://phis.test/api/v1/module-media/bind", {
        method: "POST", headers: { "x-phis-site-key": site.key, "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect((await post({ package: PKG, key: "x" })).status).toBe(400);
      expect((await post({ package: PKG, key: "x", asset: 1, reset: true })).status).toBe(400);
      expect((await post({ package: PKG, key: "X", asset: 1 })).status).toBe(400);
      expect((await post({ package: PKG, key: "x", asset: "1" })).status).toBe(400);
      const refused = await (await post({ package: PKG, key: "x", asset: 2_000_000_000 })).json();
      expect(refused.result).toMatchObject({ ok: false, reason: "target_not_in_site_space" });
    });
  });

  describe("the Site's read of the mapping", () => {
    const read = (s: PhiTestSite, handler = readSiteMapping) =>
      handler(new Request("http://phis.test/api/v1/site/module-media", { headers: { "x-phis-site-key": s.key } }));

    it("answers ids by package and key, only for targets that exist, and only this Site's", async () => {
      const body = await (await read(site)).json() as { assets: Record<string, Record<string, number>>; folders: Record<string, Record<string, number>> };
      const [icon] = await sql<{ asset_id: number }>(`SELECT asset_id FROM phis.site_module_media WHERE site_id = $1 AND key = 'icon'`, [site.id]);
      expect(body.assets[PKG]!.icon).toBe(icon!.asset_id);
      expect(typeof body.folders[PKG]!.root).toBe("number");
      expect(Object.keys(body.assets[PKG]!)).not.toContain("bound"); // its Asset was deleted above
      expect(Object.values(body)).toEqual(expect.arrayContaining([expect.any(Object)]));
      expect(JSON.stringify(body)).not.toMatch(/checksum|storage|alt/);

      const foreign = await (await read(other)).json();
      expect(foreign).toEqual({ assets: {}, folders: {} });
    });

    it("is 404 for an unknown Site and gives the operator view the digests", async () => {
      expect((await read({ ...site, key: "pgtest-nobody" })).status).toBe(404);
      const operator = await (await read(site, readOperatorMapping)).json() as { files: { key: string; sourceChecksum: string | null; bound: boolean }[] };
      expect(operator.files.find((row) => row.key === "icon")?.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(operator.files.find((row) => row.key === "bound")?.bound).toBe(true);
    });
  });
});
