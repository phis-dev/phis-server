import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  installed: {} as Record<string, { enabled: boolean; manifest: { eventHandlers?: { event: string }[] } }>,
  list: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ products: [], nextCursor: null, input })),
  read: vi.fn(async (...args: unknown[]): Promise<unknown> => ({ args })),
  register: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ product: { id: "p" }, outcome: "created", input })),
  setState: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ id: "p", input })),
  remove: vi.fn(async (input: Record<string, unknown>): Promise<boolean> => Boolean(input)),
  annotate: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ id: "p", input })),
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => state.installed }));
vi.mock("./event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: (...args: unknown[]) => state.deliver(...args) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/media-response", () => ({
  resolvePhiMediaDeliveryUrl: (asset: { id: number; deliveryRevision: number }) => `/api/site/media/${asset.id}/content?r=${asset.deliveryRevision}`,
}));
vi.mock("@/db/products.mts", () => ({
  listProducts: (_pool: unknown, input: Record<string, unknown>) => state.list(input),
  readProduct: (_pool: unknown, ...args: unknown[]) => state.read(...args),
  registerProduct: (_pool: unknown, input: Record<string, unknown>) => state.register(input),
  setProductState: (_pool: unknown, input: Record<string, unknown>) => state.setState(input),
  removeProduct: (_pool: unknown, input: Record<string, unknown>) => state.remove(input),
  annotateProduct: (_pool: unknown, input: Record<string, unknown>) => state.annotate(input),
}));

import { buildPhisAddonProductsCapability, listPhisProductListeners } from "./products-capability.ts";

const SUPPLIER = "@acme/licenses";

function capability(overrides: Partial<Parameters<typeof buildPhisAddonProductsCapability>[0]> = {}) {
  return buildPhisAddonProductsCapability({ addonId: SUPPLIER, siteId: 7, unauthenticated: false, ...overrides });
}

