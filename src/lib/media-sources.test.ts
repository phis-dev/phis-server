import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  folder: vi.fn(),
  locked: vi.fn(),
  existing: vi.fn(),
  createAsset: vi.fn(),
  reserve: vi.fn(),
  commit: vi.fn(),
  config: vi.fn(),
  profile: vi.fn(),
  inspect: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  lock: vi.fn(),
}));

vi.mock("@/lib/log", () => ({ logRuntimeEvent: mocks.log, normalizeLogThrowable: (e: unknown) => String(e) }));
vi.mock("@/db/media", () => ({
  createMediaAsset: mocks.createAsset,
  getMediaAssetBySiteAndChecksum: mocks.existing,
  getMediaFolderBySiteAndId: mocks.folder,
  hasLockedMediaFolder: mocks.locked,
  withMediaSourceImportLock: async (_input: unknown, body: (db: unknown) => unknown) => mocks.lock(body),
}));
vi.mock("@/db/media-spaces", () => ({
  ensureSiteMediaConfig: mocks.config,
  ensureSiteMediaSpace: async () => ({ space: { id: 7, kind: 1, defaultStorageProfileId: 3 } }),
  getMediaStorageProfile: mocks.profile,
  isMediaStorageProfileWritable: () => true,
  isPhiMediaObjectSizeAllowed: (size: number, config: { maxObjectBytes: number }) => size <= config.maxObjectBytes,
  PhiMediaLifecycleStatus: { Ready: 1 },
  reserveMediaSpaceQuota: mocks.reserve,
}));
vi.mock("@/db/site-module-media", () => ({ commitMediaSpaceBytes: mocks.commit }));
vi.mock("@/lib/addons/services", () => ({ PhiServiceProviderUnavailableError: class extends Error {} }));
vi.mock("@/lib/media-content-check", () => ({ inspectPhiMediaObject: mocks.inspect }));
vi.mock("@/lib/media-storage", () => ({
  createPhisMediaStorageServiceForProfile: async () => ({
    createStorageKey: () => "k/1",
    putObject: mocks.put,
    deleteObject: mocks.del,
  }),
}));

import {
  importMediaSourceItem,
  listMediaSourcePage,
  listMediaSources,
  MediaSourceError,
  setMediaSourceTargetSourceForTests,
} from "./media-sources";

const site = { id: 1, key: "acme" };
const probeOk = { usable: true, sources: [{ key: "stock", label: "Stock" }], findings: [] };
const item = {
  id: "a1", kind: "image", title: "A", thumbnailUrl: "https://cdn.example/a.jpg", width: 10, height: 5, credit: null,
};

function adapter(over: Record<string, unknown> = {}) {
  return {
    probe: vi.fn(async (_input?: unknown) => probeOk),
    list: vi.fn(async (_input?: unknown): Promise<unknown> => ({ items: [item], nextCursor: null })),
    take: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]), contentType: "image/png", fileName: " a.png ", title: " Title ",
      altText: "alt", credit: "Photo: X",
    })),
    ...over,
  };
}
function offer(...adapters: Array<[string, ReturnType<typeof adapter>]>) {
  setMediaSourceTargetSourceForTests(async () =>
    adapters.map(([providerKey, a]) => ({ providerKey, providerId: `@x/${providerKey}`, adapter: a as never })));
}
async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaSourceError) return `${error.code}:${error.status}`;
    throw error;
  }
  return "no error";
}
const page = (over: Record<string, unknown> = {}) =>
  listMediaSourcePage({ site, source: "p#stock", query: null, kinds: [], cursor: null, limit: 10, locale: "en", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  setMediaSourceTargetSourceForTests(null);
  mocks.folder.mockResolvedValue({ id: 4 });
  mocks.locked.mockResolvedValue(false);
  mocks.existing.mockResolvedValue(null);
  mocks.config.mockResolvedValue({ maxObjectBytes: 1000 });
  mocks.profile.mockResolvedValue({ id: 3, providerId: "x" });
  mocks.inspect.mockResolvedValue({ ok: true, contentType: "image/png", width: 1, height: 1, blurDataUrl: null });
  mocks.reserve.mockResolvedValue(true);
  mocks.put.mockResolvedValue({ storageKey: "k/1", byteSize: 3 });
  mocks.createAsset.mockImplementation(async (input: Record<string, unknown>) => ({ id: 99, ...input }));
  mocks.del.mockResolvedValue(undefined);
  mocks.lock.mockImplementation((body: (db: unknown) => unknown) => body({}));
});

