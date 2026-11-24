/**
 * Products a Site package proposes: what the CLI and Core say to each other about them
 * (SERVER_ADDONS.md, `products:v1`, "Products a Site package proposes"; DB.md `site_module_products`).
 *
 * Pure, and importable by both sides, as `module-media.ts` is: the CLI reads `phis.products` out of a
 * package's `package.json` (`readPhisSitePackageProductProposals`, `@phis/contracts/products`) and posts
 * one proposal at a time; Core makes the product through `@phis/products`' `product.add` once and
 * records that it did. Nothing here touches a file, the database or the network.
 */

/**
 * The bits of `site_module_products.flags`.
 *
 * `Found`: the Site had a product under the derived key already when the proposal was first taken, so
 * Core made nothing and left that product as it was.
 */
export const PhisSiteModuleProductFlag = {
  Found: 1 << 0,
} as const;

/**
 * What one proposal came to.
 *
 * - `created`: `@phis/products` made the product now.
 * - `found`: the Site had a product under the key already; it is recorded as taken and left alone.
 * - `taken`: recorded before; nothing is asked or changed, whatever became of the product since.
 * - `waiting`: not taken yet, and nothing is wrong with it -- `@phis/products` is not on for the Site, or
 *   a picture the proposal names has not been imported (`phis module media sync`). The next sync asks again.
 * - `refused`: `@phis/products` said no (a person without its `editor` role, Core's refusal); not recorded,
 *   so the next sync asks again.
 */
export type PhisModuleProductStatus = "created" | "found" | "taken" | "waiting" | "refused";

export type PhisModuleProductOutcome = {
  packageName: string;
  key: string;
  status: PhisModuleProductStatus;
  /** The product's key under `@phis/products`; the product is `@phis/products:<productKey>`. */
  productKey: string;
  /** For `waiting` and `refused`: a word to sort by. */
  reason?: string;
  /** A sentence for the operator. */
  detail?: string;
};

/** One recorded proposal, as `GET /api/v1/module-products` answers it. */
export type PhisModuleProductRow = {
  packageName: string;
  key: string;
  productKey: string;
  /** `PhisSiteModuleProductFlag`. */
  flags: number;
  createdAt: string;
};

export type PhisModuleProductMapping = {
  rows: PhisModuleProductRow[];
};
