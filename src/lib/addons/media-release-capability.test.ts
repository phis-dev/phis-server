import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  steps: [] as string[],
  lock: vi.fn(),
  references: vi.fn(),
  attachments: vi.fn(),
  discard: vi.fn(),
  drain: vi.fn(),
  prune: vi.fn(),
  clearCache: vi.fn(),
  log: vi.fn(),
}));
const client = { query: vi.fn() };
vi.mock("@/lib/db", () => ({
  withTransaction: async (body: (connection: unknown) => Promise<unknown>) => {
    state.steps.push("begin");
    try {
      const result = await body(client);
      state.steps.push("commit");
      return result;
    } catch (error) {
      state.steps.push("rollback");
      throw error;
    }
  },
}));
vi.mock("@/db/media", () => ({
  lockSiteSpaceMediaAssetForRelease: (...args: unknown[]) => { state.steps.push("lock"); return state.lock(...args); },
  pruneEmptyMediaFolderBranch: (...args: unknown[]) => state.prune(...args),
}));
vi.mock("@/db/media-discard", () => ({
  discardPhiMediaAssets: (...args: unknown[]) => { state.steps.push("discard"); return state.discard(...args); },
}));
vi.mock("@/db/site-config", () => ({ clearSiteConfigCache: (...args: unknown[]) => state.clearCache(...args) }));
vi.mock("@/db/threads", () => ({ countThreadAttachmentsForAsset: (...args: unknown[]) => state.attachments(...args) }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: (...args: unknown[]) => state.log(...args) }));
vi.mock("@/lib/media-asset-delete", () => ({
  drainPhiDiscardedMediaObjects: (...args: unknown[]) => { state.steps.push("drain"); return state.drain(...args); },
}));
vi.mock("@/lib/media-delete-guard", () => ({
  collectMediaAssetDeleteReferences: (...args: unknown[]) => { state.steps.push("count"); return state.references(...args); },
}));

import { buildPhisAddonMediaReleaseCapability } from "./media-release-capability.ts";

const ADDON = "@acme/shop";
const objects = [{ id: "51", storageProfileId: 2, storageKey: "sites/example/cover.png" }];

const capability = (overrides: Partial<Parameters<typeof buildPhisAddonMediaReleaseCapability>[0]> = {}) =>
  buildPhisAddonMediaReleaseCapability({ addonId: ADDON, siteId: 7, siteKey: "example", actorUserId: 3, ...overrides });

const locked = (overrides: Record<string, unknown> = {}) => ({
  asset: { id: 9, siteId: 7, spaceId: 1, folderId: 40, ...overrides },
  folderLocked: false,
});

/** A reference row as the delete guard names it; release says nothing about it. */
const reference = (scope: string) => ({ scope, fieldPath: "x", addon: scope === "addon" ? { addonId: "@acme/other" } : null });

beforeEach(() => {
  state.steps = [];
  for (const mock of [state.lock, state.references, state.attachments, state.discard, state.drain, state.prune, state.clearCache, state.log]) mock.mockReset();
  state.lock.mockResolvedValue(locked());
  state.references.mockResolvedValue([]);
  state.attachments.mockResolvedValue(0);
  state.discard.mockResolvedValue({ assetIds: [9], objects });
  state.drain.mockResolvedValue(1);
});