describe("listing sources", () => {
  it("offers each usable implementation's sources as <providerKey>#<key>", async () => {
    offer(["p", adapter()]);
    expect(await listMediaSources(site)).toEqual([{ source: "p#stock", label: "Stock" }]);
  });

  it("leaves out an implementation that is unusable, throws, or answers a malformed probe", async () => {
    offer(
      ["ok", adapter()],
      ["off", adapter({ probe: async () => ({ ...probeOk, usable: false, findings: ["no key"] }) })],
      ["boom", adapter({ probe: async () => { throw new Error("x"); } })],
      ["bad", adapter({ probe: async () => ({ usable: true, sources: [{ key: 1 }], findings: [] }) })],
    );
    expect(await listMediaSources(site)).toEqual([{ source: "ok#stock", label: "Stock" }]);
    expect(mocks.log.mock.calls.filter(([level]) => level === "warn")).toHaveLength(3);
  });
});

describe("a page of a source", () => {
  it("asks with the checked input and strips what the contract does not name", async () => {
    const a = adapter({ list: vi.fn(async () => ({ items: [{ ...item, extra: 1 }], nextCursor: "n", more: 1 })) });
    offer(["p", a]);
    const answer = await page({ query: `  ${"q".repeat(300)} `, kinds: ["image", "image", "bogus"], limit: 999, cursor: "c" });
    expect(answer).toEqual({ items: [item], nextCursor: "n" });
    const call = a.list.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({ source: "stock", kinds: ["image"], cursor: "c", limit: 60, locale: "en" });
    expect((call.query as string).length).toBe(200);
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers 'failed' for each answer out of contract", async () => {
    const bad: Array<[string, unknown]> = [
      ["too many items", { items: [item, { ...item, id: "a2" }], nextCursor: null }],
      ["empty id", { items: [{ ...item, id: "" }], nextCursor: null }],
      ["long id", { items: [{ ...item, id: "i".repeat(257) }], nextCursor: null }],
      ["unknown kind", { items: [{ ...item, kind: "gif" }], nextCursor: null }],
      ["title not a string", { items: [{ ...item, title: 1 }], nextCursor: null }],
      ["long title", { items: [{ ...item, title: "t".repeat(513) }], nextCursor: null }],
      ["http thumbnail", { items: [{ ...item, thumbnailUrl: "http://cdn.example/a.jpg" }], nextCursor: null }],
      ["relative thumbnail", { items: [{ ...item, thumbnailUrl: "/a.jpg" }], nextCursor: null }],
      ["credentials", { items: [{ ...item, thumbnailUrl: "https://u:p@cdn.example/a.jpg" }], nextCursor: null }],
      ["zero width", { items: [{ ...item, width: 0 }], nextCursor: null }],
      ["fractional height", { items: [{ ...item, height: 1.5 }], nextCursor: null }],
      ["long credit", { items: [{ ...item, credit: "c".repeat(513) }], nextCursor: null }],
      ["empty cursor", { items: [], nextCursor: "" }],
      ["long cursor", { items: [], nextCursor: "c".repeat(513) }],
      ["not a page", null],
    ];
    for (const [, answer] of bad) {
      offer(["p", adapter({ list: async () => answer })]);
      expect(await codeOf(page({ limit: 1 }))).toBe("media_source_failed:502");
    }
  });

  it("refuses an item of a kind that was not asked for", async () => {
    offer(["p", adapter({ list: async () => ({ items: [{ ...item, kind: "video" }], nextCursor: null }) })]);
    expect(await codeOf(page({ kinds: ["image"] }))).toBe("media_source_failed:502");
    expect(await codeOf(page({ kinds: [] }))).toBe("no error");
  });

  it("maps a throw to 'failed', an unknown address to 404 and an unusable source to 409", async () => {
    offer(["p", adapter({ list: async () => { throw new Error("x"); } })]);
    expect(await codeOf(page())).toBe("media_source_failed:502");
    expect(await codeOf(page({ source: "nohash" }))).toBe("media_source_not_found:404");
    expect(await codeOf(page({ source: "other#stock" }))).toBe("media_source_not_found:404");
    expect(await codeOf(page({ source: "p#nope" }))).toBe("media_source_not_found:404");
    offer(["p", adapter({ probe: async () => ({ ...probeOk, usable: false }) })]);
    expect(await codeOf(page())).toBe("media_source_unusable:409");
  });
});