describe("products capability", () => {
  beforeEach(() => {
    state.installed = {
      "@acme/licenses": { enabled: true, manifest: { eventHandlers: [{ event: "entitlement.changed" }] } },
      "@acme/shop": { enabled: true, manifest: { eventHandlers: [{ event: "product.changed" }, { event: "entitlement.changed" }] } },
      "@acme/off": { enabled: false, manifest: { eventHandlers: [{ event: "product.changed" }] } },
    };
  });

  it("lists as listeners the enabled Add-ons that declare product.changed", () => {
    expect(listPhisProductListeners()).toEqual(["@acme/shop"]);
  });

  it("refuses an unverified hook on every call, reads included", async () => {
    const hook = capability({ unauthenticated: true });
    await expect(hook.list()).rejects.toThrow(/unverified hook/);
    await expect(hook.get({ id: "@acme/licenses:pro" })).rejects.toThrow(/unverified hook/);
    await expect(hook.register({ key: "pro", type: "a", title: "t", summary: "" })).rejects.toThrow(/unverified hook/);
    await expect(hook.setState({ key: "pro", state: "active" })).rejects.toThrow(/unverified hook/);
    await expect(hook.remove({ key: "pro" })).rejects.toThrow(/unverified hook/);
    await expect(hook.annotate({ id: "@acme/licenses:pro", data: {} })).rejects.toThrow(/unverified hook/);
    for (const call of [state.list, state.read, state.register, state.setState, state.remove, state.annotate]) expect(call).not.toHaveBeenCalled();
  });

  describe("list", () => {
    it("asks for active products only, 50 at a time, unless told otherwise", async () => {
      await capability().list();
      expect(state.list).toHaveBeenCalledWith(expect.objectContaining({ siteId: 7, states: ["active"], limit: 50, cursor: null }));
      await capability().list({ states: ["draft", "locked"], limit: 200, cursor: "c", supplier: "@a/b", released: false });
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ states: ["draft", "locked"], limit: 200, cursor: "c", supplier: "@a/b", released: false }));
    });

    it("refuses a limit over 200, an empty or unknown state list and a wrong type", async () => {
      await expect(capability().list({ limit: 201 })).rejects.toThrow(/limit/);
      await expect(capability().list({ limit: 0 })).rejects.toThrow(/limit/);
      await expect(capability().list({ states: [] })).rejects.toThrow(/states/);
      await expect(capability().list({ states: ["gone" as never] })).rejects.toThrow(/states/);
      await expect(capability().list({ released: "no" as never })).rejects.toThrow(/released/);
      expect(state.list).not.toHaveBeenCalled();
    });
  });

  describe("ids and the picture", () => {
    it("asks for named products in every state unless states says otherwise, at most 200", async () => {
      const ids = ["@acme/licenses:a", "@acme/licenses:b"] as const;
      await capability().list({ ids });
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ ids, states: ["draft", "active", "withdrawn", "locked"] }));
      await capability().list({ ids, states: ["active"] });
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ ids, states: ["active"] }));
      await capability().list();
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ states: ["active"] }));
      const many = Array.from({ length: 201 }, (_, index) => `@acme/licenses:p${index}`);
      await expect(capability().list({ ids: many as never })).rejects.toThrow(/at most 200/);
      await expect(capability().list({ ids: ["nonsense"] as never })).rejects.toThrow(/ids/);
      expect(state.list).toHaveBeenCalledTimes(3);
      await capability().list({ ids: many.slice(0, 200) as never });
    });

    it("builds the picture's address from the asset's current revision and never stores it", async () => {
      state.read.mockResolvedValueOnce({ id: "p", imageAssetId: 12, imageRevision: 3 });
      expect(await capability().get({ id: "@acme/licenses:pro" })).toEqual({ id: "p", imageAssetId: 12, imagePath: "/api/site/media/12/content?r=3" });
      state.read.mockResolvedValueOnce({ id: "p", imageAssetId: null, imageRevision: null });
      expect(await capability().get({ id: "@acme/licenses:pro" })).toMatchObject({ imagePath: null });
      state.read.mockResolvedValueOnce(null);
      expect(await capability().get({ id: "@acme/licenses:pro" })).toBeNull();
    });
  });

  describe("register", () => {
    it("writes as the calling Add-on and asks for delivery", async () => {
      await capability().register({ key: "pro", type: "licence", title: "Pro", summary: "S" });
      expect(state.register).toHaveBeenCalledWith(expect.objectContaining({
        siteId: 7, supplier: SUPPLIER, listeners: ["@acme/shop"],
        draft: expect.objectContaining({ key: "pro", sale: "own", parts: [], publisher: null }),
      }));
      expect(state.deliver).toHaveBeenCalledWith(7);
    });

    it("refuses a draft that breaks a rule before it reaches the database", async () => {
      await expect(capability().register({ key: "Pro", type: "a", title: "t", summary: "" })).rejects.toThrow(/key/);
      await expect(capability().register({ key: "pro", type: "a", title: "t", summary: "", sale: "referral" })).rejects.toThrow(/referralUrl/);
      await expect(capability().register({ key: "pro", type: "a", title: "t", summary: "", parts: ["@acme/licenses:pro"] })).rejects.toThrow(/itself/);
      expect(state.register).not.toHaveBeenCalled();
    });
  });

  describe("setState, remove", () => {
    it("moves only the caller's own product and only between the three states", async () => {
      await capability().setState({ key: "pro", state: "withdrawn" });
      expect(state.setState).toHaveBeenCalledWith(expect.objectContaining({ siteId: 7, supplier: SUPPLIER, key: "pro", state: "withdrawn" }));
      await expect(capability().setState({ key: "pro", state: "locked" as never })).rejects.toThrow(/operator/);
      await expect(capability().setState({ key: "Pro", state: "active" })).rejects.toThrow(/key/);
    });

    it("removes as the caller, and does not ask for delivery", async () => {
      expect(await capability().remove({ key: "pro" })).toBe(true);
      expect(state.remove).toHaveBeenCalledWith({ siteId: 7, supplier: SUPPLIER, key: "pro" });
      expect(state.deliver).not.toHaveBeenCalled();
    });
  });

  describe("annotate", () => {
    it("writes the caller's own entry, whole", async () => {
      await capability({ addonId: "@acme/shop" }).annotate({ id: "@acme/licenses:pro", data: { rating: 4 } });
      expect(state.annotate).toHaveBeenCalledWith(expect.objectContaining({ siteId: 7, addonId: "@acme/shop", productId: "@acme/licenses:pro", data: { rating: 4 } }));
      await capability().annotate({ id: "@acme/licenses:pro", data: null });
      expect(state.annotate).toHaveBeenLastCalledWith(expect.objectContaining({ data: null }));
    });

    it("refuses what is not an object, is not JSON, or is larger than 8 KiB", async () => {
      await expect(capability().annotate({ id: "@acme/licenses:pro", data: [] as never })).rejects.toThrow(/object/);
      await expect(capability().annotate({ id: "@acme/licenses:pro", data: "x" as never })).rejects.toThrow(/object/);
      const circle: Record<string, unknown> = {};
      circle.self = circle;
      await expect(capability().annotate({ id: "@acme/licenses:pro", data: circle })).rejects.toThrow(/JSON/);
      await expect(capability().annotate({ id: "@acme/licenses:pro", data: { text: "x".repeat(8 * 1024) } })).rejects.toThrow(/8192 bytes/);
      await expect(capability().annotate({ id: "nonsense" as never, data: {} })).rejects.toThrow(/product id/);
      expect(state.annotate).not.toHaveBeenCalled();
      await capability().annotate({ id: "@acme/licenses:pro", data: { text: "x".repeat(8 * 1024 - 20) } });
      expect(state.annotate).toHaveBeenCalledTimes(1);
    });
  });
});