describe("media-release capability", () => {
  it("deletes an Asset nothing references, inside one transaction holding its lock, and the object after the commit", async () => {
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "deleted" }]);
    expect(state.steps).toEqual(["begin", "lock", "count", "discard", "commit", "drain"]);
    expect(state.lock).toHaveBeenCalledWith(client, 7, 9);
    // The count runs on the transaction's own client, so it holds until the delete commits.
    expect(state.references).toHaveBeenCalledWith(7, expect.objectContaining({ id: 9, siteId: 7 }), client);
    expect(state.discard).toHaveBeenCalledWith(client, { siteId: 7, assetIds: [9] });
    expect(state.drain).toHaveBeenCalledWith({ siteId: 7, siteKey: "example", objects });
    expect(state.prune).toHaveBeenCalledWith(7, 1, 40);
    expect(state.clearCache).toHaveBeenCalledWith(7);
  });

  it.each(["page", "navigation", "content", "area", "theme", "product", "addon"])(
    "keeps an Asset a reference of scope %s still holds, and says nothing about it",
    async (scope) => {
      state.references.mockResolvedValue([reference(scope)]);
      const answer = await capability().release({ ids: [9] });
      expect(answer).toEqual([{ id: 9, released: "kept" }]);
      expect(state.discard).not.toHaveBeenCalled();
      expect(state.drain).not.toHaveBeenCalled();
      expect(state.clearCache).not.toHaveBeenCalled();
    },
  );

  it("keeps an Asset the calling Add-on itself still names in another row: it clears its own first", async () => {
    state.references.mockResolvedValue([{ scope: "addon", fieldPath: "gallery.asset_id", addon: { addonId: ADDON, table: "gallery", column: "asset_id", rowId: "4,2" } }]);
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "kept" }]);
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("keeps an Asset attached to a message", async () => {
    state.attachments.mockResolvedValue(1);
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "kept" }]);
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("never deletes an Asset in a locked Folder, and does not even count", async () => {
    state.lock.mockResolvedValue({ ...locked(), folderLocked: true });
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "kept" }]);
    expect(state.references).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("answers not-found for what the lock does not find: another Site, another Space, no row", async () => {
    state.lock.mockResolvedValue(null);
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "not-found" }]);
    expect(state.references).not.toHaveBeenCalled();
    expect(state.discard).not.toHaveBeenCalled();
  });

  it("keeps an Asset whose delete a foreign key still refuses, rolling back", async () => {
    state.discard.mockRejectedValue(Object.assign(new Error("violates foreign key constraint"), { code: "23503" }));
    await expect(capability().release({ ids: [9] })).resolves.toEqual([{ id: 9, released: "kept" }]);
    expect(state.steps).toContain("rollback");
    expect(state.drain).not.toHaveBeenCalled();
  });

  it("lets any other failure through", async () => {
    state.discard.mockRejectedValue(new Error("connection lost"));
    await expect(capability().release({ ids: [9] })).rejects.toThrow("connection lost");
  });

  it("answers each id once, in order, each in a transaction of its own, and writes down every outcome", async () => {
    state.lock.mockImplementation(async (_client: unknown, _site: number, id: number) => (id === 5 ? null : locked({ id, folderId: null })));
    state.references.mockImplementation(async (_site: number, asset: { id: number }) => (asset.id === 4 ? [reference("page")] : []));
    state.discard.mockImplementation(async (_client: unknown, input: { assetIds: number[] }) => ({ assetIds: input.assetIds, objects }));
    const answer = await capability().release({ ids: [9, 4, 9, 5] });
    expect(answer).toEqual([{ id: 9, released: "deleted" }, { id: 4, released: "kept" }, { id: 5, released: "not-found" }]);
    expect(state.steps.filter((step) => step === "begin")).toHaveLength(3);
    expect(state.prune).not.toHaveBeenCalled();
    expect(state.clearCache).toHaveBeenCalledTimes(1);
    expect(state.log.mock.calls.map(([, event, entry]) => [event, entry.pluginKey, entry.targetId, entry.meta.outcome, entry.userId])).toEqual([
      ["addon.media.released", ADDON, 9, "deleted", 3],
      ["addon.media.released", ADDON, 4, "kept", 3],
      ["addon.media.released", ADDON, 5, "not-found", 3],
    ]);
  });

  it("refuses an unverified hook before touching anything", async () => {
    await expect(capability({ unauthenticated: true }).release({ ids: [9] })).rejects.toThrow(/unverified hook/u);
    expect(state.steps).toEqual([]);
  });

  it("refuses ids that are not a short list of positive integers", async () => {
    for (const ids of [[0], [2.5], ["9"], Array.from({ length: 51 }, (_, index) => index + 1)]) {
      await expect(capability().release({ ids: ids as number[] })).rejects.toThrow(/at most 50 positive integer/u);
    }
    expect(state.steps).toEqual([]);
  });
});