describe("importing an item", () => {
  const run = (over: Record<string, unknown> = {}) =>
    importMediaSourceItem({ site, source: "p#stock", itemId: "a1", folderId: null, actorUserId: 5, ...over });

  it("creates the Asset in the Site Space with the file's title and the record of where it came from", async () => {
    offer(["p", adapter()]);
    const asset = await run({ folderId: 4 });
    expect(asset.id).toBe(99);
    expect(mocks.createAsset).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1, spaceId: 7, folderId: 4, createdByUserId: 5, originalName: "a.png", title: "Title", altText: "alt",
      checksumAlgorithm: "sha256",
      meta: { source: "media-source", providerKey: "p", sourceKey: "stock", itemId: "a1", credit: "Photo: X" },
    }), expect.anything());
    expect(mocks.commit).toHaveBeenCalledWith(expect.anything(), { spaceId: 7, bytes: 3 });
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("answers the Asset that already holds the same bytes and writes nothing", async () => {
    offer(["p", adapter()]);
    mocks.existing.mockResolvedValue({ id: 12, lifecycleStatus: 1 });
    expect((await run()).id).toBe(12);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.createAsset).not.toHaveBeenCalled();
  });

  it("refuses a Folder that is missing or locked before anything is fetched", async () => {
    const a = adapter();
    offer(["p", a]);
    mocks.folder.mockResolvedValue(null);
    expect(await codeOf(run({ folderId: 4 }))).toBe("folder_not_found:404");
    mocks.folder.mockResolvedValue({ id: 4 });
    mocks.locked.mockResolvedValue(true);
    expect(await codeOf(run({ folderId: 4 }))).toBe("folder_locked:409");
    expect(a.take).not.toHaveBeenCalled();
  });

  it("answers 'failed' for a file out of contract", async () => {
    const good = { bytes: new Uint8Array([1]), contentType: "image/png", fileName: "a.png", title: "T" };
    const bad: unknown[] = [
      { ...good, bytes: new Uint8Array() },
      { ...good, bytes: new Uint8Array(32 * 1024 * 1024 + 1) },
      { ...good, bytes: [1, 2] },
      { ...good, contentType: " " },
      { ...good, contentType: 3 },
      { ...good, fileName: "" },
      { ...good, fileName: 3 },
      { ...good, title: undefined },
      { ...good, title: "  " },
      { ...good, altText: 5 },
      { ...good, credit: "c".repeat(513) },
      null,
    ];
    for (const answer of bad) {
      offer(["p", adapter({ take: async () => answer })]);
      mocks.config.mockResolvedValue({ maxObjectBytes: 100 * 1024 * 1024 });
      expect(await codeOf(run())).toBe("media_source_failed:502");
    }
    offer(["p", adapter({ take: async () => { throw new Error("x"); } })]);
    expect(await codeOf(run())).toBe("media_source_failed:502");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("keeps the upload's refusals: too large for the Site, content, quota", async () => {
    offer(["p", adapter()]);
    mocks.config.mockResolvedValue({ maxObjectBytes: 2 });
    expect(await codeOf(run())).toBe("media_asset_too_large:413");
    mocks.config.mockResolvedValue({ maxObjectBytes: 1000 });
    mocks.inspect.mockResolvedValue({ ok: false, code: "content_type_not_allowed", message: "no" });
    expect(await codeOf(run())).toBe("content_type_not_allowed:415");
    mocks.inspect.mockResolvedValue({ ok: true, contentType: "image/png", width: 1, height: 1, blurDataUrl: null });
    mocks.reserve.mockResolvedValue(false);
    expect(await codeOf(run())).toBe("media_quota_exceeded:413");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("removes the object again when something after the write fails", async () => {
    offer(["p", adapter()]);
    mocks.createAsset.mockRejectedValue(new Error("db"));
    await expect(run()).rejects.toThrow("db");
    expect(mocks.del).toHaveBeenCalledWith("k/1");
  });
});
