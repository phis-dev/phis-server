import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  deliver: vi.fn(),
  installed: {} as Record<string, { enabled: boolean; manifest: { eventHandlers?: { event: string }[] } }>,
  list: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ products: [], nextCursor: null, input })),
  read: vi.fn(async (...args: unknown[]): Promise<unknown> => ({ args })),
  register: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ product: { id: "p", galleryMedia: [] }, outcome: "created", input })),
  setState: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ id: "p", galleryMedia: [], input })),
  remove: vi.fn(async (input: Record<string, unknown>): Promise<boolean> => Boolean(input)),
  annotate: vi.fn(async (input: Record<string, unknown>): Promise<unknown> => ({ id: "p", galleryMedia: [], input })),
  fill: vi.fn(async (input: { locale: string; msgs: string[] }) => input.msgs.map((msg) => `${input.locale.toUpperCase()} ${msg}`)),
  used: vi.fn(),
  external: vi.fn(async (input: { locale: string; msgs: string[] }) => input.msgs.map((msg) => `${input.locale.toUpperCase()} ${msg}`)),
}));
vi.mock("./installed.ts", () => ({ getPhisAddonInstalledManifest: () => state.installed }));
vi.mock("./event-trigger.ts", () => ({ schedulePhisAddonEventDelivery: (...args: unknown[]) => state.deliver(...args) }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/config", () => ({ getPhisConfigSync: () => ({ sites: { overrides: { acme: { sourceLocale: "en" } } } }) }));
vi.mock("@/lib/translations", () => ({
  translateSiteBatchWithCache: (input: never) => state.fill(input),
  translateExternalSiteBatchWithCache: (input: never) => state.external(input),
}));
vi.mock("@/db/translation-usage", () => ({ notePhiTranslationUse: (...args: unknown[]) => state.used(...args) }));
vi.mock("@/lib/media-response", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/media-response")>()),
  resolvePhiMediaDeliveryUrl: (asset: { id: number; deliveryRevision: number }) => `/api/site/media/${asset.id}/content?r=${asset.deliveryRevision}`,
}));
vi.mock("@/db/products.mts", () => ({
  PHIS_PRODUCT_TEXT_FIELDS: ["title", "summary", "description"],
  phisProductTextContext: (id: number, field: string) => `product ${id} ${field}`,
  listProducts: (_pool: unknown, input: Record<string, unknown>) => state.list(input),
  readProduct: (_pool: unknown, ...args: unknown[]) => state.read(...args),
  registerProduct: (_pool: unknown, input: Record<string, unknown>) => state.register(input),
  setProductState: (_pool: unknown, input: Record<string, unknown>) => state.setState(input),
  removeProduct: (_pool: unknown, input: Record<string, unknown>) => state.remove(input),
  annotateProduct: (_pool: unknown, input: Record<string, unknown>) => state.annotate(input),
}));

import { PhisProductText } from "@phis/contracts/products";

import { buildPhisAddonProductsCapability, listPhisProductListeners } from "./products-capability.ts";

const SUPPLIER = "@acme/licenses";

