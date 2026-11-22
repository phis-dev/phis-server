import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { getRouteMatcher } from "next/dist/shared/lib/router/utils/route-matcher";
import { getRouteRegex } from "next/dist/shared/lib/router/utils/route-regex";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  release: vi.fn(),
  move: vi.fn(),
  schedule: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/guards/site-admin-api", () => ({ requireSiteAccountingApiContext: mocks.guard }));
// The rule error stays real: the route decides the status from `instanceof`.
vi.mock("@/db/products.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/products.mts")>()),
  listProductDirectory: mocks.list,
  readProduct: mocks.read,
  releaseProduct: mocks.release,
  moveProductsAsOperator: mocks.move,
}));
vi.mock("@/lib/addons/products-capability", () => ({
  listPhisProductListeners: () => ["@acme/seller"],
  // The addresses are built from the revision, as Core builds them; what matters here is that they arrive.
  presentPhisProduct: ({ imageRevision, iconRevision, ...product }: Record<string, unknown>) => ({
    ...product,
    imagePath: imageRevision === null ? null : `/media/${String(product.imageAssetId)}`,
    iconPath: iconRevision === null ? null : `/media/${String(product.iconAssetId)}`,
  }),
}));
vi.mock("@/lib/addons/event-trigger", () => ({ schedulePhisAddonEventDelivery: mocks.schedule }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/log", () => ({ logRuntimeEvent: mocks.log }));

import { PhisProductRuleError } from "@/db/products.mts";
import { GET } from "./route";
import { POST as RELEASE } from "./[id]/release/route";
import { POST as LOCK } from "./[id]/lock/route";
import { POST as UNLOCK } from "./[id]/unlock/route";

const ID = "@acme/licences:pro.yearly";

const stored = (rest: Record<string, unknown> = {}) => ({
  id: ID,
  supplier: "@acme/licences",
  supplied: true,
  publisher: "studio-7",
  type: "licence",
  title: "Pro",
  summary: "A year of Pro.",
  imageAssetId: 12,
  imageRevision: 3,
  iconAssetId: null,
  iconRevision: null,
  counted: false,
  sale: "payout",
  referralUrl: null,
  free: false,
  accountRequired: true,
  parts: [],
  state: "active",
  released: true,
  pendingTerms: { sale: "payout", referralUrl: null, free: true, accountRequired: true, parts: [] },
  attributes: { "@acme/seller": { mark: "new" } },
  version: 4,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  ...rest,
});

const list = (query = "") => GET(new NextRequest(`https://site.test/api/site/products${query}`));
const command = (handler: typeof LOCK, id = ID, name = "lock") =>
  handler(
    new NextRequest(`https://site.test/api/site/products/${encodeURIComponent(id)}/${name}`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  mocks.guard.mockResolvedValue({
    error: null,
    context: { site: { id: 31, key: "skeleton" }, session: { userId: 7 } },
  });
  mocks.list.mockResolvedValue({ products: [stored()], total: 1 });
  mocks.read.mockResolvedValue(stored());
});

describe("the product directory", () => {
  it("answers the rows the operator decides by, without the attributes other Add-ons keep", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.rows).toEqual([{
      id: ID,
      supplier: "@acme/licences",
      publisher: "studio-7",
      title: "Pro",
      summary: "A year of Pro.",
      type: "licence",
      state: "active",
      sale: "payout",
      referralUrl: null,
      free: false,
      accountRequired: true,
      counted: false,
      parts: [],
      released: true,
      pendingTerms: { sale: "payout", referralUrl: null, free: true, accountRequired: true, parts: [] },
      imagePath: "/media/12",
      iconPath: null,
      version: 4,
    }]);
  });

  it("reads every state unless asked, and passes the filters and the page on", async () => {
    await list();
    expect(mocks.list).toHaveBeenLastCalledWith({}, {
      siteId: 31,
      states: ["draft", "active", "withdrawn", "locked"],
      supplier: undefined,
      awaitingRelease: undefined,
      search: undefined,
      page: 1,
      pageSize: 25,
    });
    await list(`?supplier=${encodeURIComponent("@acme/licences")}&state=locked,draft&pendingTerms=true&q=%20Pro%20&page=3&pageSize=50`);
    expect(mocks.list).toHaveBeenLastCalledWith({}, {
      siteId: 31,
      states: ["locked", "draft"],
      supplier: "@acme/licences",
      awaitingRelease: true,
      search: "Pro",
      page: 3,
      pageSize: 50,
    });
    await list("?pendingTerms=false");
    expect(mocks.list.mock.lastCall?.[1]).toMatchObject({ awaitingRelease: false });
  });

  it("refuses a malformed filter rather than listing everything", async () => {
    for (const query of ["?supplier=acme", "?state=active,gone", "?pendingTerms=maybe", `?q=${"x".repeat(201)}`]) {
      expect((await list(query)).status).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("answers the guard's refusal and reads nothing", async () => {
    mocks.guard.mockResolvedValue({ context: null, error: NextResponse.json({ error: "no" }, { status: 403 }) });
    expect((await list()).status).toBe(403);
    expect((await command(LOCK)).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });
});

describe("the operator's commands on one product", () => {
  it("takes the id as one percent-encoded path segment, as Next decodes it", () => {
    // `@`, `/` and `:` are in every id; `/` encoded stays inside the segment the route names.
    for (const name of ["release", "lock", "unlock"]) {
      const match = getRouteMatcher(getRouteRegex(`/api/site/products/[id]/${name}`));
      expect(match(`/api/site/products/${encodeURIComponent(ID)}/${name}`)).toEqual({ id: ID });
      expect(match(`/api/site/products/@acme/licences:pro.yearly/${name}`)).toBe(false);
    }
  });

  it("releases the pending terms and says so, with the product as it now stands", async () => {
    mocks.release.mockResolvedValue({ outcome: "applied", product: stored() });
    mocks.read.mockResolvedValue(stored({ pendingTerms: null, free: true, version: 5 }));
    const response = await command(RELEASE, ID, "release");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.outcome).toBe("applied");
    expect(body.product).toMatchObject({ id: ID, pendingTerms: null, free: true, version: 5 });
    expect(mocks.release).toHaveBeenCalledWith({}, { siteId: 31, productId: ID, listeners: ["@acme/seller"] });
    expect(mocks.schedule).toHaveBeenCalledWith(31);
    expect(mocks.log).toHaveBeenCalledWith("info", "site.products.release", expect.objectContaining({
      siteKey: "skeleton", userId: 7, targetType: "product", targetId: ID, meta: { outcome: "applied" },
    }));
  });

  it("refuses the release of the Site's own product as a conflict, and a product it does not have as missing", async () => {
    mocks.release.mockRejectedValueOnce(new PhisProductRuleError(`${ID} is the Site's own product and needs no release.`));
    const refused = await command(RELEASE, ID, "release");
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: `${ID} is the Site's own product and needs no release.` });
    mocks.release.mockResolvedValueOnce(null);
    expect((await command(RELEASE, ID, "release")).status).toBe(404);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("locks and unlocks through the operator's move, and answers unchanged where there was nothing to move", async () => {
    mocks.move.mockResolvedValueOnce([{ id: ID, from: "active", to: "locked" }]);
    mocks.read.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ state: "locked" }));
    const locked = await command(LOCK);
    await expect(locked.json()).resolves.toMatchObject({ outcome: "locked", product: { state: "locked" } });
    expect(mocks.move).toHaveBeenLastCalledWith({}, {
      siteId: 31, to: "locked", productId: ID, listeners: ["@acme/seller"],
    });

    mocks.move.mockResolvedValueOnce([]);
    const again = await command(LOCK);
    await expect(again.json()).resolves.toMatchObject({ outcome: "unchanged" });
    expect(mocks.schedule).toHaveBeenCalledTimes(1);

    mocks.move.mockResolvedValueOnce([{ id: ID, from: "locked", to: "withdrawn" }]);
    const unlocked = await command(UNLOCK, ID, "unlock");
    await expect(unlocked.json()).resolves.toMatchObject({ outcome: "unlocked" });
    expect(mocks.move).toHaveBeenLastCalledWith({}, {
      siteId: 31, to: "unlocked", productId: ID, listeners: ["@acme/seller"],
    });
  });

  it("refuses an id that is not a product id, and a product the Site does not have", async () => {
    expect((await command(LOCK, "acme:pro")).status).toBe(400);
    mocks.read.mockResolvedValueOnce(null);
    expect((await command(UNLOCK, ID, "unlock")).status).toBe(404);
    expect(mocks.move).not.toHaveBeenCalled();
  });
});