function capability(overrides: Partial<Parameters<typeof buildPhisAddonProductsCapability>[0]> = {}) {
  return buildPhisAddonProductsCapability({ addonId: SUPPLIER, siteId: 7, siteSourceLocale: "en", unauthenticated: false, ...overrides });
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

  it("refuses an unverified hook every write", async () => {
    const hook = capability({ unauthenticated: true });
    await expect(hook.register({ key: "pro", type: "a", title: "t", summary: "" })).rejects.toThrow(/unverified hook/);
    await expect(hook.setState({ key: "pro", state: "active" })).rejects.toThrow(/unverified hook/);
    await expect(hook.remove({ key: "pro" })).rejects.toThrow(/unverified hook/);
    await expect(hook.annotate({ id: "@acme/licenses:pro", data: {} })).rejects.toThrow(/unverified hook/);
    for (const call of [state.register, state.setState, state.remove, state.annotate]) expect(call).not.toHaveBeenCalled();
    expect(state.deliver).not.toHaveBeenCalled();
  });

  describe("an unverified hook reading the catalogue", () => {
    const hook = () => capability({ unauthenticated: true });
    const stored = (stateName: string) => ({ id: "p", state: stateName, imageAssetId: null, imageMedia: null, iconAssetId: null, iconMedia: null, galleryMedia: [], pendingTerms: { sale: "own" }, attributes: { "@a/b": { mark: 1 } } });

    it("gets an active product without its pending terms, with its attributes, and nothing else", async () => {
      state.read.mockResolvedValueOnce(stored("active"));
      expect(await hook().get({ id: "@acme/licenses:pro" })).toMatchObject({ id: "p", state: "active", pendingTerms: null, attributes: { "@a/b": { mark: 1 } } });
      for (const other of ["draft", "withdrawn", "locked"]) {
        state.read.mockResolvedValueOnce(stored(other));
        expect(await hook().get({ id: "@acme/licenses:pro" }), other).toBeNull();
      }
      state.read.mockResolvedValueOnce(null);
      expect(await hook().get({ id: "@acme/licenses:pro" })).toBeNull();
    });

    it("lists active products only, whatever states, ids or released ask for", async () => {
      state.list.mockResolvedValueOnce({ products: [stored("active")], nextCursor: null });
      const page = await hook().list({ states: ["draft", "locked"], ids: ["@acme/licenses:a"], released: false, limit: 7 });
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ states: ["active"], ids: ["@acme/licenses:a"], released: undefined, limit: 7 }));
      expect(page.products[0]).toMatchObject({ state: "active", pendingTerms: null });
      await hook().list();
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ states: ["active"] }));
      // The limits of the contract hold for it as well.
      await expect(hook().list({ limit: 201 })).rejects.toThrow(/limit/);
    });

    it("sees a verified caller's pending terms in no case of its own", async () => {
      state.list.mockResolvedValueOnce({ products: [stored("withdrawn")], nextCursor: null });
      expect((await capability().list({ states: ["withdrawn"] })).products[0]).toMatchObject({ state: "withdrawn", pendingTerms: { sale: "own" } });
      state.read.mockResolvedValueOnce(stored("draft"));
      expect(await capability().get({ id: "@acme/licenses:pro" })).toMatchObject({ state: "draft", pendingTerms: { sale: "own" } });
    });
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

    it("builds the picture's and the icon's addresses, delivered and for a list, from the asset's current revision and never stores them", async () => {
      state.read.mockResolvedValueOnce({
        id: "p",
        imageAssetId: 12,
        imageMedia: { id: 12, deliveryRevision: 3, variantVersion: 2, contentType: "image/png" },
        iconAssetId: 14,
        iconMedia: { id: 14, deliveryRevision: 1, variantVersion: null, contentType: "image/svg+xml" },
        galleryMedia: [
          { id: 21, deliveryRevision: 2, variantVersion: 1, contentType: "image/webp" },
          { id: 20, deliveryRevision: 1, variantVersion: null, contentType: "application/pdf" },
        ],
      });
      expect(await capability().get({ id: "@acme/licenses:pro" })).toEqual({
        id: "p",
        // No language of its own: the Site's, and nothing read in another.
        sourceLocale: "en",
        translated: 0,
        imageAssetId: 12,
        imagePath: "/api/site/media/12/content?r=3",
        imageListPath: "/api/site/media/12/variants/10?r=3&v=2",
        iconAssetId: 14,
        iconPath: "/api/site/media/14/content?r=1",
        iconListPath: "/api/site/media/14/variants/10?r=1&v=0",
        // The gallery in its order, each picture's public address and its list variant, built as the picture's.
        gallery: [
          { assetId: 21, path: "/api/site/media/21/content?r=2", listPath: "/api/site/media/21/variants/10?r=2&v=1" },
          { assetId: 20, path: "/api/site/media/20/content?r=1", listPath: null },
        ],
      });
      // A picture that is no image is delivered, and has no variant for a list.
      state.read.mockResolvedValueOnce({
        id: "p", imageAssetId: 12, imageMedia: { id: 12, deliveryRevision: 1, variantVersion: null, contentType: "application/pdf" }, iconAssetId: null, iconMedia: null, galleryMedia: [],
      });
      expect(await capability().get({ id: "@acme/licenses:pro" })).toMatchObject({
        imagePath: "/api/site/media/12/content?r=1", imageListPath: null, iconPath: null, iconListPath: null,
      });
      state.read.mockResolvedValueOnce({ id: "p", imageAssetId: null, imageMedia: null, iconAssetId: null, iconMedia: null, galleryMedia: [] });
      expect(await capability().get({ id: "@acme/licenses:pro" })).toMatchObject({ imagePath: null, iconPath: null, imageListPath: null, iconListPath: null, gallery: [] });
      state.read.mockResolvedValueOnce(null);
      expect(await capability().get({ id: "@acme/licenses:pro" })).toBeNull();
    });
  });

  describe("a read in a language", () => {
    const translatable = (texts: Record<string, { msgId: number; translation: string | null }>, sourceLocale: string | null = null) => ({
      id: "p", rowId: 12, state: "active", title: "Pro", summary: "Fast", description: "## Features", imageMedia: null, iconMedia: null, galleryMedia: [],
      textMessages: texts, sourceLocale,
    });

    it("answers what is held, asks the provider for a title or a summary that has none, and leaves the description to a person", async () => {
      state.list.mockResolvedValueOnce({
        products: [translatable({
          title: { msgId: 1, translation: "Profi" },
          summary: { msgId: 2, translation: null },
          description: { msgId: 3, translation: null },
        })],
        nextCursor: null,
      });
      const page = await capability({ unauthenticated: true }).list({ locale: "de" });
      expect(state.list).toHaveBeenLastCalledWith(expect.objectContaining({ locale: "de" }));
      expect(page.products[0]).toMatchObject({
        title: "Profi", summary: "DE Fast", description: "## Features", sourceLocale: "en",
        // Title and summary answer translations; the description is the source a renderer translates.
        translated: PhisProductText.Title | PhisProductText.Summary,
      });
      // The provider is told the field, never the product; the title was held and is not asked for again.
      // Through the TR route's Site path, the message kept under the product's context, nothing recorded anew.
      expect(state.fill).toHaveBeenCalledTimes(1);
      expect(state.fill).toHaveBeenCalledWith({
        siteId: 7, locale: "de", sourceLocale: "en", msgs: ["Fast"], ctx: "product summary",
        storedContexts: ["product 12 summary"], format: "text", create: false,
      });
      expect(state.used).toHaveBeenCalledWith("site", [1, 2, 3]);
      // The messages are Core's own bookkeeping and never reach an Add-on.
      expect(page.products[0]).not.toHaveProperty("textMessages");
      expect(page.products[0]).not.toHaveProperty("rowId");
      expect(state.external).not.toHaveBeenCalled();
    });

    it("answers a person's translation of the description", async () => {
      state.read.mockResolvedValueOnce(translatable({ description: { msgId: 3, translation: "## Funktionen" } }));
      // Title and summary have no message here, so the Site path reads them as written.
      const asWritten = async (input: { msgs: string[] }) => [...input.msgs];
      state.fill.mockImplementationOnce(asWritten).mockImplementationOnce(asWritten);
      expect(await capability().get({ id: "@acme/licenses:pro", locale: "de" })).toMatchObject({
        title: "Pro", description: "## Funktionen", translated: PhisProductText.Description,
      });
      expect(state.read).toHaveBeenLastCalledWith(7, "@acme/licenses:pro", "de");
    });

    it("reads the words as written without a locale and in a language none is kept in", async () => {
      for (const locale of [undefined, null, "xx-nowhere"]) {
        state.list.mockResolvedValueOnce({ products: [], nextCursor: null });
        await capability().list({ locale });
        expect(state.list, String(locale)).toHaveBeenLastCalledWith(expect.objectContaining({ locale: null }));
      }
      expect(state.fill).not.toHaveBeenCalled();
      await expect(capability().list({ locale: 7 as never })).rejects.toThrow(/locale/);
    });

    it("reads a product in its own language as written, whichever language that is", async () => {
      state.list.mockResolvedValueOnce({
        products: [translatable({ summary: { msgId: 2, translation: null } }), { ...translatable({}, "fr"), title: "Édition Pro" }],
        nextCursor: null,
      });
      const site = await capability().list({ locale: "en-US" });
      expect(site.products[0]).toMatchObject({ summary: "Fast", translated: 0, sourceLocale: "en" });
      state.list.mockResolvedValueOnce({ products: [{ ...translatable({}, "fr"), title: "Édition Pro" }], nextCursor: null });
      const own = await capability().list({ locale: "fr" });
      expect(own.products[0]).toMatchObject({ title: "Édition Pro", translated: 0, sourceLocale: "fr" });
      expect(state.fill).not.toHaveBeenCalled();
      // The French product read in the Site's English took the external path, rendered into English.
      expect(state.external).toHaveBeenCalledWith(expect.objectContaining({
        locale: "en-US", sourceLocale: "fr", canonicalLocale: "en", ctx: "product title",
        msgs: ["Édition Pro"], storedContexts: ["product 12 title"],
      }));
      expect(state.external).toHaveBeenCalledTimes(2);
    });

    it("has a product written in another language than the Site's translated through the external path, a person's translation winning", async () => {
      const french = { ...translatable({ title: { msgId: 1, translation: "Profi-Ausgabe" }, summary: { msgId: 2, translation: null } }, "fr"), title: "Édition Pro", summary: "Rapide" };
      state.list.mockResolvedValueOnce({ products: [french, translatable({ summary: { msgId: 5, translation: null } })], nextCursor: null });
      const page = await capability().list({ locale: "de" });
      expect(page.products[0]).toMatchObject({
        title: "Profi-Ausgabe", summary: "DE Rapide", description: "## Features", sourceLocale: "fr",
        translated: PhisProductText.Title | PhisProductText.Summary,
      });
      // One call per field and language for the whole read; the title was held and is not asked for.
      expect(state.external).toHaveBeenCalledTimes(1);
      expect(state.external).toHaveBeenCalledWith(expect.objectContaining({
        locale: "de", sourceLocale: "fr", canonicalLocale: "en", ctx: "product summary", format: "text",
        msgs: ["Rapide"], storedContexts: ["product 12 summary"],
      }));
      // The Site's own product still goes the Site path; the French one is never filled as though it were English.
      expect(state.fill).toHaveBeenCalledTimes(2);
      expect(state.fill).toHaveBeenCalledWith(expect.objectContaining({ ctx: "product summary", msgs: ["Fast"], sourceLocale: "en" }));
      expect(page.products[1]).toMatchObject({ summary: "DE Fast", sourceLocale: "en" });
    });

    it("says a text that came back as written is no translation", async () => {
      state.external.mockImplementationOnce(async (input: { msgs: string[] }) => [...input.msgs]);
      state.read.mockResolvedValueOnce({ ...translatable({}, "fr"), summary: "" });
      expect(await capability().get({ id: "@acme/licenses:pro", locale: "de" })).toMatchObject({ title: "Pro", translated: 0 });
    });

    it("translates nothing a public read is not answered", async () => {
      state.read.mockResolvedValueOnce(translatable({ summary: { msgId: 2, translation: null } }));
      state.read.mockResolvedValueOnce({ ...translatable({ summary: { msgId: 2, translation: null } }), state: "draft" });
      expect(await capability({ unauthenticated: true }).get({ id: "@acme/licenses:pro", locale: "de" })).toMatchObject({ summary: "DE Fast" });
      state.fill.mockClear();
      expect(await capability({ unauthenticated: true }).get({ id: "@acme/licenses:pro", locale: "de" })).toBeNull();
      expect(state.fill).not.toHaveBeenCalled();
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

    it("keeps the Site's language as null, also where the supplier names it, and another in the catalogue's spelling", async () => {
      await capability().register({ key: "pro", type: "a", title: "t", summary: "", sourceLocale: "en-US" });
      expect(state.register).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ sourceLocale: null }) }));
      await capability().register({ key: "pro", type: "a", title: "t", summary: "" });
      expect(state.register).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ sourceLocale: null }) }));
      await capability().register({ key: "pro", type: "a", title: "t", summary: "", sourceLocale: "PT-br" });
      expect(state.register).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ sourceLocale: "pt-BR" }) }));
      await expect(capability().register({ key: "pro", type: "a", title: "t", summary: "", sourceLocale: "xx-nowhere" })).rejects.toThrow(/sourceLocale/);
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
